import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { getPool, closePool } from "../src/db/pool.js";
import { placeRequest } from "../src/scheduler/place-request.js";
import { affinityKeyFor, sweepAffinities, lookupAffinity } from "../src/scheduler/affinity.js";
import type { ChatMessage } from "../src/types.js";

/**
 * Prefix-cache affinity.
 *
 * Model servers reuse the KV cache of a shared prompt prefix, so sending a
 * later turn of a conversation to a different replica throws that cache away
 * and reprocesses the whole prompt. These tests cover the two things that make
 * the feature safe: it must actually route a conversation back, and it must
 * never override load balancing or pin work to a saturated replica.
 */
const MODEL = "aff-model-" + randomUUID().slice(0, 8);
const caller = { oid: "caller-1" };

async function insertModel() {
  await getPool().query(
    `INSERT INTO model_registry (id, name, class_label, model_class, capabilities, min_replicas, max_replicas, system_prompt, cost_value, cost_basis, endpoint_url)
     VALUES ($1,$1,'Test','fast',ARRAY['chat'],1,4,'',0.001,'per_1k_tokens','http://x') ON CONFLICT (id) DO NOTHING`,
    [MODEL]
  );
}

async function insertReplica(id: string, maxConcurrency = 2, inFlight = 0) {
  await getPool().query(
    `INSERT INTO replicas (id, model_id, status, in_flight, load_pct, endpoint_url, max_concurrency)
     VALUES ($1,$2,'ready',$3,0,'http://x',$4)
     ON CONFLICT (id) DO UPDATE SET in_flight = EXCLUDED.in_flight, max_concurrency = EXCLUDED.max_concurrency, status='ready'`,
    [id, MODEL, inFlight, maxConcurrency]
  );
}

async function reset() {
  const pool = getPool();
  await pool.query(`DELETE FROM replica_affinity WHERE model_id = $1`, [MODEL]);
  await pool.query(`DELETE FROM replicas WHERE model_id = $1`, [MODEL]);
  await pool.query(`DELETE FROM model_registry WHERE id = $1`, [MODEL]);
}

const turn = (n: number): ChatMessage[] => [
  { role: "system", content: "You are helpful." },
  { role: "user", content: "Tell me about the sea." },
  ...Array.from({ length: n }, (_, i) => ({ role: "assistant" as const, content: `reply ${i}` })),
];

describe("prefix-cache affinity", () => {
  beforeEach(async () => {
    await reset();
    await insertModel();
  });

  afterAll(async () => {
    await reset();
    await closePool();
  });

  describe("the key", () => {
    it("stays the same as a conversation grows", () => {
      // The cached prefix is the opening of the conversation, so the key has to
      // be derived from that and nothing else — hashing every message would
      // produce a new key each turn and never match.
      const first = affinityKeyFor(caller, MODEL, turn(0));
      expect(affinityKeyFor(caller, MODEL, turn(4))).toBe(first);
      expect(affinityKeyFor(caller, MODEL, turn(40))).toBe(first);
    });

    it("differs between conversations and between callers", () => {
      const a = affinityKeyFor(caller, MODEL, turn(0));
      const other = affinityKeyFor(caller, MODEL, [{ role: "user", content: "something else" }]);
      const otherCaller = affinityKeyFor({ oid: "caller-2" }, MODEL, turn(0));

      expect(other).not.toBe(a);
      // Two people opening with the same words must not collide onto one replica.
      expect(otherCaller).not.toBe(a);
    });

    it("carries no prompt text", () => {
      const key = affinityKeyFor(caller, MODEL, turn(0))!;
      expect(key).toMatch(/^[0-9a-f]{40}$/);
      expect(key).not.toContain("sea");
    });
  });

  describe("placement", () => {
    it("sends a later turn back to the replica holding the cache", async () => {
      await insertReplica("aff-a");
      await insertReplica("aff-b");
      const key = affinityKeyFor(caller, MODEL, turn(0))!;

      const first = await placeRequest(MODEL, { affinityKey: key });
      expect(first.ok && first.affinityHit).toBe(false);
      const landed = first.ok ? first.replica.id : "";

      // Free the slot as the first turn would on completion.
      await getPool().query(`UPDATE replicas SET in_flight = 0 WHERE model_id = $1`, [MODEL]);

      const second = await placeRequest(MODEL, { affinityKey: affinityKeyFor(caller, MODEL, turn(6))! });
      expect(second.ok && second.replica.id).toBe(landed);
      expect(second.ok && second.affinityHit).toBe(true);
    });

    it("falls back when the affine replica is saturated", async () => {
      // Affinity must never queue a request behind its preferred replica; a
      // cold cache is cheaper than waiting.
      await insertReplica("aff-a", 1);
      await insertReplica("aff-b", 1);
      const key = affinityKeyFor(caller, MODEL, turn(0))!;

      const first = await placeRequest(MODEL, { affinityKey: key });
      const landed = first.ok ? first.replica.id : "";

      // Leave the affine replica at its ceiling.
      const second = await placeRequest(MODEL, { affinityKey: key });
      expect(second.ok).toBe(true);
      if (second.ok) {
        expect(second.replica.id).not.toBe(landed);
        expect(second.affinityHit).toBe(false);
      }
    });

    it("falls back when the affine replica has gone away", async () => {
      await insertReplica("aff-a");
      const key = affinityKeyFor(caller, MODEL, turn(0))!;
      await placeRequest(MODEL, { affinityKey: key });

      // The replica is scaled down and a different one takes its place.
      await getPool().query(`DELETE FROM replicas WHERE id = 'aff-a'`);
      await insertReplica("aff-c");

      const next = await placeRequest(MODEL, { affinityKey: key });
      expect(next.ok && next.replica.id).toBe("aff-c");
      expect(next.ok && next.affinityHit).toBe(false);
    });

    it("does not starve other replicas when many conversations arrive", async () => {
      // Each conversation has its own key, so affinity must not funnel
      // unrelated work onto one replica.
      await insertReplica("aff-a", 4);
      await insertReplica("aff-b", 4);
      await insertReplica("aff-c", 4);

      for (let i = 0; i < 9; i++) {
        const key = affinityKeyFor(caller, MODEL, [{ role: "user", content: `conversation ${i}` }])!;
        await placeRequest(MODEL, { affinityKey: key });
      }

      const { rows } = await getPool().query<{ in_flight: number }>(
        `SELECT in_flight FROM replicas WHERE model_id = $1`,
        [MODEL]
      );
      const counts = rows.map((r) => Number(r.in_flight));
      expect(counts.reduce((a, b) => a + b, 0)).toBe(9);
      // Spread, not piled onto whichever replica was first.
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    });
  });

  describe("housekeeping", () => {
    it("drops affinities pointing at a replica that no longer exists", async () => {
      await insertReplica("aff-a");
      const key = affinityKeyFor(caller, MODEL, turn(0))!;
      await placeRequest(MODEL, { affinityKey: key });
      expect(await lookupAffinity(key, MODEL)).toBe("aff-a");

      await getPool().query(`DELETE FROM replicas WHERE id = 'aff-a'`);
      await sweepAffinities();

      expect(await lookupAffinity(key, MODEL)).toBeNull();
    });

    it("expires an affinity that has gone unused", async () => {
      await insertReplica("aff-a");
      const key = affinityKeyFor(caller, MODEL, turn(0))!;
      await placeRequest(MODEL, { affinityKey: key });

      // A conversation abandoned long ago has no cache left to return to.
      await sweepAffinities(0);
      expect(await lookupAffinity(key, MODEL)).toBeNull();
    });
  });
});
