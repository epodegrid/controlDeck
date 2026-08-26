/**
 * One `tool_calls` entry from a streaming delta. Arguments arrive in fragments
 * across many frames, so `function.arguments` is a partial string until the
 * stream ends — which is why these are forwarded verbatim rather than
 * interpreted.
 */
export type ToolCallDelta = {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

/**
 * An error response from the model backend, with its status preserved.
 *
 * The status is the whole point. A 4xx is the caller's request being wrong —
 * a prompt longer than the context window, most often — and retrying it will
 * fail identically forever. A 5xx or a dropped connection is the replica
 * being unwell, which is worth retrying elsewhere. Collapsing both into one
 * "replica unavailable" told agent clients to retry a request that could never
 * succeed: opencode re-sent an over-long prompt nine times with backoff before
 * giving up, and the gateway reported a capacity problem it did not have.
 */
export class BackendError extends Error {
  constructor(
    readonly status: number,
    readonly body: string
  ) {
    super(`Model backend returned ${status}: ${BackendError.summarise(body)}`);
    this.name = "BackendError";
  }

  /**
   * The backend's own sentence, not its JSON envelope.
   *
   * These messages are read by people and matched by agents, and
   * `{"error":{"code":400,"message":"request (40013 tokens) exceeds…` buries
   * the part that says what went wrong inside two levels of wrapper.
   */
  static summarise(body: string): string {
    try {
      const parsed = JSON.parse(body);
      const message = parsed?.error?.message ?? parsed?.message ?? parsed?.error;
      if (typeof message === "string" && message.trim()) return message.slice(0, 300);
    } catch {
      // Not JSON; the raw body is the best available.
    }
    return body.slice(0, 300);
  }

  /** True when the request itself is at fault and retrying cannot help. */
  get isCallerError(): boolean {
    return this.status >= 400 && this.status < 500;
  }

  /**
   * True when the prompt did not fit the model's context window.
   *
   * Detected from the body rather than the status, because every backend
   * spells it differently: llama.cpp raises `exceed_context_size_error`, vLLM
   * and others describe it in prose. Both shapes are matched so the caller
   * gets a code it can act on either way.
   */
  get isContextOverflow(): boolean {
    const body = this.body.toLowerCase();

    // Named codes, where a backend provides one.
    if (body.includes("exceed_context_size_error")) return true; // llama.cpp
    if (body.includes("context_length_exceeded")) return true; // OpenAI, and clones

    // Otherwise it is prose, and every backend words it differently. vLLM says
    // "This model's maximum context length is 8192 tokens. However, your
    // messages resulted in 9000 tokens." — which contains none of the verbs a
    // naive matcher looks for, so the phrases are matched too.
    if (body.includes("maximum context length")) return true;
    if (body.includes("context window")) return true;

    return (
      (body.includes("context") || body.includes("n_ctx")) &&
      (body.includes("exceed") ||
        body.includes("too long") ||
        body.includes("larger than") ||
        body.includes("reduce the length"))
    );
  }
}

/** Token counts as the backend actually measured them. */
export type UpstreamUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type ChatToken = {
  token: string;
  done: boolean;
  /**
   * A thinking model's visible reasoning, carried by llama.cpp as
   * `reasoning_content` rather than `content`. Forwarded separately so the
   * caller can render or hide it, and so it is never mistaken for the answer.
   */
  reasoning?: string;
  /**
   * Tool calls the model is making. The whole point of an agent client — an
   * answer without these is a model that appears to refuse to use its tools.
   */
  toolCalls?: ToolCallDelta[];
  /** Upstream's own reason, notably "tool_calls". Present on the done frame. */
  finishReason?: string | null;
  /**
   * The backend's own token counts, when it reports them. Present on the done
   * frame.
   *
   * These matter beyond billing: an agent decides when to compact its history
   * from `usage.prompt_tokens`, so a number the gateway invented rather than
   * measured leads it to run out of context instead of summarising in time.
   */
  usage?: UpstreamUsage;
};

/**
 * Everything the gateway passes through to the model server. The sampling
 * fields are the caller's, forwarded verbatim — the gateway has no opinion on
 * them and must not silently substitute its own.
 */
export type StreamChatParams = {
  endpointUrl: string;
  /**
   * The name the backend answers to. llama-swap selects which process to proxy
   * to entirely from this field, so omitting it leaves a multi-model container
   * with nothing to route on.
   */
  model?: string;
  messages: Array<{ role: string; content: unknown }>;
  systemPrompt?: string;
  /**
   * `merge` folds system messages into the first user turn. Needed for chat
   * templates with no system role — Gemma's has none — where the message is
   * otherwise dropped and the model ignores its instructions while every layer
   * above reports success.
   */
  systemPromptMode?: "passthrough" | "merge";
  /**
   * Aborts the upstream request.
   *
   * §6.5's timeouts previously only wrote to the database: the row said
   * `stall_timeout` while the connection stayed open and the caller waited on
   * a model that might never answer. The audit trail and reality disagreed,
   * and the caller's own client eventually gave up with no explanation.
   */
  signal?: AbortSignal;
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

/**
 * Folds system messages into the first user turn.
 *
 * For templates that have no system role. Kept as a plain transformation of
 * the message list rather than a string concatenation at the call site,
 * because the caller's system prompt can be several thousand tokens and its
 * ordering relative to the conversation matters.
 *
 * `developer` counts as a system message here for the same reason it does
 * everywhere else: it is what clients targeting OpenAI's reasoning models
 * send in its place.
 */
export function mergeSystemIntoFirstUser(
  messages: Array<{ role: string; content: unknown }>
): Array<{ role: string; content: unknown }> {
  const isSystem = (r: string) => r === "system" || r === "developer";
  const text = (c: unknown) => (typeof c === "string" ? c : c == null ? "" : JSON.stringify(c));

  const preamble = messages.filter((m) => isSystem(m.role)).map((m) => text(m.content)).join("\n\n");
  if (!preamble) return messages;

  const rest = messages.filter((m) => !isSystem(m.role));
  const firstUser = rest.findIndex((m) => m.role === "user");

  // No user turn to merge into — a tools-only or assistant-prefixed exchange.
  // Prepending one is better than dropping the instructions entirely.
  if (firstUser === -1) return [{ role: "user", content: preamble }, ...rest];

  return rest.map((m, i) =>
    i === firstUser ? { ...m, content: `${preamble}\n\n${text(m.content)}` } : m
  );
}

export interface LlamaSwapClient {
  checkReady(endpointUrl: string): Promise<boolean>;
  streamChat(params: StreamChatParams): AsyncGenerator<ChatToken>;
  embed(params: { endpointUrl: string; input: string | string[]; model?: string }): Promise<number[][]>;
}

/**
 * Builds the exact request body sent to the model server.
 *
 * Extracted so the dry-run diagnostic returns the same bytes the real path
 * sends, rather than a reconstruction that can drift from it. "Is the gateway
 * dropping my system prompt, or is the model ignoring it?" has needed a packet
 * capture to answer twice now; it should need one curl.
 */
export function buildChatRequestBody(params: StreamChatParams): Record<string, unknown> {
  // PRD §6.11 — the per-model system prompt is a *default*, not an override.
  // If the caller sent their own system message we leave it authoritative
  // and inject nothing.
  //
  // Agent tools (opencode, Copilot, Hermes and friends) send a carefully
  // built system prompt describing their tools and output contract. Prefixing
  // the operator's default in front of it gives the model two sets of
  // instructions, and the platform's — being first — tends to win in most
  // chat templates. That breaks the caller's tool loop in ways that look like
  // the model misbehaving.
  //
  // `developer` counts too: it is what OpenAI's reasoning models use in place
  // of `system`, so a client targeting those would otherwise get the default
  // injected alongside its own instructions.
  //
  // Whitespace-only content does not count. A client that sends
  // `{role: "system", content: ""}` as a placeholder has expressed no
  // intention, and honouring it would silently discard the operator's
  // configured prompt.
  const callerSetSystemPrompt = params.messages.some(
    (m) =>
      (m.role === "system" || m.role === "developer") &&
      (typeof m.content === "string" ? m.content.trim() !== "" : m.content != null)
  );
  const messages =
    params.systemPrompt && !callerSetSystemPrompt
      ? [{ role: "system", content: params.systemPrompt }, ...params.messages]
      : params.messages;

  const outgoing =
    params.systemPromptMode === "merge" ? mergeSystemIntoFirstUser(messages) : messages;

  return {
    ...(params.model ? { model: params.model } : {}),
    messages: outgoing,
    stream: true,
    // Without this a streaming response carries no usage at all, and the
    // gateway is left guessing at token counts it could simply be told.
    stream_options: { include_usage: true },
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
  };
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
    const requestBody = buildChatRequestBody(params);

    const res = await fetch(`${params.endpointUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (!res.ok) {
      // Surface the backend's standardized error instead of silently yielding
      // an empty stream — the router turns a throw here into a proper SSE
      // error event / replica_unavailable (PRD §6.6).
      const detail = await res.text().catch(() => "");
      throw new BackendError(res.status, detail);
    }
    if (!res.body) {
      yield { token: "", done: true };
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let finishReason: string | null = null;
    let usage: UpstreamUsage | undefined;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          yield { token: "", done: true, finishReason, usage };
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;

          // The usage frame carries no choices, so it must be read before
          // anything reaches into delta.
          if (parsed.usage && typeof parsed.usage.prompt_tokens === "number") {
            usage = {
              prompt_tokens: parsed.usage.prompt_tokens,
              completion_tokens: parsed.usage.completion_tokens ?? 0,
              total_tokens:
                parsed.usage.total_tokens ??
                parsed.usage.prompt_tokens + (parsed.usage.completion_tokens ?? 0),
            };
          }

          const token = delta?.content ?? "";
          const reasoning = delta?.reasoning_content ?? "";
          const toolCalls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : null;

          // Captured for the done frame. An agent client branches on this:
          // "tool_calls" means run the tools and come back, "stop" means the
          // turn is over. Reporting "stop" for a turn that made tool calls
          // ends the loop before it starts.
          if (typeof parsed.choices?.[0]?.finish_reason === "string") {
            finishReason = parsed.choices[0].finish_reason;
          }

          // llama-swap's own progress banner, emitted while it loads a model
          // on demand when sendLoadingState is set. It arrives as
          // reasoning_content deltas indistinguishable from a thinking model's
          // output except for what is *missing*: no id, object or model,
          // because no model has produced them.
          //
          // It must not reach the caller as output, be counted as generated
          // tokens, or land in the audit content log — it is a status message
          // from the proxy.
          //
          // Scoped to reasoning-only frames on purpose. Requiring an id of
          // every frame would silently discard the entire response from any
          // backend that omits one, which is a far worse failure than letting
          // a progress banner through.
          const fromModel = typeof parsed.id === "string" && parsed.id.length > 0;
          if (reasoning && !token && !fromModel) continue;
          // Reasoning is progress too. Dropping it left a thinking model
          // looking dead to the caller for the whole of its thinking phase,
          // and starved the stall clock of the evidence that it was working.
          // Forwarded before content, because a frame can legitimately carry
          // both and the tool call is the part that must not be lost.
          if (toolCalls) yield { token: "", done: false, toolCalls };
          if (token) yield { token, done: false };
          else if (reasoning && !toolCalls) yield { token: "", done: false, reasoning };
        } catch {
          // ignore malformed keep-alive lines
        }
      }
    }
    yield { token: "", done: true, finishReason, usage };
  }

  async embed(params: { endpointUrl: string; input: string | string[]; model?: string }): Promise<number[][]> {
    const res = await fetch(`${params.endpointUrl}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Same reason as chat: a multi-model embedding service picks the model
      // from this field.
      body: JSON.stringify({ ...(params.model ? { model: params.model } : {}), input: params.input }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new BackendError(res.status, detail);
    }
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
    yield { token: "", done: true, finishReason: "stop" };
  }

  async embed(params: { input: string | string[]; model?: string }): Promise<number[][]> {
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
