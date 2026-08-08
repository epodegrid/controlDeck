import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPool, closePool } from "../src/db/pool.js";
import { syncModelsFromConfig, readModelsConfig, syncModelsFromConfigFile } from "../src/registry/gitops.js";
import { listModels, setModelOverride } from "../src/registry/index.js";

/**
 * PRD §6.2 — Helm/GitOps is the primary model registration path.
 *
 * This was missing entirely: the chart deployed model workloads but nothing
 * wrote them into model_registry, so a production install had an empty
 * registry and rejected every request as capability_mismatch.
 */
const PREFIX = "gitops-" + randomUUID().slice(0, 8);
const model = (id: string, over: Record<string, unknown> = {}) => ({
  id: `${PREFIX}-${id}`,
  modelClass: "fast" as const,
  capabilities: ["chat" as const],
  ...over,
});

async function cleanup() {
  await getPool().query(`DELETE FROM model_registry WHERE id LIKE $1`, [`${PREFIX}%`]);
}

describe("GitOps model registration", () => {
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await closePool();
  });

  it("registers models declared in config", async () => {
    await syncModelsFromConfig([
      model("a", { name: "Model A", capabilities: ["chat", "tools"], costValue: 0.002 }),
      model("b", { modelClass: "embedding", capabilities: ["embeddings"] }),
    ]);

    const all = (await listModels()).filter((m) => m.id.startsWith(PREFIX));
    expect(all.map((m) => m.id).sort()).toEqual([`${PREFIX}-a`, `${PREFIX}-b`]);
    expect(all.find((m) => m.id === `${PREFIX}-a`)?.capabilities).toEqual(["chat", "tools"]);
  });

  it("carries the backend fields a real model container needs", async () => {
    await syncModelsFromConfig([
      model("swap", {
        // The platform id and the name the container answers to are different
        // things: llama-swap routes on the latter, and a fleet exposes variant
        // aliases the gateway has no reason to expose as separate models.
        upstreamModel: "eve:thinking-coding",
        port: 8000,
        firstTokenTimeoutMs: 1_800_000,
      }),
      model("plain"),
    ]);

    const all = await listModels();
    const swap = all.find((m) => m.id === `${PREFIX}-swap`)!;
    expect(swap.upstreamModel).toBe("eve:thinking-coding");
    expect(swap.port).toBe(8000);
    expect(swap.firstTokenTimeoutMs).toBe(1_800_000);

    // Defaults keep a plain declaration working unchanged.
    const plain = all.find((m) => m.id === `${PREFIX}-plain`)!;
    expect(plain.upstreamModel).toBe(`${PREFIX}-plain`);
    expect(plain.port).toBe(8080);
  });

  it("updates a model in place on redeploy", async () => {
    await syncModelsFromConfig([model("a", { name: "Before", maxReplicas: 2 })]);
    await syncModelsFromConfig([model("a", { name: "After", maxReplicas: 9 })]);

    const found = (await listModels()).find((m) => m.id === `${PREFIX}-a`);
    expect(found?.name).toBe("After");
    expect(found?.maxReplicas).toBe(9);
  });

  it("removes a model dropped from config, since Helm owns which models exist", async () => {
    await syncModelsFromConfig([model("a"), model("b")]);
    const result = await syncModelsFromConfig([model("a")]);

    expect(result.removed).toContain(`${PREFIX}-b`);
    const ids = (await listModels()).filter((m) => m.id.startsWith(PREFIX)).map((m) => m.id);
    expect(ids).toEqual([`${PREFIX}-a`]);
  });

  it("never clobbers a dashboard override on redeploy", async () => {
    // The §6.2 guarantee: Helm writes the base config, the dashboard's edits
    // live in a separate override layer, and a deploy cannot overwrite them.
    await syncModelsFromConfig([model("a", { systemPrompt: "from helm" })]);
    await setModelOverride(`${PREFIX}-a`, { systemPrompt: "edited in dashboard" }, "admin");

    await syncModelsFromConfig([model("a", { systemPrompt: "from helm, redeployed" })]);

    const found = (await listModels()).find((m) => m.id === `${PREFIX}-a`);
    expect(found?.systemPrompt).toBe("edited in dashboard");
    expect(found?.hasOverride).toBe(true);
  });

  it("rejects a model with no capabilities, which nothing could route to", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cd-cfg-"));
    const path = join(dir, "models.json");
    await writeFile(path, JSON.stringify({ models: [{ id: "x", modelClass: "fast", capabilities: [] }] }));
    await expect(readModelsConfig(path)).rejects.toThrow(/capabilities/);
  });

  it("treats a missing config as 'not deployed with one' rather than an error", async () => {
    expect(await syncModelsFromConfigFile("/nonexistent/models.json")).toBeNull();
  });
});
