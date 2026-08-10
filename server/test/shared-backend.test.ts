import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { getPool, closePool } from "../src/db/pool.js";
import { readModelsConfig } from "../src/registry/gitops.js";
import { listModels, listReplicasForModel } from "../src/registry/index.js";
import { getKedaMetricForModel } from "../src/metrics/index.js";
import {
  listUpstreamNames,
  checkUpstreamName,
  recordUpstreamCheck,
  getUpstreamCheck,
  clearUpstreamChecks,
} from "../src/registry/verify-upstream.js";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * One container image commonly answers to several names — llama-swap aliases
 * over a single set of loaded weights. Each deserves its own registry entry;
 * none of them may get its own copy of the model.
 */

const PREFIX = "shared-" + randomUUID().slice(0, 8);
const id = (suffix: string) => `${PREFIX}-${suffix}`;

/**
 * Inserts registry rows directly rather than through syncModelsFromConfig.
 *
 * That function deletes every model absent from the config it is given — Helm
 * owns which models exist — so calling it here would wipe the fixtures other
 * test files depend on. gitops.test.ts owns the write path and restores the
 * registry afterwards; this file only needs rows to exist.
 */
async function insertModel(
  modelId: string,
  opts: { backendRef?: string; upstreamModel?: string } = {}
) {
  await getPool().query(
    `INSERT INTO model_registry
       (id, name, class_label, model_class, capabilities, min_replicas, max_replicas,
        system_prompt, cost_value, cost_basis, endpoint_url, upstream_model, port, backend_model_id)
     VALUES ($1,$1,'Test','large','{chat}',1,4,'',0.001,'per_1k_tokens','http://test.invalid',$2,8080,$3)
     ON CONFLICT (id) DO UPDATE SET backend_model_id = EXCLUDED.backend_model_id`,
    [modelId, opts.upstreamModel ?? null, opts.backendRef ?? null]
  );
}

async function cleanup() {
  const pool = getPool();
  await pool.query(`DELETE FROM requests WHERE routed_model LIKE $1`, [`${PREFIX}%`]);
  await pool.query(`DELETE FROM replicas WHERE model_id LIKE $1`, [`${PREFIX}%`]);
  await pool.query(`DELETE FROM model_registry WHERE id LIKE $1`, [`${PREFIX}%`]);
}

