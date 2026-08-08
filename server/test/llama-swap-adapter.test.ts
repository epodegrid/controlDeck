import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { HttpLlamaSwapClient } from "../src/adapters/llama-swap.js";

/**
 * Exercises the adapter over a real socket rather than a stubbed client.
 *
 * The bugs this covers were all invisible to a fake: the request body is what
 * a llama-swap container routes on, and every previous test substituted a fake
 * client that never saw one. A stand-in HTTP server records exactly what went
 * over the wire.
 */

type Recorded = { path: string; body: any };

let server: Server;
let baseUrl: string;
const recorded: Recorded[] = [];

/** Overridable per test, so failure paths can be exercised too. */
let respond: (path: string, res: any) => void;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      recorded.push({ path: req.url ?? "", body: raw ? JSON.parse(raw) : null });
      respond(req.url ?? "", res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function sseModelResponse(res: any, text: string) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  // No id, matching the sparser servers in the wild — content must still pass.
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

describe("HttpLlamaSwapClient wire format", () => {
  it("sends the upstream model name, which is all llama-swap routes on", async () => {
    recorded.length = 0;
    respond = (_p, res) => sseModelResponse(res, "hello");

    const client = new HttpLlamaSwapClient();
    const tokens: string[] = [];
    for await (const t of client.streamChat({
      endpointUrl: baseUrl,
      model: "eve:thinking-coding",
      messages: [{ role: "user", content: "hi" }],
    })) {
      if (t.token) tokens.push(t.token);
    }

    expect(tokens.join("")).toBe("hello");
    const sent = recorded.at(-1)!;
    expect(sent.path).toBe("/v1/chat/completions");
    // Without this field a multi-model container has nothing to select on and
    // answers with whichever model happens to be loaded, or an error.
    expect(sent.body.model).toBe("eve:thinking-coding");
    expect(sent.body.stream).toBe(true);
  });

  it("sends the model on embeddings too", async () => {
    recorded.length = 0;
    respond = (_p, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }));
    };

    const client = new HttpLlamaSwapClient();
    const out = await client.embed({
      endpointUrl: baseUrl,
      input: "some text",
      model: "nomic-embed-text-v2",
    });

    expect(out).toEqual([[0.1, 0.2]]);
    const sent = recorded.at(-1)!;
    expect(sent.path).toBe("/v1/embeddings");
    expect(sent.body.model).toBe("nomic-embed-text-v2");
    expect(sent.body.input).toBe("some text");
  });

  it("throws on an embedding error instead of returning an empty result", async () => {
    respond = (_p, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unknown model" }));
    };

    const client = new HttpLlamaSwapClient();
    await expect(
      client.embed({ endpointUrl: baseUrl, input: "x", model: "nope" })
    ).rejects.toThrow(/400/);
  });

  it("forwards sampling parameters and tools verbatim", async () => {
    recorded.length = 0;
    respond = (_p, res) => sseModelResponse(res, "ok");

    const client = new HttpLlamaSwapClient();
    const tools = [{ type: "function", function: { name: "skill_manage" } }];
    for await (const _ of client.streamChat({
      endpointUrl: baseUrl,
      model: "eve",
      messages: [{ role: "user", content: "hi" }],
      tools,
      toolChoice: "auto",
      temperature: 0.2,
      topP: 0.9,
      maxTokens: 128,
      stop: ["</s>"],
      seed: 7,
    })) {
      // drain
    }

    const body = recorded.at(-1)!.body;
    expect(body.tools).toEqual(tools);
    expect(body.tool_choice).toBe("auto");
    expect(body.temperature).toBe(0.2);
    expect(body.top_p).toBe(0.9);
    expect(body.max_tokens).toBe(128);
    expect(body.stop).toEqual(["</s>"]);
    expect(body.seed).toBe(7);
  });

  it("forwards a thinking model's reasoning as reasoning, not as the answer", async () => {
    respond = (_p, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      // Frame shapes copied from a real llama-server stream.
      const frame = (delta: unknown) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-abc",
          object: "chat.completion.chunk",
          model: "/models/x.gguf",
          choices: [{ index: 0, delta, finish_reason: null }],
        })}\n\n`;
      res.write(frame({ reasoning_content: "let me think" }));
      res.write(frame({ content: "answer" }));
      res.write("data: [DONE]\n\n");
      res.end();
    };

    const client = new HttpLlamaSwapClient();
    const seen: Array<{ token: string; reasoning?: string }> = [];
    for await (const t of client.streamChat({
      endpointUrl: baseUrl,
      model: "ornith:thinking-coding",
      messages: [{ role: "user", content: "hi" }],
    })) {
      if (!t.done) seen.push({ token: t.token, reasoning: t.reasoning });
    }

    // Dropping reasoning left a thinking model looking dead to the caller for
    // the whole of its thinking phase.
    expect(seen).toEqual([
      { token: "", reasoning: "let me think" },
      { token: "answer", reasoning: undefined },
    ]);
  });

  it("suppresses llama-swap's loading banner, which is not model output", async () => {
    respond = (_p, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      // Verbatim shape of what llama-swap emits with sendLoadingState while it
      // loads a model on demand: reasoning_content deltas with no id, object
      // or model, because no model has produced them yet.
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "━━━━━" } }] })}\n\n`);
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "llama-swap loading m" } }] })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-abc",
          object: "chat.completion.chunk",
          model: "/models/x.gguf",
          choices: [{ index: 0, delta: { content: "real" }, finish_reason: null }],
        })}\n\n`
      );
      res.write("data: [DONE]\n\n");
      res.end();
    };

    const client = new HttpLlamaSwapClient();
    const seen: Array<{ token: string; reasoning?: string }> = [];
    for await (const t of client.streamChat({
      endpointUrl: baseUrl,
      model: "ornith",
      messages: [{ role: "user", content: "hi" }],
    })) {
      if (!t.done) seen.push({ token: t.token, reasoning: t.reasoning });
    }

    // The banner is a status message from the proxy: it must not reach the
    // caller as output, be billed as tokens, or land in the audit content log.
    expect(seen).toEqual([{ token: "real", reasoning: undefined }]);
  });

  /**
   * §6.11 — the per-model prompt is a default, not an override.
   *
   * This matters most for agent tools. opencode, Copilot, Hermes and the rest
   * send a carefully constructed system prompt describing their tools and
   * output contract; prefixing an operator default in front of it gives the
   * model two sets of instructions, and the platform's — being first — tends
   * to win in most chat templates. The caller's tool loop then breaks in ways
   * that look like the model misbehaving.
   */
  async function systemMessagesSentFor(messages: Array<{ role: string; content: unknown }>) {
    recorded.length = 0;
    respond = (_p, res) => sseModelResponse(res, "ok");
    const client = new HttpLlamaSwapClient();
    for await (const _ of client.streamChat({
      endpointUrl: baseUrl,
      model: "ornith",
      systemPrompt: "platform default",
      messages,
    })) {
      // drain
    }
    return recorded.at(-1)!.body.messages;
  }

  it("injects the platform default only when the caller sent no system prompt", async () => {
    const sent = await systemMessagesSentFor([{ role: "user", content: "hi" }]);
    expect(sent[0]).toEqual({ role: "system", content: "platform default" });
  });

  it("stays out of the way of an agent tool's own system prompt", async () => {
    const sent = await systemMessagesSentFor([
      { role: "system", content: "You are opencode. Use the tools provided." },
      { role: "user", content: "hi" },
    ]);
    expect(sent.filter((m: any) => m.role === "system")).toHaveLength(1);
    expect(sent[0].content).toBe("You are opencode. Use the tools provided.");
  });

  it("treats a `developer` message as the caller's system prompt", async () => {
    // OpenAI's reasoning models take `developer` in place of `system`, so a
    // client targeting those would otherwise get the default injected
    // alongside its own instructions.
    const sent = await systemMessagesSentFor([
      { role: "developer", content: "You are a coding agent." },
      { role: "user", content: "hi" },
    ]);
    expect(sent.some((m: any) => m.role === "system")).toBe(false);
    expect(sent).toHaveLength(2);
  });

  it("still injects when the caller's system message is empty", async () => {
    // A placeholder expresses no intention; honouring it would silently
    // discard the operator's configured prompt.
    const sent = await systemMessagesSentFor([
      { role: "system", content: "   " },
      { role: "user", content: "hi" },
    ]);
    expect(sent[0]).toEqual({ role: "system", content: "platform default" });
  });

  it("respects a system message that arrives after the first turn", async () => {
    // Some clients append their instructions rather than leading with them.
    const sent = await systemMessagesSentFor([
      { role: "user", content: "hi" },
      { role: "system", content: "Answer only in JSON." },
    ]);
    expect(sent.filter((m: any) => m.role === "system")).toHaveLength(1);
    expect(sent.filter((m: any) => m.role === "system")[0].content).toBe("Answer only in JSON.");
  });

  it("leaves a caller-supplied system message authoritative (PRD §6.11)", async () => {
    recorded.length = 0;
    respond = (_p, res) => sseModelResponse(res, "ok");

    const client = new HttpLlamaSwapClient();
    for await (const _ of client.streamChat({
      endpointUrl: baseUrl,
      model: "eve",
      systemPrompt: "platform default",
      messages: [
        { role: "system", content: "caller's own" },
        { role: "user", content: "hi" },
      ],
    })) {
      // drain
    }

    const messages = recorded.at(-1)!.body.messages;
    expect(messages.filter((m: any) => m.role === "system")).toHaveLength(1);
    expect(messages[0].content).toBe("caller's own");
  });
});
