import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { getPool, closePool } from "../src/db/pool.js";
import {
  isContentLoggingEnabled,
  setLoggingScope,
  recordAuditContent,
  getAuditEntries,
  deleteAuditHistory,
} from "../src/audit/index.js";

describe("isContentLoggingEnabled", () => {
  const suffix = randomUUID();
  const team = `test-team-${suffix}`;
  const modelId = `test-model-${suffix}`;
  const apiKey = `test-key-${suffix}`;

  async function resetScopes() {
    const pool = getPool();
    await pool.query(
      `DELETE FROM audit_logging_config WHERE (scope_type = 'team' AND scope_key = $1)
        OR (scope_type = 'model' AND scope_key = $2)
        OR (scope_type = 'key' AND scope_key = $3)`,
      [team, modelId, apiKey]
    );
    await pool.query(
      `UPDATE audit_logging_config SET enabled = false WHERE scope_type = 'global' AND scope_key = ''`
    );
  }

  beforeEach(resetScopes);
  afterEach(resetScopes);

  it("keys the global scope by the empty string whatever the caller sends", async () => {
    // Two dashboard pages disagreed about this: one wrote ("global", ""), the
    // other ("global", "global"). Only the first is what isContentLoggingEnabled
    // reads, so the second was a switch that moved, persisted and did nothing,
    // and the pages showed different answers for one setting.
    await setLoggingScope("global", "global", true);

    const { rows: globals } = await getPool().query<{ scope_key: string; enabled: boolean }>(
      `SELECT scope_key, enabled FROM audit_logging_config WHERE scope_type = 'global'`
    );
    expect(globals).toHaveLength(1);
    expect(globals[0].scope_key).toBe("");
    expect(globals[0].enabled).toBe(true);

    // And it is the row that actually gates content logging.
    expect(await isContentLoggingEnabled({ team: "nobody", modelId: "nothing" })).toBe(true);

    await setLoggingScope("global", "", false);
  });

  it("returns false when all scopes are off", async () => {
    const result = await isContentLoggingEnabled({ team, modelId, apiKey });
    expect(result).toBe(false);
  });

  it("returns true when only global scope is on", async () => {
    await setLoggingScope("global", "", true);
    const result = await isContentLoggingEnabled({ team, modelId, apiKey });
    expect(result).toBe(true);
    await setLoggingScope("global", "", false);
  });

  it("returns true when only team scope is on", async () => {
    await setLoggingScope("team", team, true);
    const result = await isContentLoggingEnabled({ team, modelId, apiKey });
    expect(result).toBe(true);
  });

  it("returns true when only model scope is on", async () => {
    await setLoggingScope("model", modelId, true);
    const result = await isContentLoggingEnabled({ team, modelId, apiKey });
    expect(result).toBe(true);
  });

  it("returns true when only key scope is on (key-level override)", async () => {
    await setLoggingScope("key", apiKey, true);
    const result = await isContentLoggingEnabled({ team, modelId, apiKey });
    expect(result).toBe(true);
  });

  it("returns false when team/model/key are on for OTHER scope keys but not this request's", async () => {
    await setLoggingScope("team", `other-team-${suffix}`, true);
    const result = await isContentLoggingEnabled({ team, modelId, apiKey });
    expect(result).toBe(false);
  });

  it("handles missing team/apiKey gracefully, skipping those scope checks", async () => {
    await setLoggingScope("model", modelId, true);
    const result = await isContentLoggingEnabled({ modelId });
    expect(result).toBe(true);

    const result2 = await isContentLoggingEnabled({ team: undefined, modelId: undefined, apiKey: undefined });
    expect(result2).toBe(false);
  });
});

describe("recordAuditContent", () => {
  const suffix = randomUUID();
  const requestId = `test-audit-req-${suffix}`;

  beforeEach(async () => {
    const pool = getPool();
    await pool.query(
      `INSERT INTO requests (id, caller_oid, caller_name, status, capabilities)
       VALUES ($1, 'caller-1', 'Caller One', 'completed', '{}')
       ON CONFLICT (id) DO NOTHING`,
      [requestId]
    );
  });

  afterAll(async () => {
    await getPool().query(`DELETE FROM requests WHERE id = $1`, [requestId]);
  });

  it("inserts audit content", async () => {
    await recordAuditContent(requestId, "hello prompt", "hello response");
    const { rows } = await getPool().query(`SELECT prompt, response FROM audit_content WHERE request_id = $1`, [
      requestId,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].prompt).toBe("hello prompt");
    expect(rows[0].response).toBe("hello response");
  });

  it("upserts (no-op-safe) on repeated calls for the same request", async () => {
    await recordAuditContent(requestId, "first prompt", "first response");
    await recordAuditContent(requestId, "second prompt", "second response");
    const { rows } = await getPool().query(`SELECT prompt, response FROM audit_content WHERE request_id = $1`, [
      requestId,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].prompt).toBe("second prompt");
    expect(rows[0].response).toBe("second response");
  });
});

