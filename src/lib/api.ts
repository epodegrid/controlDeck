const API_BASE_URL = process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    cache: "no-store",
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    throw new Error(`API ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

// Mirrors server/src/types.ts. Kept in sync by hand; the server is the source
// of truth for the shapes below.
export type Capability = "chat" | "vision" | "tools" | "embeddings";
export type ReplicaStatus = "ready" | "loading" | "busy" | "idle" | "error";
export type ModelClass = "large" | "fast" | "vision" | "embedding";
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

export type Replica = {
  id: string;
  modelId: string;
  status: ReplicaStatus;
  inFlight: number;
  loadPct: number;
  tokensPerSec: number | null;
};

export type ModelWithReplicas = {
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
  configSource: "gitops" | "override";
  hasOverride: boolean;
  replicas: Replica[];
};

export type Overview = {
  requestsPerMin: number;
  avgLatencyMs: number;
  tokensPerSec: number;
  activeReplicas: number;
  totalReplicas: number;
  queuedRequests: number;
  inFlightRequests: number;
  failuresLastHour: number;
  systemHealth: "green" | "yellow" | "red";
  totalRequests24h: number;
  spark: { label: string; value: number }[];
  queuedPreview: QueuedRequest[];
  inFlightPreview: InFlightRequest[];
  byCapability: { chat: number; tools: number; embeddings: number; vision: number };
  stallTimeoutRatePct: number;
};

export type QueuedRequest = {
  id: string;
  caller: string;
  team: string | null;
  model: string | null;
  capabilities: string[];
  arrivedAt: string;
  waitingSec: number;
  inputTokens?: number;
};

export type InFlightRequest = {
  id: string;
  caller: string;
  team: string | null;
  model: string | null;
  status: string;
  replicaId: string | null;
  arrivedAt: string;
  startedAt: string | null;
  inputTokens: number;
  outputTokensSoFar: number;
};

export type FailedRequest = {
  id: string;
  caller: string;
  team: string | null;
  model: string | null;
  requested_model: string | null;
  status: string;
  errorCode: string | null;
  arrivedAt: string;
  inputTokens: number;
};

export type CostBreakdownEntry = { key: string; tokens: number; requests: number; cost: number };
export type CostTimeseriesRow = { hour: string; tokensIn: string; tokensOut: string; cost: string; requests: string };
export type CostResponse = { breakdown: CostBreakdownEntry[]; timeseries: CostTimeseriesRow[]; period: string };

export type AuditEntry = {
  id: string;
  callerOid: string;
  callerName: string;
  team: string | null;
  requestedModel: string | null;
  routedModel: string | null;
  status: string;
  errorCode: string | null;
  inputTokens: number;
  outputTokens: number;
  arrivedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  costUsd: number | null;
  logged: boolean;
};

export type LoggingScopeRow = { scopeType: "global" | "team" | "model" | "key"; scopeKey: string; enabled: boolean };
export type ErrorSummaryRow = { errorCode: string; count: number };
export type SettingsConfig = {
  queueTimeoutMs: number;
  stallTimeoutMs: number;
  /** True when the router is running in sim mode (dev tokens, simulated data). */
  simMode: boolean;
  entraAudience: string;
  entraIssuer: string;
};

export const api = {
  getOverview: () => apiFetch<Overview>("/api/overview"),
  getModels: () => apiFetch<ModelWithReplicas[]>("/api/models"),
  setModelOverride: (id: string, fields: Record<string, unknown>) =>
    apiFetch<ModelWithReplicas>(`/api/models/${id}/override`, { method: "PATCH", body: JSON.stringify(fields) }),
  getQueuedRequests: () => apiFetch<QueuedRequest[]>("/api/requests?state=queued"),
  getInFlightRequests: () => apiFetch<InFlightRequest[]>("/api/requests?state=inflight"),
  getFailedRequests: () => apiFetch<FailedRequest[]>("/api/requests?state=failed"),
  getCost: (period: string, groupBy: "model" | "caller" = "model") =>
    apiFetch<CostResponse>(`/api/cost?period=${period}&groupBy=${groupBy}`),
  getAuditEntries: (params: Record<string, string> = {}) =>
    apiFetch<AuditEntry[]>(`/api/audit?${new URLSearchParams(params).toString()}`),
  getLoggingConfig: () => apiFetch<LoggingScopeRow[]>("/api/audit/logging-config"),
  getErrorSummary: () => apiFetch<ErrorSummaryRow[]>("/api/errors/summary"),
  getSettingsConfig: () => apiFetch<SettingsConfig>("/api/settings/config"),
  setLoggingScope: (scopeType: string, scopeKey: string, enabled: boolean) =>
    apiFetch(`/api/audit/logging-config`, { method: "PUT", body: JSON.stringify({ scopeType, scopeKey, enabled }) }),
  deleteAuditHistory: (olderThanDays: number) =>
    apiFetch<{ deletedRequests: number }>(`/api/audit/delete`, { method: "POST", body: JSON.stringify({ olderThanDays }) }),
};

export { API_BASE_URL };

/**
 * Runs an API call and returns a discriminated result instead of throwing.
 *
 * Server components that throw render the error boundary, which turns a
 * temporarily unreachable router into a blank page with no explanation. Pages
 * use this so they can tell the operator which of the two situations they are
 * looking at: no data yet, or no connection.
 */
export async function tryApi<T>(fn: () => Promise<T>): Promise<{ data: T; error: null } | { data: null; error: string }> {
  try {
    return { data: await fn(), error: null };
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : String(err) };
  }
}
