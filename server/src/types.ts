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
  content: string | Array<{ type: string; [key: string]: unknown }>;
};

export type ChatCompletionRequest = {
  model?: string;
  messages: ChatMessage[];
  tools?: unknown[];
  tool_choice?: unknown;
  stream?: boolean;
};

export type CallerIdentity = {
  oid: string;
  name: string;
  team?: string;
};
