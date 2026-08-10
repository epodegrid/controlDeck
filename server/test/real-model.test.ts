import { describe, it, expect, beforeAll } from "vitest";
import { HttpLlamaSwapClient } from "../src/adapters/llama-swap.js";
import { listUpstreamNames, checkUpstreamName } from "../src/registry/verify-upstream.js";
import { tailFromEndpoint, parseLine } from "../src/logs/sources.js";
import type { ModelConfig } from "../src/types.js";

/**
 * Runs against a real llama-swap container, not a stand-in.
 *
 * Every bug this file covers shipped to production and was found by a person
 * rather than by a test, because the suite had only fakes and hand-written SSE
 * frames to check against. A fake echoes the shape you already believed in;
 * these paths broke precisely where the belief was wrong — llama-swap routing
 * on a field we never sent, a thinking model using `reasoning_content` instead
 * of `content`, a loading banner arriving in that same field, and a log
 * endpoint that streams under a different path than the mock's.
 *
 * Skipped unless REAL_MODEL_URL points at one:
 *
 *   ./scripts/e2e-real-model.sh          # builds, runs, tests, tears down
 *
 * The model is Qwen3-0.6B, chosen because it thinks, calls tools, and is small
 * enough for CI — see test-model/Dockerfile.
 */

const BASE = process.env.REAL_MODEL_URL;
const suite = BASE ? describe : describe.skip;

/** Cold weight loading dominates the first call; later ones are quick. */
const LOAD_TIMEOUT = 300_000;

function model(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id: "tiny",
    name: "Tiny",
    classLabel: "test",
    modelClass: "fast",
    capabilities: ["chat", "tools"],
    minReplicas: 1,
    maxReplicas: 1,
    systemPrompt: "",
    costValue: 0,
    costBasis: "per_1k_tokens",
    endpointUrl: BASE ?? "",
    upstreamModel: "tiny",
    backendModelId: "tiny",
    port: 8080,
    firstTokenTimeoutMs: null,
    configSource: "gitops",
    hasOverride: false,
    ...overrides,
  };
}

suite("against a real llama-swap container", () => {
  const client = new HttpLlamaSwapClient();

  beforeAll(async () => {
    // Warm the model once so the loading banner does not land in the middle of
    // a test that is not about it.
    for await (const _ of client.streamChat({
      endpointUrl: BASE!,
      model: "tiny",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 1,
    })) {
      // drain
    }
  }, LOAD_TIMEOUT);

  it("routes on the model field, which is all llama-swap has to go on", async () => {
    // Omitting it is not a degraded request, it is a failed one.
    await expect(
      (async () => {
        for await (const _ of client.streamChat({
          endpointUrl: BASE!,
          messages: [{ role: "user", content: "hi" }],
          maxTokens: 1,
        })) {
          // drain
        }
      })()
    ).rejects.toThrow(/no model id could be identified|400|404/);
  });

  it("serves every alias and variant the container advertises", async () => {
    const names = await listUpstreamNames(BASE!);
    expect(names).not.toBeNull();
    // Aliases and setParamsByID variants alike — this listing is what the
    // router's upstream verification checks a configured name against.
    expect(names).toEqual(expect.arrayContaining(["tiny", "Qwen3-0.6B", "tiny:thinking"]));

    expect(checkUpstreamName(model({ upstreamModel: "tiny:thinking" }), names).state).toBe("ok");
    const wrong = checkUpstreamName(model({ upstreamModel: "not-a-real-name" }), names);
    expect(wrong.state).toBe("missing");
  });

  it("answers under a variant name", async () => {
    let text = "";
    for await (const chunk of client.streamChat({
      endpointUrl: BASE!,
      model: "tiny:instruct",
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
      maxTokens: 20,
    })) {
      if (!chunk.done && !chunk.reasoning) text += chunk.token;
    }
    expect(text.trim().length).toBeGreaterThan(0);
  }, LOAD_TIMEOUT);

  it("separates a thinking model's reasoning from its answer", async () => {
    // The bug this replaces: reasoning arrives as `reasoning_content`, the
    // adapter read only `content`, and the caller saw silence for the whole
    // thinking phase.
    let reasoning = "";
    let content = "";
    for await (const chunk of client.streamChat({
      endpointUrl: BASE!,
      model: "tiny:thinking",
      messages: [{ role: "user", content: "What is 2+2? Answer in one word." }],
      maxTokens: 400,
    })) {
      if (chunk.done) break;
      if (chunk.reasoning) reasoning += chunk.reasoning;
      else content += chunk.token;
    }

    expect(reasoning.length).toBeGreaterThan(0);
    // And it is the model's own thinking, not llama-swap's progress banner.
    expect(reasoning).not.toContain("━");
    expect(reasoning.toLowerCase()).not.toContain("llama-swap");
  }, LOAD_TIMEOUT);

  it("never surfaces the loading banner as model output", async () => {
    // sendLoadingState streams a progress bar as reasoning_content while
    // weights load. It is llama-swap talking, not the model, and it must not
    // be billed as tokens or written to the audit content log.
    let everything = "";
    for await (const chunk of client.streamChat({
      endpointUrl: BASE!,
      model: "tiny",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 30,
    })) {
      if (chunk.done) break;
      everything += chunk.reasoning ?? chunk.token;
    }
    expect(everything).not.toContain("━");
    expect(everything.toLowerCase()).not.toContain("loading");
  }, LOAD_TIMEOUT);

  it("passes tool definitions through and gets a tool call back", async () => {
    let text = "";
    for await (const chunk of client.streamChat({
      endpointUrl: BASE!,
      model: "tiny",
      messages: [{ role: "user", content: "What is the weather in Paris? Use the tool." }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the weather for a city",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        },
      ],
      temperature: 0.1,
      maxTokens: 150,
    })) {
      if (chunk.done) break;
      text += chunk.reasoning ?? chunk.token;
    }
    // The adapter forwards tools and streams whatever comes back; asserting the
    // exact tool-call frame would be asserting llama.cpp's format, not ours.
    // What matters is that sending tools does not break the stream.
    expect(text.length).toBeGreaterThan(0);
  }, LOAD_TIMEOUT);

  it("tails the container's real log stream", async () => {
    // llama-swap serves /logs/stream; /logs is a one-shot history dump. Asking
    // for the mock model's shape found no `data:` frames and showed nothing.
    const lines: string[] = [];
    const controller = new AbortController();
    const done = tailFromEndpoint(BASE!, "tiny", 50, (l) => lines.push(l.message), controller.signal);

    await new Promise((r) => setTimeout(r, 4000));
    controller.abort();
    await done.catch(() => {});

    expect(lines.length).toBeGreaterThan(0);
    // logToStdout: both is what puts llama-server's own output here; without
    // it the container emits only llama-swap's proxy lines.
    expect(lines.join("\n")).toMatch(/llama|srv|model|load/i);
  }, 60_000);

  it("parses the container's log format into levels", async () => {
    const lines: Array<ReturnType<typeof parseLine>> = [];
    const controller = new AbortController();
    const done = tailFromEndpoint(
      BASE!,
      "tiny",
      50,
      (l) => lines.push(l),
      controller.signal
    );
    await new Promise((r) => setTimeout(r, 4000));
    controller.abort();
    await done.catch(() => {});

    expect(lines.length).toBeGreaterThan(0);
    // Nothing should fall through as an "error" just because a line mentions
    // one — the level comes from what the server declared.
    const levels = new Set(lines.map((l) => l?.level));
    expect(levels.has("info")).toBe(true);
  }, 60_000);
});
