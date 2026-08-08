export type ChatToken = { token: string; done: boolean };

/**
 * Everything the gateway passes through to the model server. The sampling
 * fields are the caller's, forwarded verbatim — the gateway has no opinion on
 * them and must not silently substitute its own.
 */
export type StreamChatParams = {
  endpointUrl: string;
  messages: Array<{ role: string; content: unknown }>;
  systemPrompt?: string;
  /** Forwarded verbatim; llama-swap owns the tool-calling handling (§6.12). */
  tools?: unknown[];
  toolChoice?: unknown;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string | string[];
  seed?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  responseFormat?: unknown;
};

export interface LlamaSwapClient {
  checkReady(endpointUrl: string): Promise<boolean>;
  streamChat(params: StreamChatParams): AsyncGenerator<ChatToken>;
  embed(params: { endpointUrl: string; input: string | string[] }): Promise<number[][]>;
}

/**
 * Real client talks to a llama-swap instance's OpenAI-compatible HTTP surface.
 * Not exercised in tests/local dev without a live model backend — use
 * FakeLlamaSwapClient (below) when USE_FAKE_ADAPTERS=true.
 */
export class HttpLlamaSwapClient implements LlamaSwapClient {
  async checkReady(endpointUrl: string): Promise<boolean> {
    try {
      const res = await fetch(`${endpointUrl}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async *streamChat(params: StreamChatParams): AsyncGenerator<ChatToken> {
    // PRD §6.11 — the per-model system prompt is a *default*, not an override.
    // If the caller sent their own system message we leave it authoritative
    // and inject nothing.
    const callerSetSystemPrompt = params.messages.some((m) => m.role === "system");
    const messages =
      params.systemPrompt && !callerSetSystemPrompt
        ? [{ role: "system", content: params.systemPrompt }, ...params.messages]
        : params.messages;

    const res = await fetch(`${params.endpointUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages,
        stream: true,
        // §6.12 is explicit that tool calling is a pass-through of the
        // backend's own handling. Dropping these was silently worse than
        // rejecting them: the router filters on the `tools` capability and
        // routes to a model that supports them, then removes the tools, so the
        // caller gets a plain answer and no indication why.
        ...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
        ...(params.toolChoice !== undefined ? { tool_choice: params.toolChoice } : {}),
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        ...(params.topP !== undefined ? { top_p: params.topP } : {}),
        ...(params.maxTokens !== undefined ? { max_tokens: params.maxTokens } : {}),
        ...(params.stop !== undefined ? { stop: params.stop } : {}),
        ...(params.seed !== undefined ? { seed: params.seed } : {}),
        ...(params.presencePenalty !== undefined ? { presence_penalty: params.presencePenalty } : {}),
        ...(params.frequencyPenalty !== undefined ? { frequency_penalty: params.frequencyPenalty } : {}),
        ...(params.responseFormat !== undefined ? { response_format: params.responseFormat } : {}),
      }),
    });
    if (!res.ok) {
      // Surface the backend's standardized error instead of silently yielding
      // an empty stream — the router turns a throw here into a proper SSE
      // error event / replica_unavailable (PRD §6.6).
      const detail = await res.text().catch(() => "");
      throw new Error(`Model backend returned ${res.status}: ${detail.slice(0, 300)}`);
    }
    if (!res.body) {
      yield { token: "", done: true };
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          yield { token: "", done: true };
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const token = parsed.choices?.[0]?.delta?.content ?? "";
          if (token) yield { token, done: false };
        } catch {
          // ignore malformed keep-alive lines
        }
      }
    }
    yield { token: "", done: true };
  }

  async embed(params: { endpointUrl: string; input: string | string[] }): Promise<number[][]> {
    const res = await fetch(`${params.endpointUrl}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: params.input }),
    });
    const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
    return json.data.map((d) => d.embedding);
  }
}

/** In-memory fake used for local dev (USE_FAKE_ADAPTERS=true) and demos without a real model backend. */
export class FakeLlamaSwapClient implements LlamaSwapClient {
  async checkReady(): Promise<boolean> {
    return true;
  }

  async *streamChat(params: StreamChatParams): AsyncGenerator<ChatToken> {
    const lastUser = [...params.messages].reverse().find((m) => m.role === "user");
    const prompt = typeof lastUser?.content === "string" ? lastUser.content : "your request";
    const reply = `This is a simulated response from the fake llama-swap adapter for: "${prompt.slice(0, 80)}". Configure USE_FAKE_ADAPTERS=false and a real llama-swap endpoint to get live model output.`;
    const words = reply.split(" ");
    for (const word of words) {
      await new Promise((r) => setTimeout(r, 15));
      yield { token: word + " ", done: false };
    }
    yield { token: "", done: true };
  }

  async embed(params: { input: string | string[] }): Promise<number[][]> {
    const inputs = Array.isArray(params.input) ? params.input : [params.input];
    return inputs.map((text) => {
      const seed = Array.from(text).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
      return Array.from({ length: 16 }, (_, i) => Math.sin(seed + i) * 0.5);
    });
  }
}

/**
 * Chooses the model backend. `MODEL_BACKEND` is the explicit control:
 *
 *   http — talk to real endpoints over the wire (a live llama-swap, or the
 *          mock-model containers in docker-compose / minikube)
 *   fake — in-process stub, no network at all
 *
 * When unset it falls back to the dev-auth flag, which is what the unit tests
 * rely on. These are separate axes on purpose: local dev wants dev-minted
 * tokens (no Entra tenant) *and* real HTTP model calls, which the single
 * old flag could not express.
 */
export function createLlamaSwapClient(): LlamaSwapClient {
  const backend = process.env.MODEL_BACKEND;
  if (backend === "http") return new HttpLlamaSwapClient();
  if (backend === "fake") return new FakeLlamaSwapClient();
  return process.env.USE_FAKE_ADAPTERS === "true" ? new FakeLlamaSwapClient() : new HttpLlamaSwapClient();
}
