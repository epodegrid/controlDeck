import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/http/app.js";
import { FakeKedaClient } from "../src/adapters/keda.js";
import { getPool } from "../src/db/pool.js";

process.env.USE_FAKE_ADAPTERS = "true";

let app: FastifyInstance;
let token: string;
const kedaClient = new FakeKedaClient();

/**
 * Replicas are owned by the reconciler at runtime, which does not run under
 * test — so these end-to-end cases have to create the capacity they need.
 * Relying on the seed for them was the bug: the seed stopped creating replicas
 * when the reconciler took over, and this suite only kept passing on rows a
 * previous run had left behind.
 */
async function insertReplicasForSeededModels() {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM model_registry ORDER BY id`);
  for (const model of rows) {
    await pool.query(
      `INSERT INTO replicas (id, model_id, status, in_flight, load_pct, endpoint_url, max_concurrency)
       VALUES ($1, $2, 'ready', 0, 0, 'http://test.invalid', 4)
       ON CONFLICT (id) DO UPDATE SET status = 'ready', in_flight = 0`,
      [`${model.id}-httptest`, model.id]
    );
  }
}

beforeAll(async () => {
  await insertReplicasForSeededModels();
  app = await buildApp({ kedaClient, logger: false });
  await app.ready();
  const tokenRes = await app.inject({ method: "POST", url: "/dev/token", payload: { oid: "http-test-oid", name: "HTTP Test", team: "engineering" } });
  token = JSON.parse(tokenRes.body).access_token;
});

afterAll(async () => {
  await app.close();
  await getPool().query(`DELETE FROM replicas WHERE id LIKE '%-httptest'`);
});

describe("HTTP API", () => {
  it("dry_run returns the exact upstream body without calling the model", async () => {
    // The question this answers — "is the gateway dropping my system prompt, or
    // is the model ignoring it?" — has twice needed a packet capture between
    // the router and the backend. The gateway knows and can say.
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions?dry_run=1",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        model: "kestrel-9b",
        messages: [
          { role: "system", content: "You are opencode." },
          { role: "user", content: "hi" },
        ],
        tools: [{ type: "function", function: { name: "read_file" } }],
        temperature: 0.3,
      },
    });

    expect(res.statusCode).toBe(200);
    const out = JSON.parse(res.body);
    expect(out.object).toBe("controldeck.dry_run");

    // The caller's system message survives, and the platform default is not
    // prepended on top of it.
    const systems = out.upstream.body.messages.filter((m: any) => m.role === "system");
    expect(systems).toHaveLength(1);
    expect(systems[0].content).toBe("You are opencode.");

    // Everything else the backend needs is there too.
    expect(out.upstream.body.tools).toHaveLength(1);
    expect(out.upstream.body.temperature).toBe(0.3);
    expect(out.upstream.url).toContain("/v1/chat/completions");

    // And nothing was recorded: a dry run is not traffic.
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM requests WHERE caller_oid = 'http-test-oid' AND status = 'queued'`
    );
    expect(rows[0].n).toBe(0);
  });

  it("forwards tools[] to the backend rather than silently dropping them", async () => {
    // §6.12 requires tool calling to be a pass-through. The router filters on
    // the `tools` capability and routes accordingly, so dropping the tools
    // afterwards gives the caller a plain answer with no hint why.
    const captured: Array<Record<string, unknown>> = [];
    const recording = {
      async checkReady() { return true; },
      async *streamChat(params: Record<string, unknown>) {
        captured.push(params);
        yield { token: "ok", done: false };
        yield { token: "", done: true };
      },
      async embed() { return [[0]]; },
    };

    const recordingApp = await buildApp({ kedaClient, logger: false, llamaSwap: recording as never });
    await recordingApp.ready();
    const t = JSON.parse(
      (await recordingApp.inject({ method: "POST", url: "/dev/token", payload: { oid: "tools", name: "Tools" } })).body
    ).access_token;

    const tools = [{ type: "function", function: { name: "search", parameters: {} } }];
    await recordingApp.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${t}` },
      payload: { messages: [{ role: "user", content: "find something" }], tools, tool_choice: "auto" },
    });

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0].tools).toEqual(tools);
    expect(captured[0].toolChoice).toBe("auto");
    await recordingApp.close();
  });

  it("streaming responses carry CORS headers", async () => {
    // Writing to reply.raw bypasses Fastify's reply object, which silently
    // dropped the headers @fastify/cors had set. The stream was perfectly
    // healthy to curl and rejected by EventSource, so every server-side check
    // passed while the dashboard's log panel sat empty.
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${token}`, origin: "http://localhost:3000" },
      payload: { stream: true, messages: [{ role: "user", content: "hi" }] },
    });

    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.headers["access-control-allow-origin"]).toBeDefined();
  });

  it("the log stream carries CORS headers too", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/logs/does-not-exist",
      headers: { origin: "http://localhost:3000" },
    });
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.headers["access-control-allow-origin"]).toBeDefined();
    // And it explains itself rather than inventing lines.
    expect(res.body).toMatch(/Could not attach to logs/);
  });

  it("healthz responds ok", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
  });

  it("rejects /v1/models without a token", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/models" });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe("auth_invalid");
  });

  it("lists models with a valid token", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/models", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.length).toBeGreaterThan(0);
  });

  it("rejects an explicit model override lacking a required capability", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${token}` },
      payload: { model: "ember-embed", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).error.code).toBe("capability_mismatch");
  });

  it("serves a non-streaming chat completion end to end", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${token}` },
      payload: { messages: [{ role: "user", content: "Say hello briefly." }] },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.choices[0].message.content.length).toBeGreaterThan(0);
    expect(body.usage.completion_tokens).toBeGreaterThan(0);
  });

  it("serves embeddings end to end", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/embeddings",
      headers: { authorization: `Bearer ${token}` },
      payload: { input: "hello world" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data[0].embedding.length).toBeGreaterThan(0);
  });

  it("exposes dashboard overview and models endpoints", async () => {
    const overview = await app.inject({ method: "GET", url: "/api/overview" });
    expect(overview.statusCode).toBe(200);
    const models = await app.inject({ method: "GET", url: "/api/models" });
    expect(models.statusCode).toBe(200);
    const body = JSON.parse(models.body);
    expect(body[0].replicas).toBeDefined();
  });

  it("exposes prometheus metrics", async () => {
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("controldeck_queue_depth");
  });
});
