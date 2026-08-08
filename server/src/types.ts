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
  | "invalid_request";

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
  configSource: "gitops" | "override";
  hasOverride: boolean;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
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
