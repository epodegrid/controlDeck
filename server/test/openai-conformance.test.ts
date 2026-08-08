import { describe, it, expect, beforeAll, afterAll } from "vitest";
import OpenAI from "openai";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/http/app.js";
import { getPool } from "../src/db/pool.js";

/**
 * Conformance against the official OpenAI SDK.
 *
 * The gateway claims to be OpenAI-API-compatible (§6.12), and every caller
 * reaches it through a client library rather than by hand. Testing with curl
 * proves the bytes we meant to send arrived; it does not prove a real client
 * can parse them, that required fields are present, or that the request the
 * caller composed survives the trip.
 *
 * That gap is not hypothetical: `tools[]` was being dropped between the router
 * and the backend, and nothing caught it, because every test so far asserted
 * on what the router returned rather than on what a client asked for.
 *
 * The backend here is a recording stub, so these assertions are about the
 * gateway's own request and response handling — what it forwards, and what it
 * gives back — not about any model's behaviour.
 */

type Captured = Record<string, unknown>;
const captured: Captured[] = [];

/** Stands in for llama-swap, recording exactly what the router forwards. */
const recordingBackend = {
  async checkReady() {
    return true;
  },
  async *streamChat(params: Captured) {
    captured.push(params);
    for (const token of ["Hello", " there"]) {
      yield { token, done: false };
    }
    yield { token: "", done: true };
  },
  async embed(params: Captured) {
    captured.push(params);
    const input = params.input as string | string[];
    const rows = Array.isArray(input) ? input : [input];
    return rows.map(() => [0.1, 0.2, 0.3]);
  },
};

let app: FastifyInstance;
let client: OpenAI;
const MODEL = "kestrel-9b";

beforeAll(async () => {
  process.env.SIM_MODE = "true";
  app = await buildApp({ logger: false, llamaSwap: recordingBackend as never });
  await app.listen({ port: 0, host: "127.0.0.1" });

  // The router needs somewhere to place work for every model these tests
  // touch; the reconciler does not run here.
  for (const id of ["kestrel-9b", "ornith-35b", "lark-vision", "ember-embed"]) {
    await getPool().query(
      `INSERT INTO replicas (id, model_id, status, in_flight, load_pct, endpoint_url, max_concurrency)
       VALUES ($2, $1, 'ready', 0, 0, 'http://stub.invalid', 8)
       ON CONFLICT (id) DO UPDATE SET status = 'ready', in_flight = 0`,
      [id, `conformance-${id}`]
    );
  }

  const token = JSON.parse(
    (await app.inject({ method: "POST", url: "/dev/token", payload: { oid: "sdk", name: "SDK Caller" } })).body
  ).access_token;

  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  client = new OpenAI({ apiKey: token, baseURL: `http://127.0.0.1:${port}/v1` });
});

afterAll(async () => {
  await getPool().query(`DELETE FROM replicas WHERE id LIKE 'conformance-%'`);
  await app.close();
});

const lastCapture = () => captured[captured.length - 1];

