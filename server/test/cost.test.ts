import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { getPool, closePool } from "../src/db/pool.js";
import {
  computeCost,
  getCostConfigForModel,
  setCostConfigForModel,
  getCostBreakdown,
} from "../src/cost/index.js";

describe("computeCost", () => {
  it("computes per_1k_tokens cost", () => {
    const cost = computeCost({
      costBasis: "per_1k_tokens",
      costValue: 0.004,
      inputTokens: 1500,
      outputTokens: 500,
      durationMs: 12345,
    });
    // (1500 + 500) / 1000 * 0.004 = 0.008
    expect(cost).toBeCloseTo(0.008, 10);
  });

  it("computes per_request cost flat regardless of tokens/duration", () => {
    const cost = computeCost({
      costBasis: "per_request",
      costValue: 0.05,
      inputTokens: 999999,
      outputTokens: 0,
      durationMs: 0,
    });
    expect(cost).toBe(0.05);

    const cost2 = computeCost({
      costBasis: "per_request",
      costValue: 0.05,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 999999,
    });
    expect(cost2).toBe(0.05);
  });

  it("computes per_compute_second cost", () => {
    const cost = computeCost({
      costBasis: "per_compute_second",
      costValue: 0.0003,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 4000,
    });
    // 4000ms / 1000 * 0.0003 = 0.0012
    expect(cost).toBeCloseTo(0.0012, 10);
  });

  it("handles zero tokens/duration", () => {
    expect(
      computeCost({ costBasis: "per_1k_tokens", costValue: 1, inputTokens: 0, outputTokens: 0, durationMs: 0 })
    ).toBe(0);
    expect(
      computeCost({ costBasis: "per_compute_second", costValue: 1, inputTokens: 0, outputTokens: 0, durationMs: 0 })
    ).toBe(0);
  });
});

describe("cost config persistence", () => {
  const testModelId = `test-cost-model-${randomUUID()}`;

  beforeEach(async () => {
    const pool = getPool();
    // model_cost_config.model_id has an FK to model_registry, so insert a throwaway model row.
    await pool.query(
      `INSERT INTO model_registry (id, name, class_label, model_class, capabilities, endpoint_url)
       VALUES ($1, 'Test Model', 'Test', 'fast', '{}', 'http://test')
       ON CONFLICT (id) DO NOTHING`,
      [testModelId]
    );
  });

  afterAll(async () => {
    const pool = getPool();
    await pool.query(`DELETE FROM model_registry WHERE id = $1`, [testModelId]);
  });

  it("returns null when no config is set for a model", async () => {
    const otherModelId = `test-cost-unconfigured-${randomUUID()}`;
    await getPool().query(
      `INSERT INTO model_registry (id, name, class_label, model_class, capabilities, endpoint_url)
       VALUES ($1, 'Unconfigured Model', 'Test', 'fast', '{}', 'http://test')
       ON CONFLICT (id) DO NOTHING`,
      [otherModelId]
    );
    const result = await getCostConfigForModel(otherModelId);
    expect(result).toBeNull();
    await getPool().query(`DELETE FROM model_registry WHERE id = $1`, [otherModelId]);
  });

  it("sets and reads back cost config for a model", async () => {
    await setCostConfigForModel(testModelId, 0.0077, "per_1k_tokens", "admin-1");
    const result = await getCostConfigForModel(testModelId);
    expect(result).not.toBeNull();
    expect(result!.costBasis).toBe("per_1k_tokens");
    expect(Number(result!.costValue)).toBeCloseTo(0.0077, 10);
  });

  it("upserts on repeated calls, overwriting previous config", async () => {
    await setCostConfigForModel(testModelId, 0.01, "per_request", "admin-1");
    await setCostConfigForModel(testModelId, 0.02, "per_compute_second", "admin-2");
    const result = await getCostConfigForModel(testModelId);
    expect(result!.costBasis).toBe("per_compute_second");
    expect(Number(result!.costValue)).toBeCloseTo(0.02, 10);
  });
});

