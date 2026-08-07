import { SectionHeader } from "@/components/section-header";
import { KpiTile } from "@/components/kpi-tile";
import { RequestStatusPill, CapabilityBadge } from "@/components/status-pill";
import { api, tryApi, type QueuedRequest, type InFlightRequest, type FailedRequest } from "@/lib/api";
import { ConnectionError } from "@/components/empty-state";

function fmtElapsed(sec: number) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function QueuedRow({ req, index }: { req: QueuedRequest; index: number }) {
  return (
    <div
      className="grid grid-cols-12 gap-3 items-center px-4 py-3 border-b border-gray-1 last:border-0 transition bg-status-yellow/[0.04]"
      style={{ animation: `fade-in 600ms ${index * 60}ms cubic-bezier(.22,1,.36,1) both` }}
    >
      <div className="col-span-3 flex items-center gap-2">
        <span className="font-mono text-[12px]">{req.caller}</span>
      </div>
      <div className="col-span-2 font-mono text-[11px] text-gray-2">{req.model ?? "—"}</div>
      <div className="col-span-2 flex items-center gap-1 flex-wrap">
        {req.capabilities.map((c) => (
          <CapabilityBadge key={c} cap={c as never} />
        ))}
      </div>
      <div className="col-span-2 font-mono text-[11px] truncate">
        <span className="text-gray-3">—</span>
      </div>
      <div className="col-span-2">
        <RequestStatusPill status="queued" />
      </div>
      <div className="col-span-1 text-right">
        <span className="font-mono text-[11px] text-status-yellow tabular-nums">
          {fmtElapsed(req.waitingSec ?? 0)}
        </span>
      </div>
    </div>
  );
}

