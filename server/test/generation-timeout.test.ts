import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/http/app.js";
import { FakeKedaClient } from "../src/adapters/keda.js";
import { getPool, closePool } from "../src/db/pool.js";
import type { ChatToken } from "../src/adapters/llama-swap.js";

process.env.USE_FAKE_ADAPTERS = "true";

/**
 * §6.5's clocks have to reach the live request, not only the database.
 *
 * The periodic sweeps mark rows; they cannot touch a connection that is
 * already open. Before this the row read `stall_timeout` while the caller sat
 * waiting on a model that might never answer, until the client gave up on its
 * own — which is what "request timed out", with nothing to explain it, looks
 * like from the other end.
 */
const MODEL_ID = "kestrel-9b";

/** A backend that accepts the request and then never produces a token. */
class SilentClient {
  async checkReady() {
    return true;
  }
  async *streamChat(params: { signal?: AbortSignal }): AsyncGenerator<ChatToken> {
    await new Promise((resolve, reject) => {
      if (params.signal?.aborted) return reject(new Error("aborted"));
      params.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      // Otherwise: silence, exactly as a model stuck in prompt evaluation.
    });
    yield { token: "", done: true };
  }
  async embed() {
    return [[0]];
  }
}

let app: FastifyInstance;
let token: string;

beforeAll(async () => {
  const pool = getPool();
  await pool.query(
    `INSERT INTO replicas (id, model_id, status, in_flight, load_pct, endpoint_url, max_concurrency)
     VALUES ('timeout-test-replica', $1, 'ready', 0, 0, 'http://test.invalid', 4)
     ON CONFLICT (id) DO UPDATE SET status = 'ready', in_flight = 0`,
    [MODEL_ID]
  );
  // A short allowance, so the test does not wait ten minutes to prove a point.
  await pool.query(`UPDATE model_registry SET first_token_timeout_ms = 1500 WHERE id = $1`, [MODEL_ID]);

  app = await buildApp({
    kedaClient: new FakeKedaClient(),
    llamaSwap: new SilentClient() as never,
    logger: false,
  });
  await app.ready();
  const res = await app.inject({
    method: "POST",
    url: "/dev/token",
    payload: { oid: "timeout-test-oid", name: "Timeout Test", team: "engineering" },
  });
  token = JSON.parse(res.body).access_token;
});

afterAll(async () => {
  await app.close();
  const pool = getPool();
  await pool.query(`DELETE FROM replicas WHERE id = 'timeout-test-replica'`);
  await pool.query(`UPDATE model_registry SET first_token_timeout_ms = NULL WHERE id = $1`, [MODEL_ID]);
  await pool.query(`DELETE FROM requests WHERE caller_oid = 'timeout-test-oid'`);
  await closePool();
});

describe("a generation that never starts", () => {
  it("fails the request itself rather than leaving the caller waiting", async () => {
    const started = Date.now();
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${token}` },
      payload: { model: MODEL_ID, messages: [{ role: "user", content: "hi" }] },
    });
    const elapsed = Date.now() - started;

    expect(res.statusCode).toBe(504);
    const out = JSON.parse(res.body);
    expect(out.error.type).toBe("timeout_error");

    // The message has to name the remedy: which knob, for which model.
    expect(out.error.message).toContain("firstTokenTimeoutMs");
    expect(out.error.message).toContain(MODEL_ID);

    // And it must actually give up on time, not eventually.
    expect(elapsed).toBeLessThan(10_000);
  }, 30_000);

  it("records the failure against the request", async () => {
    const { rows } = await getPool().query<{ status: string; error_code: string }>(
      `SELECT status, error_code FROM requests WHERE caller_oid = 'timeout-test-oid' ORDER BY arrived_at DESC LIMIT 1`
    );
    expect(rows[0]?.status).toBe("stall_timeout");
  });
});
