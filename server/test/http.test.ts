import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/http/app.js";
import { FakeKedaClient } from "../src/adapters/keda.js";

process.env.USE_FAKE_ADAPTERS = "true";

let app: FastifyInstance;
let token: string;
const kedaClient = new FakeKedaClient();

beforeAll(async () => {
  app = await buildApp({ kedaClient, logger: false });
  await app.ready();
  const tokenRes = await app.inject({ method: "POST", url: "/dev/token", payload: { oid: "http-test-oid", name: "HTTP Test", team: "engineering" } });
  token = JSON.parse(tokenRes.body).access_token;
});

afterAll(async () => {
  await app.close();
});

describe("HTTP API", () => {
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