export default async function RequestsPage() {
  const [queued, inFlight, failures, settings] = await Promise.all([
    tryApi(() => api.getQueuedRequests()),
    tryApi(() => api.getInFlightRequests()),
    tryApi(() => api.getFailedRequests()),
    tryApi(() => api.getSettingsConfig()),
  ]);

  const error = queued.error ?? inFlight.error ?? failures.error;
  const queuedRequests = queued.data ?? [];
  const inFlightRequests = inFlight.data ?? [];
  const recentFailures = failures.data ?? [];

  // Timeout policy is read from the router rather than written into the page,
  // so these labels can never drift from the values actually enforced (§6.5).
  const queueTimeoutLabel = settings.data ? `${Math.round(settings.data.queueTimeoutMs / 60000)}m` : "—";
  const stallTimeoutLabel = settings.data ? `${Math.round(settings.data.stallTimeoutMs / 1000)}s` : "—";

  const totalQueued = queuedRequests.length;
  const totalInFlight = inFlightRequests.length;
  const oldestWait = queuedRequests.reduce((acc, r) => Math.max(acc, r.waitingSec ?? 0), 0);

  return (
    <div className="p-6 md:p-10 max-w-[1400px] mx-auto ambient-wash">
      <SectionHeader
        tag="Requests"
        title={
          <>
            Requests &<br />
            <span className="text-gray-2">queue, live.</span>
          </>
        }
        description="In-flight and queued requests. Queued requests are highlighted yellow while unprocessed; once a replica accepts the request it transitions to routed → streaming → completed. Mid-stream failures emit a proper SSE error event before closing."
      />

      {error ? (
        <div className="mb-8">
          <ConnectionError detail={error} />
        </div>
      ) : null}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-10">
        <KpiTile label="Queued" value={totalQueued} hint="unprocessed" />
        <KpiTile label="Oldest wait" value={fmtElapsed(oldestWait)} />
        <KpiTile label="In flight" value={totalInFlight} />
        <KpiTile label="Failures · 5m" value={recentFailures.length} hint="across replicas" />
      </div>

      <div className="grid grid-cols-12 gap-6 mb-8">
        <div className="col-span-12 lg:col-span-7 rounded-3xl bg-card shadow-soft-2 overflow-hidden lift">
          <div className="relative">
            <div
              className="absolute inset-x-0 top-0 h-px"
              style={{ background: "linear-gradient(90deg, transparent, rgba(234,179,8,.7), transparent)" }}
            />
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-1 bg-status-yellow/[0.06]">
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-status-yellow live-dot" />
                <h3 className="text-[14px] font-normal">Queued</h3>
                <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-status-yellow/20 text-status-yellow">
                  UNPROCESSED
                </span>
              </div>
              <span className="text-[11px] text-gray-2">queue-wait timeout: {queueTimeoutLabel}</span>
            </div>
          </div>
          <div className="grid grid-cols-12 gap-3 px-4 py-2.5 text-[10px] uppercase tracking-wider text-gray-2 font-normal border-b border-gray-1 bg-gray-1/40">
            <div className="col-span-3">Caller</div>
            <div className="col-span-2">Target</div>
            <div className="col-span-2">Capabilities</div>
            <div className="col-span-2">Replica</div>
            <div className="col-span-2">Status</div>
            <div className="col-span-1 text-right">Wait</div>
          </div>
          {queuedRequests.length === 0 ? (
            <div className="px-5 py-8 text-center text-[12px] text-gray-2">No requests currently queued.</div>
          ) : (
            queuedRequests.map((r, i) => <QueuedRow key={r.id} req={r} index={i} />)
          )}
        </div>

        <div className="col-span-12 lg:col-span-5 rounded-3xl bg-card shadow-soft-2 overflow-hidden lift">
          <div className="relative">
            <div
              className="absolute inset-x-0 top-0 h-px"
              style={{ background: "linear-gradient(90deg, transparent, rgba(201,243,28,.7), transparent)" }}
            />
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-1">
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-accent live-dot" />
                <h3 className="text-[14px] font-normal">In flight</h3>
                <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-accent/40 text-ink">BUSY</span>
              </div>
              <span className="text-[11px] text-gray-2">stall-watch: {stallTimeoutLabel}</span>
            </div>
          </div>
          <div className="grid grid-cols-12 gap-3 px-4 py-2.5 text-[10px] uppercase tracking-wider text-gray-2 font-normal border-b border-gray-1 bg-gray-1/40">
            <div className="col-span-4">Caller</div>
            <div className="col-span-3">Replica</div>
            <div className="col-span-3">Status</div>
            <div className="col-span-2 text-right">Tokens</div>
          </div>
          {inFlightRequests.length === 0 ? (
            <div className="px-5 py-8 text-center text-[12px] text-gray-2">No requests currently in flight.</div>
          ) : (
            inFlightRequests.map((r: InFlightRequest, i) => (
              <div
                key={r.id}
                className="grid grid-cols-12 gap-3 items-center px-4 py-3 border-b border-gray-1 last:border-0 hover:bg-gray-1/40 transition"
                style={{ animation: `fade-in 600ms ${i * 60}ms cubic-bezier(.22,1,.36,1) both` }}
              >
                <div className="col-span-4">
                  <p className="font-mono text-[12px]">{r.caller}</p>
                  <p className="text-[10px] text-gray-2 font-mono truncate">{r.model}</p>
                </div>
                <div className="col-span-3 font-mono text-[11px] truncate">
                  {r.replicaId ?? <span className="text-gray-3">—</span>}
                </div>
                <div className="col-span-3">
                  <RequestStatusPill status={r.status} />
                </div>
                <div className="col-span-2 text-right">
                  {r.outputTokensSoFar > 0 ? (
                    <div>
                      <p className="font-mono text-[11px]">{r.outputTokensSoFar}</p>
                      <p className="text-[9px] text-gray-2">emitted</p>
                    </div>
                  ) : (
                    <span className="font-mono text-[11px] text-gray-2">—</span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="rounded-3xl bg-card shadow-soft-2 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-1">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-status-red" />
            <h3 className="text-[14px] font-normal">Recent failures</h3>
          </div>
          <span className="text-[11px] text-gray-2">last 5 min</span>
        </div>
        <div className="grid grid-cols-12 gap-3 px-4 py-2.5 text-[10px] uppercase tracking-wider text-gray-2 font-normal border-b border-gray-1 bg-gray-1/40">
          <div className="col-span-2">Caller</div>
          <div className="col-span-3">Target model</div>
          <div className="col-span-3">Error code</div>
          <div className="col-span-2">Occurred</div>
          <div className="col-span-2 text-right">Request</div>
        </div>
        {recentFailures.length === 0 ? (
          <div className="px-5 py-8 text-center text-[12px] text-gray-2">No recent failures.</div>
        ) : (
          recentFailures.map((r: FailedRequest, i) => {
            const ago = Math.floor((Date.now() - new Date(r.arrivedAt).getTime()) / 1000);
            return (
              <div
                key={r.id}
                className="grid grid-cols-12 gap-3 items-center px-4 py-3 border-b border-gray-1 last:border-0 hover:bg-gray-1/40 transition"
                style={{ animation: `fade-in 600ms ${i * 60}ms cubic-bezier(.22,1,.36,1) both` }}
              >
                <div className="col-span-2 font-mono text-[12px]">{r.caller}</div>
                <div className="col-span-3 font-mono text-[11px] text-gray-2">{r.model ?? r.requested_model ?? "—"}</div>
                <div className="col-span-3">
                  <RequestStatusPill status={r.status} />
                </div>
                <div className="col-span-2 font-mono text-[11px] text-gray-2">{fmtElapsed(ago)} ago</div>
                <div className="col-span-2 text-right font-mono text-[11px] text-gray-2">{r.id}</div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