describe("getCostBreakdown", () => {
  const suffix = randomUUID();
  const modelA = `test-breakdown-model-a-${suffix}`;
  const modelB = `test-breakdown-model-b-${suffix}`;
  const callerA = `test-breakdown-caller-a-${suffix}`;
  const callerB = `test-breakdown-caller-b-${suffix}`;
  const requestIds: string[] = [];

  beforeEach(async () => {
    const pool = getPool();
    await pool.query(`DELETE FROM requests WHERE id = ANY($1)`, [
      [`req-1-${suffix}`, `req-2-${suffix}`, `req-3-${suffix}`, `req-4-${suffix}`],
    ]);
    requestIds.length = 0;

    const rows = [
      {
        id: `req-1-${suffix}`,
        caller_oid: callerA,
        caller_name: "Caller A",
        routed_model: modelA,
        input_tokens: 1000,
        output_tokens: 500,
        cost_usd: 1.5,
        status: "completed",
      },
      {
        id: `req-2-${suffix}`,
        caller_oid: callerA,
        caller_name: "Caller A",
        routed_model: modelA,
        input_tokens: 2000,
        output_tokens: 1000,
        cost_usd: 3.0,
        status: "completed",
      },
      {
        id: `req-3-${suffix}`,
        caller_oid: callerB,
        caller_name: "Caller B",
        routed_model: modelB,
        input_tokens: 500,
        output_tokens: 500,
        cost_usd: 0.5,
        status: "completed",
      },
      {
        id: `req-4-${suffix}`,
        caller_oid: callerB,
        caller_name: "Caller B",
        routed_model: modelB,
        input_tokens: 5000,
        output_tokens: 5000,
        cost_usd: 99.0,
        status: "error", // should be excluded
      },
    ];

    for (const r of rows) {
      requestIds.push(r.id);
      await pool.query(
        `INSERT INTO requests (id, caller_oid, caller_name, team, requested_model, routed_model, capabilities, status, input_tokens, output_tokens, cost_usd, arrived_at, completed_at)
         VALUES ($1,$2,$3,'test-team',$4,$4,'{}',$5,$6,$7,$8, now() - interval '1 hour', now() - interval '30 minutes')`,
        [r.id, r.caller_oid, r.caller_name, r.routed_model, r.status, r.input_tokens, r.output_tokens, r.cost_usd]
      );
    }
  });

  afterAll(async () => {
    const pool = getPool();
    await pool.query(`DELETE FROM requests WHERE id = ANY($1)`, [requestIds]);
  });

  it("aggregates cost/tokens/requests grouped by model, excluding non-completed rows", async () => {
    const since = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const until = new Date(Date.now() + 60 * 1000);
    const breakdown = await getCostBreakdown({ since, until, groupBy: "model" });

    const forA = breakdown.find((b) => b.key === modelA);
    const forB = breakdown.find((b) => b.key === modelB);

    expect(forA).toBeDefined();
    expect(forA!.requests).toBe(2);
    expect(forA!.tokens).toBe(1000 + 500 + 2000 + 1000);
    expect(Number(forA!.cost)).toBeCloseTo(4.5, 10);

    expect(forB).toBeDefined();
    expect(forB!.requests).toBe(1); // the error row must be excluded
    expect(forB!.tokens).toBe(500 + 500);
    expect(Number(forB!.cost)).toBeCloseTo(0.5, 10);
  });

  it("aggregates cost/tokens/requests grouped by caller", async () => {
    const since = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const until = new Date(Date.now() + 60 * 1000);
    const breakdown = await getCostBreakdown({ since, until, groupBy: "caller" });

    const forCallerA = breakdown.find((b) => b.key === callerA);
    expect(forCallerA).toBeDefined();
    expect(forCallerA!.requests).toBe(2);
    expect(Number(forCallerA!.cost)).toBeCloseTo(4.5, 10);
  });
});

afterAll(async () => {
  await closePool();
});
