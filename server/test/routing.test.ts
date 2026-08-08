import { describe, it, expect } from "vitest";
import { selectModel } from "../src/routing/select-model.js";
import type { ModelConfig, ChatCompletionRequest, ChatMessage } from "../src/types.js";

function makeModel(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id: "fast-1",
    name: "Fast Model",
    classLabel: "9B",
    modelClass: "fast",
    capabilities: ["chat"],
    minReplicas: 1,
    maxReplicas: 1,
    systemPrompt: "",
    costValue: 0,
    costBasis: "per_1k_tokens",
    endpointUrl: "http://localhost",
    upstreamModel: "fast-1",
    backendModelId: "fast-1",
    port: 8080,
    firstTokenTimeoutMs: null,
    configSource: "gitops",
    hasOverride: false,
    ...overrides,
  };
}

const FAST_CHAT = makeModel({ id: "fast-chat", modelClass: "fast", capabilities: ["chat"] });
const FAST_TOOLS = makeModel({ id: "fast-tools", modelClass: "fast", capabilities: ["chat", "tools"] });
const LARGE_CHAT = makeModel({ id: "large-chat", modelClass: "large", capabilities: ["chat"] });
const LARGE_TOOLS = makeModel({ id: "large-tools", modelClass: "large", capabilities: ["chat", "tools"] });
const VISION_MODEL = makeModel({ id: "vision-1", modelClass: "vision", capabilities: ["chat", "vision"] });
const EMBEDDING_MODEL = makeModel({ id: "embed-1", modelClass: "embedding", capabilities: ["embeddings"] });

function userMsg(content: string): ChatMessage {
  return { role: "user", content };
}

function baseRequest(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    messages: [userMsg("Hello there")],
    ...overrides,
  };
}

describe("selectModel - explicit override", () => {
  it("routes to the named model when it satisfies all required capabilities", () => {
    const result = selectModel({
      request: baseRequest({ model: "fast-chat" }),
      candidates: [FAST_CHAT, LARGE_CHAT],
      endpoint: "chat",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.modelId).toBe("fast-chat");
      expect(result.reason).toBe("explicit_override");
    }
  });

  it("hard-rejects when the named model lacks a capability required by the request (vision)", () => {
    const result = selectModel({
      request: baseRequest({
        model: "fast-chat",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
            ],
          },
        ],
      }),
      candidates: [FAST_CHAT, VISION_MODEL],
      endpoint: "chat",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error.code).toBe("capability_mismatch");
      expect(result.error.error.type).toBe("invalid_request_error");
    }
  });

  it("hard-rejects when the named model lacks tools capability", () => {
    const result = selectModel({
      request: baseRequest({ model: "fast-chat", tools: [{ name: "get_weather" }] }),
      candidates: [FAST_CHAT, FAST_TOOLS],
      endpoint: "chat",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error.code).toBe("capability_mismatch");
    }
  });

  it("never substitutes another model when the named model does not exist among candidates", () => {
    const result = selectModel({
      request: baseRequest({ model: "does-not-exist" }),
      candidates: [FAST_CHAT, LARGE_CHAT],
      endpoint: "chat",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Distinct from capability_mismatch on purpose: the model does not
      // exist, which is a different fix for the caller than "this model
      // cannot do that". OpenAI clients branch on the 404 this maps to.
      expect(result.error.error.code).toBe("model_not_found");
    }
  });
});

describe("selectModel - auto-routing capability filter", () => {
  it("treats 'auto' the same as no model specified", () => {
    const result = selectModel({
      request: baseRequest({ model: "auto" }),
      candidates: [FAST_CHAT],
      endpoint: "chat",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reason).not.toBe("explicit_override");
    }
  });

  it("picks a vision-capable candidate when an image part is present", () => {
    const result = selectModel({
      request: baseRequest({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe this" },
              { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
            ],
          },
        ],
      }),
      candidates: [FAST_CHAT, LARGE_CHAT, VISION_MODEL],
      endpoint: "chat",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.modelId).toBe("vision-1");
    }
  });

  it("only considers embedding-capable models for the embeddings endpoint", () => {
    const result = selectModel({
      request: baseRequest(),
      candidates: [FAST_CHAT, LARGE_CHAT, EMBEDDING_MODEL],
      endpoint: "embeddings",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.modelId).toBe("embed-1");
    }
  });

  it("returns capability_mismatch when zero candidates satisfy required capabilities", () => {
    const result = selectModel({
      request: baseRequest({
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: "https://example.com/cat.png" } }],
          },
        ],
      }),
      candidates: [FAST_CHAT, LARGE_CHAT],
      endpoint: "chat",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error.code).toBe("capability_mismatch");
      expect(result.error.error.type).toBe("invalid_request_error");
    }
  });
});

describe("selectModel - complexity-based selection", () => {
  it("defaults to the fast model for a short simple prompt when both classes qualify", () => {
    const result = selectModel({
      request: baseRequest({ messages: [userMsg("What's the capital of France?")] }),
      candidates: [FAST_CHAT, LARGE_CHAT],
      endpoint: "chat",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.modelId).toBe("fast-chat");
      expect(result.reason).toBe("complexity:fast");
    }
  });

  it("prefers the fast tool-capable model when tools are requested but no other complexity signal is present", () => {
    const result = selectModel({
      request: baseRequest({ messages: [userMsg("What's the weather?")], tools: [{ name: "get_weather" }] }),
      candidates: [FAST_TOOLS, LARGE_TOOLS],
      endpoint: "chat",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.modelId).toBe("fast-tools");
      expect(result.reason).toBe("complexity:fast");
    }
  });

  it("routes a very long / complex prompt to the large model", () => {
    const longPrompt = "Please analyze in depth, step by step, and prove the following: " + "lorem ipsum dolor sit amet ".repeat(200);
    const result = selectModel({
      request: baseRequest({ messages: [userMsg(longPrompt)] }),
      candidates: [FAST_CHAT, LARGE_CHAT],
      endpoint: "chat",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.modelId).toBe("large-chat");
      expect(result.reason).toBe("complexity:large");
    }
  });

  it("routes to the large tool-capable model when tools are requested alongside a complex-reasoning prompt", () => {
    const result = selectModel({
      request: baseRequest({
        messages: [
          userMsg(
            "Step by step, analyze in depth the following multi-part question: 1) what is the weather, 2) prove your reasoning."
          ),
        ],
        tools: [{ name: "get_weather" }],
      }),
      candidates: [FAST_TOOLS, LARGE_TOOLS],
      endpoint: "chat",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.modelId).toBe("large-tools");
      expect(result.reason).toBe("complexity:large");
    }
  });

  it("falls back to the only remaining candidate when just one model qualifies, regardless of class", () => {
    const longPrompt = "Please analyze in depth: " + "x".repeat(5000);
    const result = selectModel({
      request: baseRequest({ messages: [userMsg(longPrompt)] }),
      candidates: [FAST_CHAT],
      endpoint: "chat",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.modelId).toBe("fast-chat");
    }
  });

  it("treats a large fenced code block as a complexity signal warranting the large model", () => {
    const codeBlock =
      "```\n" +
      Array.from({ length: 80 }, (_, i) => `function line${i}() { return ${i}; }`).join("\n") +
      "\n```";
    const result = selectModel({
      request: baseRequest({ messages: [userMsg("Review this code:\n" + codeBlock)] }),
      candidates: [FAST_CHAT, LARGE_CHAT],
      endpoint: "chat",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.modelId).toBe("large-chat");
      expect(result.reason).toBe("complexity:large");
    }
  });
});
