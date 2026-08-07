import type { ReplicaStatus, Capability, RequestStatus } from "@/lib/api";

const replicaStyle: Record<ReplicaStatus, string> = {
  ready: "bg-status-green/15 text-status-green",
  busy: "bg-accent-2/20 text-accent-2-deep",
  loading: "bg-status-yellow/15 text-status-yellow",
  idle: "bg-gray-1 text-gray-2",
  error: "bg-status-red/15 text-status-red",
};

export function ReplicaStatusPill({ status }: { status: ReplicaStatus }) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-normal ${replicaStyle[status]}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${
        status === "ready" ? "bg-status-green live-dot"
        : status === "busy" ? "bg-status-yellow live-dot"
        : status === "loading" ? "bg-status-yellow live-dot"
        : status === "error" ? "bg-status-red" : "bg-gray-2"
      }`} />
      {status}
    </span>
  );
}

const reqStyle: Partial<Record<RequestStatus | string, string>> = {
  queued: "bg-status-yellow/15 text-status-yellow",
  routed: "bg-accent-2/20 text-accent-2-deep",
  streaming: "bg-accent-2/20 text-accent-2-deep",
  completed: "bg-status-green/10 text-status-green",
  queue_timeout: "bg-status-red/15 text-status-red",
  stall_timeout: "bg-status-red/15 text-status-red",
  replica_unavailable: "bg-status-red/15 text-status-red",
  capability_mismatch: "bg-status-yellow/15 text-status-yellow",
  auth_invalid: "bg-status-red/15 text-status-red",
  error: "bg-status-red/15 text-status-red",
};

const defaultReqStyle = "bg-gray-1 text-gray-2";

export function RequestStatusPill({ status }: { status: RequestStatus | (string & {}) }) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-normal ${reqStyle[status] ?? defaultReqStyle}`}>
      {status === "queued" || status === "streaming" || status === "routed" ? (
        <span className="w-1.5 h-1.5 rounded-full bg-current live-dot" />
      ) : null}
      {status}
    </span>
  );
}

const capColors: Record<Capability, string> = {
  chat: "bg-accent-2/20 text-accent-2-deep",
  vision: "bg-accent-2/20 text-accent-2-deep",
  tools: "bg-gray-1 text-ink/80",
  embeddings: "bg-gray-1 text-gray-2",
};

export function CapabilityBadge({ cap }: { cap: Capability }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-normal tracking-wide ${capColors[cap]}`}>
      {cap}
    </span>
  );
}
