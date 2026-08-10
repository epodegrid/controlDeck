"use client";

import { useState } from "react";
import { ReplicaStatusPill } from "@/components/status-pill";
import type { ModelWithReplicas, Replica, ErrorSummaryRow } from "@/lib/api";
import { LogTail } from "./log-tail";

type ReplicaWithModel = Replica & { modelName: string };

const ERROR_COLOR: Record<string, string> = {
  auth_invalid: "bg-status-red",
  capability_mismatch: "bg-status-yellow",
  replica_unavailable: "bg-status-red",
  stall_timeout: "bg-status-red",
  queue_timeout: "bg-status-yellow",
  error: "bg-status-red",
};

export function MonitoringView({ models, errorSummary }: { models: ModelWithReplicas[]; errorSummary: ErrorSummaryRow[] }) {
  const allReplicas: ReplicaWithModel[] = models.flatMap((m) =>
    m.replicas.map((r) => ({ ...r, modelName: m.name }))
  );
  const [selectedId, setSelectedId] = useState<string | undefined>(allReplicas[0]?.id);
  const activeReplica = allReplicas.find((r) => r.id === selectedId) ?? allReplicas[0];

  return (
    <div className="grid grid-cols-12 gap-6">
      <aside className="col-span-12 lg:col-span-3 space-y-4">
        {models.map((m) => (
          <div key={m.id} className="rounded-3xl bg-card shadow-soft-2 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-1">
              <p className="text-[10px] uppercase tracking-wider text-gray-2 font-medium">{m.classLabel}</p>
              <h3 className="text-[13px] font-normal mt-0.5">{m.name}</h3>
            </div>
            <div className="p-2 space-y-1">
              {m.replicas.map((r) => {
                const isActive = activeReplica?.id === r.id;
                return (
                  <button
                    key={r.id}
                    onClick={() => setSelectedId(r.id)}
                    className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left transition lift ${
                      isActive ? "bg-accent-2/20 ring-1 ring-accent-2" : "hover:bg-gray-1"
                    }`}
                  >
                    <ReplicaStatusPill status={r.status} />
                    <span className="font-mono text-[11px] truncate flex-1">{r.id}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </aside>

      <section className="col-span-12 lg:col-span-9 space-y-4">
        <div className="rounded-3xl bg-card shadow-soft-2 p-5 fade-in-1">
          {activeReplica ? (
            <>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <ReplicaStatusPill status={activeReplica.status} />
                  <div>
                    <p className="font-mono text-[13px] font-normal">{activeReplica.id}</p>
                    <p className="text-[11px] text-gray-2">
                      {activeReplica.modelName} ·{" "}
                      {activeReplica.tokensPerSec ? `${activeReplica.tokensPerSec.toFixed(1)} tps` : "warming"}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-[11px]">
                  <button className="px-2.5 py-1 rounded-md bg-gray-1 text-gray-2 hover:text-ink transition">stderr</button>
                  <button className="px-2.5 py-1 rounded-md bg-ink text-paper transition">stdout</button>
                  <span className="px-2.5 py-1 rounded-md bg-status-green/15 text-status-green font-mono flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-status-green live-dot" />
                    live · tailing
                  </span>
                </div>
              </div>

              <div className="rounded-2xl bg-ink overflow-hidden shadow-float">
                <div className="flex items-center gap-1.5 px-4 py-2 border-b border-white/10">
                  <span className="w-2.5 h-2.5 rounded-full bg-status-red" />
                  <span className="w-2.5 h-2.5 rounded-full bg-status-yellow" />
                  <span className="w-2.5 h-2.5 rounded-full bg-status-green" />
                  <span className="ml-3 text-[11px] text-white/40 font-mono">
                    kubectl logs -f {activeReplica.id} -n llm-gateway
                  </span>
                </div>
                <LogTail replicaId={activeReplica.id} />
              </div>
            </>
          ) : (
            <p className="text-[12px] text-gray-2 py-10 text-center">No replicas available.</p>
          )}
        </div>

        <style>{`
          @keyframes blink { 0%, 50% { opacity: 1 } 50.01%, 100% { opacity: 0 } }
        `}</style>

        <div className="grid grid-cols-3 gap-4">
          <SmallStat
            label="CPU"
            value={formatCpu(activeReplica?.cpuMillicores ?? null)}
            hint={
              activeReplica?.cpuMillicores == null
                ? "needs metrics-server in the cluster"
                : "current usage"
            }
          />
          <SmallStat
            label="Memory"
            value={formatMemory(activeReplica?.memoryBytes ?? null)}
            hint={
              activeReplica?.memoryBytes == null
                ? "needs metrics-server in the cluster"
                : "resident"
            }
          />
          <SmallStat
            label="Restart count"
            value={activeReplica ? String(activeReplica.restartCount) : "—"}
            hint={
              activeReplica && activeReplica.restartCount > 0
                ? "this replica has restarted"
                : "since the pod was created"
            }
          />
        </div>

        <div className="rounded-3xl bg-card shadow-soft-2 p-5">
          <h3 className="text-[14px] font-normal mb-4">Error summary</h3>
          {errorSummary.length === 0 ? (
            <p className="text-[12px] text-gray-2 py-4 text-center">No errors in the last 24h.</p>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {errorSummary.map((e, i) => (
                <div
                  key={e.errorCode}
                  className="rounded-2xl border border-gray-1 p-3 lift fade-in"
                  style={{ animationDelay: `${i * 70}ms` }}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`w-1.5 h-1.5 rounded-full ${ERROR_COLOR[e.errorCode] ?? "bg-gray-2"} ${e.count > 0 ? "live-dot" : ""}`} />
                    <p className="font-mono text-[11px] text-gray-2">{e.errorCode}</p>
                  </div>
                  <p className="display-stat text-[24px] font-normal">{e.count}</p>
                  <p className="text-[10px] text-gray-2 mt-0.5">last 24h</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

/** Millicores in, something a person reads out. */
function formatCpu(millicores: number | null): string {
  if (millicores == null) return "—";
  if (millicores < 1000) return `${Math.round(millicores)}m`;
  return `${(millicores / 1000).toFixed(2)} cores`;
}

function formatMemory(bytes: number | null): string {
  if (bytes == null) return "—";
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${gib.toFixed(1)} GiB`;
  return `${Math.round(bytes / 1024 ** 2)} MiB`;
}

function SmallStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl bg-card shadow-soft-2 p-4 lift">
      <p className="text-[10px] uppercase tracking-wider text-gray-2 font-medium">{label}</p>
      <p className="display-stat text-[22px] font-normal mt-1">{value}</p>
      {hint ? <p className="text-[10px] text-gray-2 mt-0.5">{hint}</p> : null}
    </div>
  );
}