describe("aliases sharing one backend", () => {
  beforeEach(async () => {
    await cleanup();
    clearUpstreamChecks();
  });
  afterAll(async () => {
    await cleanup();
    await closePool();
  });

  it("resolves an alias to the model that owns the workload", async () => {
    await insertModel(id("eve"));
    await insertModel(id("thinking"), {
      backendRef: id("eve"),
      upstreamModel: "eve:thinking-coding",
    });

    const models = await listModels();
    const alias = models.find((m) => m.id === id("thinking"))!;
    const owner = models.find((m) => m.id === id("eve"))!;

    expect(alias.backendModelId).toBe(id("eve"));
    // The name sent upstream stays the alias — that is the whole point of it.
    expect(alias.upstreamModel).toBe("eve:thinking-coding");
    // A model with no backendRef is its own backend.
    expect(owner.backendModelId).toBe(id("eve"));
  });

  it("shows an alias the replicas that actually serve it", async () => {
    await insertModel(id("eve"));
    await insertModel(id("thinking"), { backendRef: id("eve") });
    // Replicas are keyed by the backend: the pod is one pod whatever it is
    // called from outside.
    await getPool().query(
      `INSERT INTO replicas (id, model_id, status, in_flight, load_pct, endpoint_url, max_concurrency)
       VALUES ($1, $2, 'ready', 0, 0, 'http://pod-a:8080', 4)`,
      [id("pod-a"), id("eve")]
    );

    const viaAlias = await listReplicasForModel(id("thinking"));
    const viaOwner = await listReplicasForModel(id("eve"));

    // Reporting "no replicas" for a model that is running and serving traffic
    // would be a lie the operator has no way to see through.
    expect(viaAlias.map((r: any) => r.id)).toEqual([id("pod-a")]);
    expect(viaOwner.map((r: any) => r.id)).toEqual([id("pod-a")]);
  });

  it("reports a replica's resources, and says nothing rather than zero when unknown", async () => {
    await insertModel(id("eve"));
    const pool = getPool();
    // The shape the reconciler writes on a cluster with metrics-server.
    await pool.query(
      `INSERT INTO replicas (id, model_id, status, in_flight, load_pct, endpoint_url,
                             max_concurrency, cpu_millicores, memory_bytes, restart_count)
       VALUES ($1, $2, 'ready', 0, 0, 'http://pod:8080', 1, 250.5, 68719476736, 3)`,
      [id("pod-metrics"), id("eve")]
    );
    // And without one: null, not zero. A zero reads as an idle replica, which
    // is a different and wrong claim.
    await pool.query(
      `INSERT INTO replicas (id, model_id, status, in_flight, load_pct, endpoint_url,
                             max_concurrency, restart_count)
       VALUES ($1, $2, 'ready', 0, 0, 'http://pod2:8080', 1, 0)`,
      [id("pod-nometrics"), id("eve")]
    );

    const replicas = await listReplicasForModel(id("eve"));
    const withMetrics = replicas.find((r: any) => r.id === id("pod-metrics"))!;
    const without = replicas.find((r: any) => r.id === id("pod-nometrics"))!;

    expect(Number(withMetrics.cpuMillicores)).toBeCloseTo(250.5, 1);
    expect(Number(withMetrics.memoryBytes)).toBe(68719476736);
    // Restart count comes off the pod object, so it is always known in-cluster
    // — it never depended on the metrics API at all.
    expect(withMetrics.restartCount).toBe(3);

    expect(without.cpuMillicores).toBeNull();
    expect(without.memoryBytes).toBeNull();
    expect(without.restartCount).toBe(0);
  });

  it("scales on the combined demand of every name the backend serves", async () => {
    await insertModel(id("eve"));
    await insertModel(id("thinking"), { backendRef: id("eve") });

    const pool = getPool();
    const queue = async (routedModel: string) =>
      pool.query(
        `INSERT INTO requests (id, caller_oid, caller_name, requested_model, routed_model, capabilities, status, arrived_at)
         VALUES ($1,'oid','Caller',$2,$2,'{}','queued', now())`,
        [randomUUID(), routedModel]
      );

    await queue(id("eve"));
    await queue(id("thinking"));
    await queue(id("thinking"));

    const metric = await getKedaMetricForModel(id("eve"));

    // Counting only the owner's queue would under-provision the workload in
    // exact proportion to how much traffic arrived under the alias.
    expect(metric.queued).toBe(3);
    expect(metric.pending_requests).toBe(4); // 3 queued + the warm spare
  });

  it("rejects a backendRef that names no model in the config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cd-cfg-"));
    const path = join(dir, "models.json");
    await writeFile(
      path,
      JSON.stringify({
        models: [{ id: "a", modelClass: "fast", capabilities: ["chat"], backendRef: "typo" }],
      })
    );

    // Caught at load rather than at request time, where the only symptom would
    // be a model that is advertised and permanently has no replicas.
    await expect(readModelsConfig(path)).rejects.toThrow(/backendRef "typo"/);
  });

  it("rejects an alias of an alias", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cd-cfg-"));
    const path = join(dir, "models.json");
    await writeFile(
      path,
      JSON.stringify({
        models: [
          { id: "base", modelClass: "fast", capabilities: ["chat"] },
          { id: "mid", modelClass: "fast", capabilities: ["chat"], backendRef: "base" },
          { id: "leaf", modelClass: "fast", capabilities: ["chat"], backendRef: "mid" },
        ],
      })
    );

    await expect(readModelsConfig(path)).rejects.toThrow(/owns the workload/);
  });

  it("treats an empty backendRef as absent, since Helm cannot omit the key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cd-cfg-"));
    const path = join(dir, "models.json");
    await writeFile(
      path,
      JSON.stringify({
        models: [{ id: "a", modelClass: "fast", capabilities: ["chat"], backendRef: "" }],
      })
    );

    const parsed = await readModelsConfig(path);
    expect(parsed![0].backendRef).toBeUndefined();
  });
});

describe("upstream name verification", () => {
  let server: Server;
  let baseUrl: string;
  let payload: unknown;
  let status = 200;

  beforeEach(() => {
    clearUpstreamChecks();
    status = 200;
  });

  it("reads llama-swap's model ids and its aliases", async () => {
    server = createServer((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // The shape a real llama-swap returns — aliases live under meta, and are
    // just as valid in the `model` field as the id itself.
    payload = {
      data: [
        {
          id: "eve",
          meta: { llamaswap: { aliases: ["eve:thinking-coding", "Ornith-1.0-35B"] } },
        },
        { id: "wall-e" },
      ],
    };

    const names = await listUpstreamNames(baseUrl);
    expect(names).toEqual(["eve", "eve:thinking-coding", "Ornith-1.0-35B", "wall-e"]);

    const model = (upstreamModel: string) => ({ upstreamModel }) as any;
    expect(checkUpstreamName(model("eve:thinking-coding"), names).state).toBe("ok");

    const missing = checkUpstreamName(model("ornith"), names);
    expect(missing.state).toBe("missing");
    // The available names belong in the message: the whole difficulty is that
    // they live in the image's config, not in the values file.
    expect(missing.state === "missing" && missing.detail).toContain("eve:thinking-coding");

    await new Promise<void>((r) => server.close(() => r()));
  });

  it("reports a backend that lists nothing as unverifiable, not as wrong", async () => {
    // Plenty of OpenAI-compatible servers have no usable /v1/models. Calling
    // that a misconfiguration would cry wolf on a working deployment.
    const check = checkUpstreamName({ upstreamModel: "anything" } as any, null);
    expect(check.state).toBe("unknown");
  });

  it("remembers the latest check per model for the dashboard", () => {
    recordUpstreamCheck("m1", { state: "missing", detail: "nope", available: ["other"] });
    expect(getUpstreamCheck("m1")?.state).toBe("missing");

    recordUpstreamCheck("m1", { state: "ok" });
    expect(getUpstreamCheck("m1")?.state).toBe("ok");
    expect(getUpstreamCheck("never-checked")).toBeNull();
  });
});
