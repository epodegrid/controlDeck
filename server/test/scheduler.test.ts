import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { getPool, closePool } from "../src/db/pool.js";
import { placeRequest } from "../src/scheduler/place-request.js";
import type { PlaceRequestResult } from "../src/scheduler/place-request.js";
import {
  enqueueRequest,
  sweepQueueTimeouts,
  expireQueuedRequest,
  markStreamStarted,
  recordTokenEmitted,
  sweepStallTimeouts,
  completeRequest,
} from "../src/scheduler/queue.js";
import { FakeKedaClient, MetricsKedaClient } from "../src/adapters/keda.js";
import { getKedaMetricForModel } from "../src/metrics/index.js";

const MODEL_ID = "test-model-" + randomUUID().slice(0, 8);

async function insertModel(id: string) {
  const pool = getPool();
  await pool.query(
    `INSERT INTO model_registry (id, name, class_label, model_class, capabilities, min_replicas, max_replicas, system_prompt, cost_value, cost_basis, endpoint_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (id) DO NOTHING`,
    [id, id, "Test", "fast", ["chat"], 1, 4, "", 0.001, "per_1k_tokens", "http://example.test"]
  );
}

async function insertReplica(
  id: string,
  modelId: string,
  status: string,
  inFlight = 0,
  loadPct = 0,
  maxConcurrency = 1
) {
  const pool = getPool();
  // ON CONFLICT DO UPDATE makes this idempotent in case a stale row with the
  // same short id survives from an earlier interrupted run — resets it to
  // this test's fixture state instead of erroring on the pkey.
  await pool.query(
    `INSERT INTO replicas (id, model_id, status, in_flight, load_pct, tokens_per_sec, max_concurrency)
     VALUES ($1,$2,$3,$4,$5,NULL,$6)
     ON CONFLICT (id) DO UPDATE SET
       model_id = EXCLUDED.model_id,
       status = EXCLUDED.status,
       in_flight = EXCLUDED.in_flight,
       load_pct = EXCLUDED.load_pct,
       tokens_per_sec = EXCLUDED.tokens_per_sec,
       max_concurrency = EXCLUDED.max_concurrency`,
    [id, modelId, status, inFlight, loadPct, maxConcurrency]
  );
}

async function insertRequestRow(id: string, overrides: Partial<{
  status: string;
  arrivedAt: string;
  startedAt: string | null;
  lastTokenAt: string | null;
  replicaId: string | null;
}> = {}) {
  const pool = getPool();
  const {
    status = "queued",
    arrivedAt = "now()",
    startedAt = null,
    lastTokenAt = null,
    replicaId = null,
  } = overrides;
  const startedAtSql = startedAt === null ? "NULL" : startedAt;
  const lastTokenAtSql = lastTokenAt === null ? "NULL" : lastTokenAt;
  await pool.query(
    `INSERT INTO requests (id, caller_oid, caller_name, requested_model, routed_model, capabilities, status, replica_id, arrived_at, started_at, last_token_at)
     VALUES ($1, 'oid-1', 'Test Caller', $2, $2, '{}', $3, $4, ${arrivedAt}, ${startedAtSql}, ${lastTokenAtSql})`,
    [id, MODEL_ID, status, replicaId]
  );
}

// Scoped cleanup only — other test files share this same Postgres database
// and run concurrently, so a blanket TRUNCATE of shared tables (requests,
// replicas, model_registry) would wipe their fixtures out from under them
// and can deadlock against their own in-flight transactions. MODEL_ID is
// unique per test run, so scoping every delete to it keeps this file's
// state isolated without touching anyone else's rows (same convention as
// test/cost.test.ts and test/audit.test.ts).
async function resetTestState() {
  const pool = getPool();
  await pool.query("DELETE FROM requests WHERE requested_model = $1", [MODEL_ID]);
  await pool.query("DELETE FROM replicas WHERE model_id = $1", [MODEL_ID]);
  await pool.query("DELETE FROM model_registry WHERE id = $1", [MODEL_ID]);
}