describe("OpenAI SDK conformance", () => {
  describe("models", () => {
    it("lists models in a shape the SDK accepts", async () => {
      const page = await client.models.list();
      const ids = page.data.map((m) => m.id);
      expect(ids).toContain(MODEL);

      const model = page.data.find((m) => m.id === MODEL)!;
      expect(model.object).toBe("model");
      // `created` and `owned_by` are required by the spec. Clients that model
      // the response strictly will reject a listing without them.
      expect(typeof model.created).toBe("number");
      expect(typeof model.owned_by).toBe("string");
    });
  });

  describe("chat completions", () => {
    it("returns a complete, parseable completion", async () => {
      const completion = await client.chat.completions.create({
        model: MODEL,
        messages: [{ role: "user", content: "hello" }],
      });

      expect(completion.object).toBe("chat.completion");
      expect(typeof completion.created).toBe("number");
      expect(completion.choices[0].message.role).toBe("assistant");
      expect(completion.choices[0].message.content).toBe("Hello there");
      expect(completion.choices[0].finish_reason).toBe("stop");
      expect(completion.usage?.total_tokens).toBeGreaterThan(0);
    });

    it("streams chunks the SDK can assemble", async () => {
      const stream = await client.chat.completions.create({
        model: MODEL,
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      });

      let text = "";
      let sawRole = false;
      let finish: string | null | undefined;
      for await (const chunk of stream) {
        expect(chunk.object).toBe("chat.completion.chunk");
        expect(typeof chunk.created).toBe("number");
        if (chunk.choices[0]?.delta?.role) sawRole = true;
        text += chunk.choices[0]?.delta?.content ?? "";
        if (chunk.choices[0]?.finish_reason) finish = chunk.choices[0].finish_reason;
      }

      expect(text).toBe("Hello there");
      expect(finish).toBe("stop");
      // The spec opens a stream with the assistant role; clients use it to know
      // which message the deltas belong to.
      expect(sawRole).toBe(true);
    });

    it("forwards sampling parameters instead of quietly ignoring them", async () => {
      // A caller who sets temperature 0 for reproducibility, or max_tokens to
      // bound cost, must actually get that behaviour — silently dropping these
      // produces answers that look fine and are not what was asked for.
      await client.chat.completions.create({
        model: MODEL,
        messages: [{ role: "user", content: "hello" }],
        temperature: 0,
        top_p: 0.5,
        max_tokens: 32,
        stop: ["\n\n"],
        seed: 42,
        presence_penalty: 0.4,
        frequency_penalty: 0.6,
      });

      const sent = lastCapture();
      expect(sent.temperature).toBe(0);
      expect(sent.topP).toBe(0.5);
      expect(sent.maxTokens).toBe(32);
      expect(sent.stop).toEqual(["\n\n"]);
      expect(sent.seed).toBe(42);
      expect(sent.presencePenalty).toBe(0.4);
      expect(sent.frequencyPenalty).toBe(0.6);
    });

    it("forwards tool definitions and tool_choice", async () => {
      const tools = [
        {
          type: "function" as const,
          function: {
            name: "get_weather",
            description: "Look up the weather",
            parameters: { type: "object", properties: { city: { type: "string" } } },
          },
        },
      ];

      await client.chat.completions.create({
        model: MODEL,
        messages: [{ role: "user", content: "weather in Oslo?" }],
        tools,
        tool_choice: "auto",
      });

      const sent = lastCapture();
      expect(sent.tools).toEqual(tools);
      expect(sent.toolChoice).toBe("auto");
    });

    it("forwards a vision message with its image part intact", async () => {
      await client.chat.completions.create({
        model: "lark-vision",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
            ],
          },
        ],
      });

      const sent = lastCapture();
      const messages = sent.messages as Array<{ content: unknown }>;
      const parts = messages.at(-1)!.content as Array<{ type: string }>;
      expect(parts.map((p) => p.type)).toEqual(["text", "image_url"]);
    });

    it("forwards a prior assistant tool call and its tool result", async () => {
      // A tool-calling conversation replays the whole exchange on the next
      // turn. Losing the tool role or tool_call_id breaks the second round.
      await client.chat.completions.create({
        model: MODEL,
        messages: [
          { role: "user", content: "weather in Oslo?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"Oslo"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: '{"temp_c": 3}' },
        ],
      });

      const messages = lastCapture().messages as Array<Record<string, unknown>>;
      expect(messages.at(-1)!.role).toBe("tool");
      expect(messages.at(-1)!.tool_call_id).toBe("call_1");
      expect(messages.at(-2)!.tool_calls).toBeDefined();
    });
  });

  describe("embeddings", () => {
    it("returns embeddings in the SDK's expected shape", async () => {
      const res = await client.embeddings.create({ model: "ember-embed", input: "hello" });
      expect(res.object).toBe("list");
      expect(res.data[0].object).toBe("embedding");
      expect(res.data[0].index).toBe(0);
      expect(Array.isArray(res.data[0].embedding)).toBe(true);
      expect(res.usage.total_tokens).toBeGreaterThan(0);
    });

    it("handles a batch of inputs", async () => {
      const res = await client.embeddings.create({
        model: "ember-embed",
        input: ["one", "two", "three"],
      });
      expect(res.data).toHaveLength(3);
      expect(res.data.map((d) => d.index)).toEqual([0, 1, 2]);
    });
  });

  describe("errors", () => {
    it("reports an unknown model as a structured API error", async () => {
      await expect(
        client.chat.completions.create({
          model: "no-such-model",
          messages: [{ role: "user", content: "hi" }],
        })
        // 404 rather than a capability complaint: the model does not exist,
        // which is a different fix for the caller.
      ).rejects.toMatchObject({ status: 404 });
    });

    it("rejects a bad key with 401 so clients can distinguish auth failures", async () => {
      const address = app.server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const bad = new OpenAI({ apiKey: "not-a-token", baseURL: `http://127.0.0.1:${port}/v1` });

      await expect(
        bad.chat.completions.create({ model: MODEL, messages: [{ role: "user", content: "hi" }] })
      ).rejects.toMatchObject({ status: 401 });
    });
  });
});