describe("getAuditEntries", () => {
  const suffix = randomUUID();
  const caller = `test-audit-caller-${suffix}`;
  const model = `test-audit-model-${suffix}`;
  const loggedReqId = `test-audit-logged-${suffix}`;
  const unloggedReqId = `test-audit-unlogged-${suffix}`;
  const otherCallerReqId = `test-audit-other-${suffix}`;

  beforeEach(async () => {
    const pool = getPool();
    await pool.query(`DELETE FROM requests WHERE id = ANY($1)`, [
      [loggedReqId, unloggedReqId, otherCallerReqId],
    ]);
    await pool.query(
      `INSERT INTO requests (id, caller_oid, caller_name, routed_model, status, capabilities, arrived_at)
       VALUES
        ($1, $3, 'Caller', $4, 'completed', '{}', now() - interval '10 minutes'),
        ($2, $3, 'Caller', $4, 'completed', '{}', now() - interval '5 minutes'),
        ($5, 'someone-else', 'Other Caller', $4, 'completed', '{}', now() - interval '5 minutes')`,
      [loggedReqId, unloggedReqId, caller, model, otherCallerReqId]
    );
    await pool.query(
      `INSERT INTO audit_content (request_id, prompt, response) VALUES ($1, 'p', 'r')`,
      [loggedReqId]
    );
  });

  afterAll(async () => {
    const pool = getPool();
    await pool.query(`DELETE FROM requests WHERE id = ANY($1)`, [[loggedReqId, unloggedReqId, otherCallerReqId]]);
  });

  it("returns entries with a logged flag set correctly", async () => {
    const entries = await getAuditEntries({ caller, limit: 50, offset: 0 });
    expect(entries).toHaveLength(2);
    const logged = entries.find((e: any) => e.id === loggedReqId);
    const unlogged = entries.find((e: any) => e.id === unloggedReqId);
    expect(logged?.logged).toBe(true);
    expect(unlogged?.logged).toBe(false);
  });

  it("filters by caller", async () => {
    const entries = await getAuditEntries({ caller, limit: 50, offset: 0 });
    for (const e of entries as any[]) {
      expect(e.callerOid ?? e.caller_oid).toBe(caller);
    }
    expect(entries.length).toBe(2);
  });

  it("filters by model", async () => {
    const entries = await getAuditEntries({ model, limit: 50, offset: 0 });
    expect(entries.length).toBe(3);
  });

  it("respects limit/offset", async () => {
    const entries = await getAuditEntries({ model, limit: 1, offset: 0 });
    expect(entries.length).toBe(1);
  });

  it("filters by team", async () => {
    const pool = getPool();
    const teamReqId = `test-audit-team-${suffix}`;
    await pool.query(
      `INSERT INTO requests (id, caller_oid, caller_name, team, routed_model, status, capabilities, arrived_at)
       VALUES ($1, $2, 'Caller', 'test-team-xyz', $3, 'completed', '{}', now())`,
      [teamReqId, caller, model]
    );
    try {
      const entries = await getAuditEntries({ team: "test-team-xyz", limit: 50, offset: 0 });
      expect(entries.map((e) => e.id)).toContain(teamReqId);
      expect(entries.every((e) => e.id === teamReqId)).toBe(true);
    } finally {
      await pool.query(`DELETE FROM requests WHERE id = $1`, [teamReqId]);
    }
  });
});

describe("deleteAuditHistory", () => {
  const suffix = randomUUID();
  const oldReqId = `test-audit-old-${suffix}`;
  const recentReqId = `test-audit-recent-${suffix}`;

  beforeEach(async () => {
    const pool = getPool();
    await pool.query(`DELETE FROM requests WHERE id = ANY($1)`, [[oldReqId, recentReqId]]);
    await pool.query(
      `INSERT INTO requests (id, caller_oid, caller_name, status, capabilities, arrived_at)
       VALUES ($1, 'caller-1', 'Caller', 'completed', '{}', now() - interval '60 days')`,
      [oldReqId]
    );
    await pool.query(
      `INSERT INTO requests (id, caller_oid, caller_name, status, capabilities, arrived_at)
       VALUES ($1, 'caller-1', 'Caller', 'completed', '{}', now() - interval '1 day')`,
      [recentReqId]
    );
  });

  afterEach(async () => {
    const pool = getPool();
    await pool.query(`DELETE FROM requests WHERE id = ANY($1)`, [[oldReqId, recentReqId]]);
  });

  it("deletes only requests older than N days and returns the deleted count", async () => {
    const result = await deleteAuditHistory(30);
    expect(result.deletedRequests).toBeGreaterThanOrEqual(1);

    const pool = getPool();
    const { rows: oldRows } = await pool.query(`SELECT id FROM requests WHERE id = $1`, [oldReqId]);
    const { rows: recentRows } = await pool.query(`SELECT id FROM requests WHERE id = $1`, [recentReqId]);
    expect(oldRows).toHaveLength(0);
    expect(recentRows).toHaveLength(1);
  });
});

afterAll(async () => {
  await closePool();
});