describe("scheduler", () => {
  beforeEach(async () => {
    await resetTestState();
    await insertModel(MODEL_ID);
  });

  afterAll(async () => {
    await resetTestState();
    await closePool();
  });

  describe("placeRequest — least-loaded placement", () => {
    it("returns needsQueue when no ready replicas exist", async () => {
      await insertReplica("r-busy", MODEL_ID, "busy", 1, 50);
      await insertReplica("r-loading", MODEL_ID, "loading", 0, 0);

      const result = await placeRequest(MODEL_ID);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.needsQueue).toBe(true);
      }
    });

    it("picks the replica with lowest in_flight", async () => {
      await insertReplica("r-1", MODEL_ID, "ready", 2, 10);
      await insertReplica("r-2", MODEL_ID, "ready", 0, 90);
      await insertReplica("r-3", MODEL_ID, "ready", 1, 5);

      const result = await placeRequest(MODEL_ID);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.replica.id).toBe("r-2");
        expect(result.replica.inFlight).toBe(1);
      }
    });

    it("tie-breaks by load_pct when in_flight is equal", async () => {
      await insertReplica("r-1", MODEL_ID, "ready", 0, 80);
      await insertReplica("r-2", MODEL_ID, "ready", 0, 10);

      const result = await placeRequest(MODEL_ID);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.replica.id).toBe("r-2");
      }
    });

    it("increments in_flight atomically on placement", async () => {
      await insertReplica("r-1", MODEL_ID, "ready", 0, 0);

      const result = await placeRequest(MODEL_ID);
      expect(result.ok).toBe(true);

      const pool = getPool();
      const { rows } = await pool.query("SELECT in_flight, status FROM replicas WHERE id = 'r-1'");
      expect(rows[0].in_flight).toBe(1);
      // Status stays 'ready' — placement doesn't saturate the replica out of
      // eligibility, it just increments its load counter.
      expect(rows[0].status).toBe("ready");
    });

    it("returns needsQueue when every ready replica is at its concurrency ceiling", async () => {
      // Both replicas are 'ready' but full. Before per-replica ceilings existed
      // this returned a placement anyway, so the queue — and with it the
      // queue-wait timeout of §6.5 — was unreachable.
      await insertReplica("r-full-1", MODEL_ID, "ready", 1, 50, 1);
      await insertReplica("r-full-2", MODEL_ID, "ready", 2, 50, 2);

      const result = await placeRequest(MODEL_ID);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.needsQueue).toBe(true);
    });

    it("places onto a replica with spare capacity and skips saturated ones", async () => {
      await insertReplica("r-sat", MODEL_ID, "ready", 4, 5, 4); // full
      await insertReplica("r-spare", MODEL_ID, "ready", 3, 90, 8); // room left

      const result = await placeRequest(MODEL_ID);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Chosen despite the higher in_flight and load_pct: the saturated
        // replica isn't a candidate at all.
        expect(result.replica.id).toBe("r-spare");
        expect(result.replica.inFlight).toBe(4);
      }
    });

    it("prefers the faster replica when load is equal", async () => {
      // §6.4 keeps least-loaded as the primary key; throughput only breaks
      // ties. Both are idle here, so the measured-faster one should win.
      await insertReplica("t-slow", MODEL_ID, "ready", 0, 0, 4);
      await insertReplica("t-fast", MODEL_ID, "ready", 0, 0, 4);
      const pool = getPool();
      await pool.query("UPDATE replicas SET tokens_per_sec = 12, tokens_per_sec_at = now() WHERE id = 't-slow'");
      await pool.query("UPDATE replicas SET tokens_per_sec = 48, tokens_per_sec_at = now() WHERE id = 't-fast'");

      const result = await placeRequest(MODEL_ID);
      expect(result.ok && result.replica.id).toBe("t-fast");
    });

    it("never lets throughput override load balancing", async () => {
      // The fast replica is already busy. Sending yet more work to it because
      // it is fast would defeat least-loaded placement entirely.
      await insertReplica("t-fast-busy", MODEL_ID, "ready", 2, 0, 4);
      await insertReplica("t-slow-idle", MODEL_ID, "ready", 0, 0, 4);
      const pool = getPool();
      await pool.query("UPDATE replicas SET tokens_per_sec = 90, tokens_per_sec_at = now() WHERE id = 't-fast-busy'");
      await pool.query("UPDATE replicas SET tokens_per_sec = 10, tokens_per_sec_at = now() WHERE id = 't-slow-idle'");

      const result = await placeRequest(MODEL_ID);
      expect(result.ok && result.replica.id).toBe("t-slow-idle");
    });

    it("tries an unmeasured replica ahead of a measured one", async () => {
      // A freshly scaled replica has no throughput figure yet. Ranking it last
      // would starve it of the traffic it needs to earn one.
      await insertReplica("t-known", MODEL_ID, "ready", 0, 0, 4);
      await insertReplica("t-new", MODEL_ID, "ready", 0, 0, 4);
      await getPool().query(
        "UPDATE replicas SET tokens_per_sec = 99, tokens_per_sec_at = now() WHERE id = 't-known'"
      );

      const result = await placeRequest(MODEL_ID);
      expect(result.ok && result.replica.id).toBe("t-new");
    });

    it("re-explores a replica whose throughput reading has gone stale", async () => {
      // The starvation case, found by testing rather than reasoning: a replica
      // throttled and then restored received zero traffic afterwards, because
      // its stale slow score kept it ranked last and it never got a request
      // with which to record a better one. A measurement older than the
      // freshness window must count as unknown, and unknown is tried first.
      await insertReplica("s-fast", MODEL_ID, "ready", 0, 0, 4);
      await insertReplica("s-stale", MODEL_ID, "ready", 0, 0, 4);
      const pool = getPool();
      await pool.query(
        "UPDATE replicas SET tokens_per_sec = 90, tokens_per_sec_at = now() WHERE id = 's-fast'"
      );
      await pool.query(
        "UPDATE replicas SET tokens_per_sec = 5, tokens_per_sec_at = now() - interval '1 hour' WHERE id = 's-stale'"
      );

      const result = await placeRequest(MODEL_ID);
      expect(result.ok && result.replica.id).toBe("s-stale");
    });

    it("still trusts a recent slow measurement", async () => {
      // The flip side: expiry must not make the preference meaningless. A
      // freshly-measured slow replica should still lose to a fast one.
      await insertReplica("s-fast-2", MODEL_ID, "ready", 0, 0, 4);
      await insertReplica("s-slow-2", MODEL_ID, "ready", 0, 0, 4);
      const pool = getPool();
      await pool.query(
        "UPDATE replicas SET tokens_per_sec = 90, tokens_per_sec_at = now() WHERE id = 's-fast-2'"
      );
      await pool.query(
        "UPDATE replicas SET tokens_per_sec = 5, tokens_per_sec_at = now() WHERE id = 's-slow-2'"
      );

      const result = await placeRequest(MODEL_ID);
      expect(result.ok && result.replica.id).toBe("s-fast-2");
    });

    it("distributes many concurrent placements across replicas without over-loading any single one", async () => {
      const replicaIds = ["c-1", "c-2", "c-3", "c-4"];
      for (const id of replicaIds) {
        // Ceiling of 10 each: 40 placements exactly fill the fleet, so this
        // still measures distribution rather than the ceiling behaviour above.
        await insertReplica(id, MODEL_ID, "ready", 0, 0, 10);
      }

      // With more concurrent callers than ready replicas, FOR UPDATE SKIP
      // LOCKED means a caller can momentarily see zero unlocked candidates
      // (needsQueue) even though a slot frees up microseconds later, once a
      // competing transaction's single-statement UPDATE commits. That's the
      // correct behavior for this pattern (never block/double-route), so the
      // test retries on needsQueue rather than treating it as a failure —
      // this simulates a caller that requeues and retries shortly after.
      async function placeWithRetry(): Promise<PlaceRequestResult> {
        for (let attempt = 0; attempt < 50; attempt++) {
          const result = await placeRequest(MODEL_ID);
          if (result.ok) return result;
          await new Promise((resolve) => setImmediate(resolve));
        }
        throw new Error("placeWithRetry: exhausted retries");
      }

      const N = 40;
      const results = await Promise.all(Array.from({ length: N }, () => placeWithRetry()));

      const placed = results.filter((r) => r.ok);
      expect(placed.length).toBe(N);

      const pool = getPool();
      const { rows } = await pool.query(
        "SELECT id, in_flight FROM replicas WHERE model_id = $1 ORDER BY id",
        [MODEL_ID]
      );

      const total = rows.reduce((sum: number, r: any) => sum + Number(r.in_flight), 0);
      expect(total).toBe(N);

      // Distributed: no single replica should have taken all placements when
      // there are 4 replicas and 40 placements (expect roughly even spread).
      for (const row of rows) {
        expect(Number(row.in_flight)).toBeLessThanOrEqual(N);
        expect(Number(row.in_flight)).toBeGreaterThan(0);
      }
      const counts = rows.map((r: any) => Number(r.in_flight));
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(2);
    });
  });

  describe("preemptive scaling (KEDA)", () => {
    it("calls requestScaleUp exactly once when the first request lands on a previously-idle replica", async () => {
      await insertReplica("k-1", MODEL_ID, "ready", 0, 0);
      await insertReplica("k-2", MODEL_ID, "ready", 0, 0);
      const keda = new FakeKedaClient();

      const first = await placeRequest(MODEL_ID, { kedaClient: keda });
      expect(first.ok).toBe(true);
      expect(keda.calls).toEqual([MODEL_ID]);

      // Second placement lands on the other idle replica (k-2), which is
      // itself going idle->busy for the first time, so this DOES scale up
      // again under our "per replica idle->busy transition" semantics.
      const second = await placeRequest(MODEL_ID, { kedaClient: keda });
      expect(second.ok).toBe(true);
      expect(keda.calls).toEqual([MODEL_ID, MODEL_ID]);
    });

    it("reports demand on the KEDA metric while a replica is free, so scaling is preemptive", async () => {
      // Two ready replicas, one placement. There is still spare capacity, so
      // the saturation signal alone would report nothing — but §6.4 wants a
      // warm spare requested the moment a replica takes its first request.
      await insertReplica("k-1", MODEL_ID, "ready", 0, 0);
      await insertReplica("k-2", MODEL_ID, "ready", 0, 0);

      const keda = new MetricsKedaClient();
      await placeRequest(MODEL_ID, { kedaClient: keda });

      expect(keda.wantsScaleUp(MODEL_ID)).toBe(true);
      expect(await getKedaMetricForModel(MODEL_ID, true)).toEqual({ in_flight_ratio: 1 });

      // Without the preemptive signal the same fleet reads as having headroom.
      expect(await getKedaMetricForModel(MODEL_ID, false)).toEqual({ in_flight_ratio: 0 });

      // A model nobody has touched must not ask for capacity.
      expect(keda.wantsScaleUp("some-other-model")).toBe(false);
    });

    it("reports saturation only when no replica has headroom left", async () => {
      // One replica serving, one idle. Summing in_flight across the fleet
      // would read as busy; what matters is that a free replica exists.
      await insertReplica("h-busy", MODEL_ID, "ready", 1, 100, 1);
      await insertReplica("h-free", MODEL_ID, "ready", 0, 0, 1);
      expect(await getKedaMetricForModel(MODEL_ID)).toEqual({ in_flight_ratio: 0 });

      // Now both are full — genuinely out of capacity.
      await insertReplica("h-free", MODEL_ID, "ready", 1, 100, 1);
      expect(await getKedaMetricForModel(MODEL_ID)).toEqual({ in_flight_ratio: 1 });
    });

    it("expires the preemptive signal so it does not pin a model at scale-up forever", async () => {
      const keda = new MetricsKedaClient();
      await keda.requestScaleUp(MODEL_ID);

      expect(keda.wantsScaleUp(MODEL_ID, 30_000)).toBe(true);
      // Same recorded signal, evaluated against a window it has fallen out of.
      expect(keda.wantsScaleUp(MODEL_ID, 0)).toBe(false);
    });

    it("does not call requestScaleUp again for a request landing on an already-busy replica", async () => {
      // Single ready replica: every subsequent placement call necessarily
      // lands back on it (least-loaded among one candidate), and after the
      // first call its in_flight is no longer 0, so no further scale-ups
      // should fire.
      await insertReplica("k-1", MODEL_ID, "ready", 0, 0);
      const keda = new FakeKedaClient();

      await placeRequest(MODEL_ID, { kedaClient: keda });
      expect(keda.calls.length).toBe(1);

      await placeRequest(MODEL_ID, { kedaClient: keda });
      expect(keda.calls.length).toBe(1);
    });
  });

  describe("queue", () => {
    it("enqueueRequest inserts a queued row", async () => {
      const id = randomUUID();
      await enqueueRequest({
        id,
        callerOid: "oid-1",
        callerName: "Test Caller",
        requestedModel: MODEL_ID,
        capabilities: ["chat"],
      });

      const pool = getPool();
      const { rows } = await pool.query("SELECT status FROM requests WHERE id = $1", [id]);
      expect(rows[0].status).toBe("queued");
    });

    it("sweepQueueTimeouts flips old queued requests to queue_timeout", async () => {
      const oldId = randomUUID();
      const freshId = randomUUID();
      await insertRequestRow(oldId, { status: "queued", arrivedAt: "now() - interval '10 minutes'" });
      await insertRequestRow(freshId, { status: "queued", arrivedAt: "now()" });

      const swept = await sweepQueueTimeouts(5000); // 5s threshold for test

      expect(swept).toContain(oldId);
      expect(swept).not.toContain(freshId);

      const pool = getPool();
      const { rows } = await pool.query(
        "SELECT id, status, error_code FROM requests WHERE id = ANY($1) ORDER BY id",
        [[oldId, freshId]]
      );
      const byId = Object.fromEntries(rows.map((r: any) => [r.id, r]));
      expect(byId[oldId].status).toBe("queue_timeout");
      expect(byId[oldId].error_code).toBe("queue_timeout");
      expect(byId[freshId].status).toBe("queued");
    });

    it("expireQueuedRequest times out only the named request, never other callers'", async () => {
      // The bug this guards: a caller whose own wait expired used to call the
      // whole-table sweep with a zero threshold, failing every other queued
      // request across every model along with its own.
      const mine = randomUUID();
      const someoneElse = randomUUID();
      await insertRequestRow(mine, { status: "queued" });
      await insertRequestRow(someoneElse, { status: "queued" });

      expect(await expireQueuedRequest(mine)).toBe(true);

      const pool = getPool();
      const { rows } = await pool.query(
        "SELECT id, status, error_code FROM requests WHERE id = ANY($1)",
        [[mine, someoneElse]]
      );
      const byId = Object.fromEntries(rows.map((r: any) => [r.id, r]));
      expect(byId[mine].status).toBe("queue_timeout");
      expect(byId[mine].error_code).toBe("queue_timeout");
      expect(byId[someoneElse].status).toBe("queued");
    });

    it("expireQueuedRequest leaves a request that got placed in the meantime alone", async () => {
      const id = randomUUID();
      await insertRequestRow(id, { status: "streaming", replicaId: null });

      // Lost the race: placement won, so there is nothing to time out.
      expect(await expireQueuedRequest(id)).toBe(false);

      const { rows } = await getPool().query("SELECT status FROM requests WHERE id = $1", [id]);
      expect(rows[0].status).toBe("streaming");
    });

    it("records observed throughput on the replica when a request completes", async () => {
      await insertReplica("tps-1", MODEL_ID, "ready", 1, 0, 4);
      const id = randomUUID();
      // 100 tokens over ~1s of generation.
      await insertRequestRow(id, {
        status: "streaming",
        replicaId: "tps-1",
        startedAt: "now() - interval '1 second'",
      });

      await completeRequest(id, { outputTokens: 100, costUsd: 0.01 });

      const { rows } = await getPool().query(
        "SELECT tokens_per_sec, tokens_per_sec_at FROM replicas WHERE id = 'tps-1'"
      );
      expect(rows[0].tokens_per_sec_at).not.toBeNull();
      // First sample seeds the average directly, so ~100 tok/s.
      expect(Number(rows[0].tokens_per_sec)).toBeGreaterThan(60);
      expect(Number(rows[0].tokens_per_sec)).toBeLessThan(140);
    });

    it("moves the average toward a new sample without jumping to it", async () => {
      await insertReplica("tps-2", MODEL_ID, "ready", 1, 0, 4);
      await getPool().query(
        "UPDATE replicas SET tokens_per_sec = 10, tokens_per_sec_at = now() WHERE id = 'tps-2'"
      );

      const id = randomUUID();
      await insertRequestRow(id, {
        status: "streaming",
        replicaId: "tps-2",
        startedAt: "now() - interval '1 second'",
      });
      await completeRequest(id, { outputTokens: 100, costUsd: 0.01 });

      const { rows } = await getPool().query("SELECT tokens_per_sec FROM replicas WHERE id = 'tps-2'");
      const tps = Number(rows[0].tokens_per_sec);
      // Weighted, not replaced: above the old 10, well below the new ~100.
      expect(tps).toBeGreaterThan(10);
      expect(tps).toBeLessThan(60);
    });

    it("ignores samples too small to mean anything", async () => {
      // A request that emitted two tokens in a few milliseconds implies an
      // absurd tokens/sec; letting it in would wreck the average.
      await insertReplica("tps-3", MODEL_ID, "ready", 1, 0, 4);
      await getPool().query(
        "UPDATE replicas SET tokens_per_sec = 40, tokens_per_sec_at = now() WHERE id = 'tps-3'"
      );

      const id = randomUUID();
      await insertRequestRow(id, { status: "streaming", replicaId: "tps-3", startedAt: "now()" });
      await completeRequest(id, { outputTokens: 2, costUsd: 0.01 });

      const { rows } = await getPool().query("SELECT tokens_per_sec FROM replicas WHERE id = 'tps-3'");
      expect(Number(rows[0].tokens_per_sec)).toBe(40);
    });

    it("markStreamStarted sets streaming status and timestamps", async () => {
      const id = randomUUID();
      await insertRequestRow(id, { status: "queued" });
      await markStreamStarted(id, "some-replica");

      const pool = getPool();
      const { rows } = await pool.query(
        "SELECT status, replica_id, started_at, last_token_at FROM requests WHERE id = $1",
        [id]
      );
      expect(rows[0].status).toBe("streaming");
      expect(rows[0].replica_id).toBe("some-replica");
      expect(rows[0].started_at).not.toBeNull();
      expect(rows[0].last_token_at).not.toBeNull();
    });

    it("recordTokenEmitted bumps last_token_at forward", async () => {
      const id = randomUUID();
      await insertRequestRow(id, { status: "streaming", lastTokenAt: "now() - interval '30 seconds'" });

      const pool = getPool();
      const before = (await pool.query("SELECT last_token_at FROM requests WHERE id = $1", [id])).rows[0]
        .last_token_at;

      await recordTokenEmitted(id);

      const after = (await pool.query("SELECT last_token_at FROM requests WHERE id = $1", [id])).rows[0]
        .last_token_at;
      expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
    });

    it("sweepStallTimeouts flips stalled streaming requests but leaves active ones alone", async () => {
      const stalledId = randomUUID();
      const activeId = randomUUID();
      await insertRequestRow(stalledId, {
        status: "streaming",
        startedAt: "now() - interval '2 minutes'",
        lastTokenAt: "now() - interval '2 minutes'",
      });
      await insertRequestRow(activeId, {
        status: "streaming",
        startedAt: "now() - interval '2 minutes'",
        lastTokenAt: "now()",
      });

      const swept = await sweepStallTimeouts(60000);

      expect(swept).toContain(stalledId);
      expect(swept).not.toContain(activeId);

      const pool = getPool();
      const { rows } = await pool.query(
        "SELECT id, status, error_code FROM requests WHERE id = ANY($1) ORDER BY id",
        [[stalledId, activeId]]
      );
      const byId = Object.fromEntries(rows.map((r: any) => [r.id, r]));
      expect(byId[stalledId].status).toBe("stall_timeout");
      expect(byId[stalledId].error_code).toBe("stall_timeout");
      expect(byId[activeId].status).toBe("streaming");
    });

    it("a long-running but progressing stream is never swept (no fixed wall-clock cap)", async () => {
      const longRunningId = randomUUID();
      await insertRequestRow(longRunningId, {
        status: "streaming",
        startedAt: "now() - interval '2 hours'",
        lastTokenAt: "now() - interval '1 second'",
      });

      const swept = await sweepStallTimeouts(60000);
      expect(swept).not.toContain(longRunningId);

      const pool = getPool();
      const { rows } = await pool.query("SELECT status FROM requests WHERE id = $1", [longRunningId]);
      expect(rows[0].status).toBe("streaming");
    });

    it("completeRequest marks the request completed, computes duration, and decrements replica in_flight", async () => {
      await insertReplica("r-complete", MODEL_ID, "busy", 1, 50);
      const id = randomUUID();
      await insertRequestRow(id, {
        status: "streaming",
        startedAt: "now() - interval '3 seconds'",
        lastTokenAt: "now()",
        replicaId: "r-complete",
      });

      await completeRequest(id, { outputTokens: 42, costUsd: 0.01 });

      const pool = getPool();
      const { rows } = await pool.query(
        "SELECT status, output_tokens, cost_usd, duration_ms, completed_at FROM requests WHERE id = $1",
        [id]
      );
      expect(rows[0].status).toBe("completed");
      expect(rows[0].output_tokens).toBe(42);
      expect(Number(rows[0].cost_usd)).toBeCloseTo(0.01, 5);
      expect(rows[0].duration_ms).toBeGreaterThan(0);
      expect(rows[0].completed_at).not.toBeNull();

      const replicaResult = await pool.query("SELECT in_flight FROM replicas WHERE id = 'r-complete'");
      expect(replicaResult.rows[0].in_flight).toBe(0);
    });
  });
});
