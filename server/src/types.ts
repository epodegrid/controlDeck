export type Capability = "chat" | "vision" | "tools" | "embeddings";
export type ModelClass = "large" | "fast" | "vision" | "embedding";
export type ReplicaStatus = "ready" | "loading" | "busy" | "idle" | "error";
export type CostBasis = "per_1k_tokens" | "per_request" | "per_compute_second";

export type RequestStatus =
  | "queued"
  | "routed"
  | "streaming"
  | "completed"
  | "queue_timeout"
  | "stall_timeout"
  | "replica_unavailable"
  | "capability_mismatch"
  | "auth_invalid"
  | "error";

export type ErrorCode =
  | "model_not_found"
  | "queue_timeout"
  | "stall_timeout"
  | "replica_unavailable"
  | "capability_mismatch"
  | "auth_invalid"
  | "invalid_request"
  // OpenAI's own code for a prompt that will not fit. Agents branch on this
  // exact string to decide when to compact their history, so returning the
  // generic invalid_request leaves them unable to tell "summarise and retry"
  // from "this request is malformed".
  | "context_length_exceeded";

export type StandardError = {
  error: {
    type: "invalid_request_error" | "auth_error" | "capacity_error" | "timeout_error";
    code: ErrorCode;
    message: string;
  };
};

export type Replica = {
  id: string;
  modelId: string;
  status: ReplicaStatus;
  inFlight: number;
  loadPct: number;
  tokensPerSec: number | null;
  /** This replica's own backend address; requests placed here go to it. */
  endpointUrl: string;
};

export type ModelConfig = {
  id: string;
  name: string;
  classLabel: string;
  modelClass: ModelClass;
  capabilities: Capability[];
  minReplicas: number;
  maxReplicas: number;
  systemPrompt: string;
  costValue: number;
  costBasis: CostBasis;
  endpointUrl: string;
  /**
   * Name the backend answers to. llama-swap routes on the `model` field in the
   * request body, and that name — plus its variant aliases — is the
   * container's, not necessarily the platform's. Defaults to the model id.
   */
  upstreamModel: string;
  /**
   * Which model's workload actually serves this entry.
   *
   * Normally the model's own id. It differs when several entries share one
   * container — the same loaded weights answering to several aliases — in
   * which case they all name the entry that owns the Deployment. Replicas,
   * placement, in-flight accounting and scaling are all keyed by this rather
   * than by `id`, because they are properties of the pod, not of the name.
   */
  backendModelId: string;
  /**
   * How the backend wants a system prompt delivered.
   *
   * `passthrough` sends the caller's message as written. `merge` folds it into
   * the first user turn, for chat templates with no system role — Gemma's has
   * none, and drops the message silently, so the model ignores its
   * instructions while every layer above reports success.
   */
  systemPromptMode: "passthrough" | "merge";
  /** Port the container listens on. Not every backend uses 8080. */
  port: number;
  /**
   * How long to wait for the first token before giving up. Distinct from the
   * stall clock, which §6.5 scopes to "once generation has started": a
   * llama-swap container loads weights on the first request, which for a large
   * GGUF takes minutes of silence that is not a stall.
   */
  firstTokenTimeoutMs: number | null;
  configSource: "gitops" | "override";
  hasOverride: boolean;
};

export type ChatMessage = {
  // `developer` is OpenAI's replacement for `system` on the reasoning models,
  // and clients targeting those send it instead. It is accepted here and
  // treated as a system message wherever the distinction matters.
  role: "system" | "developer" | "user" | "assistant" | "tool";
  /**
   * null on an assistant message that carries only tool_calls — the standard
   * shape of every multi-turn tool conversation.
   */
  content: string | Array<{ type: string; [key: string]: unknown }> | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
};

/**
 * The OpenAI chat-completion request. Everything beyond `messages` is
 * forwarded to the backend rather than dropped: a caller who sets temperature
 * for reproducibility, or max_tokens to bound cost, has to actually get it.
 */
export type ChatCompletionRequest = {
  model?: string;
  messages: ChatMessage[];
  tools?: unknown[];
  tool_choice?: unknown;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  seed?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  response_format?: unknown;
};

export type CallerIdentity = {
  oid: string;
  name: string;
  team?: string;
};
