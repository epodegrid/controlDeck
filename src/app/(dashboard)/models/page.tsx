import Link from "next/link";
import { SectionHeader } from "@/components/section-header";
import { KpiTile } from "@/components/kpi-tile";
import { ReplicaStatusPill, CapabilityBadge } from "@/components/status-pill";
import { api, tryApi } from "@/lib/api";
import { EmptyState, ConnectionError } from "@/components/empty-state";

export default async function ModelsPage() {
  const { data: models, error } = await tryApi(() => api.getModels());
  const totalReplicas = models?.reduce((acc, m) => acc + m.replicas.length, 0) ?? 0;

  return (
    <div className="p-6 md:p-10 max-w-[1400px] mx-auto ambient-wash">
      <SectionHeader
        tag="Models"
        title={
          <>
            Registered <span className="text-gray-2">models.</span>
          </>
        }
        description="Per-model replica state, capability flags, and config-source. Helm-managed base config is overlaid with any dashboard edits at read time; the override column tells you what changed."
      />

      {error ? <ConnectionError detail={error} /> : null}

      {models && models.length === 0 ? (
        <EmptyState
          title="No models registered"
          description="Models are registered through the Helm values file and deployed by your GitOps pipeline. Once a model is deployed, its replicas appear here automatically as they pass their readiness probe."
          hint="helm upgrade --install controldeck ./helm/controldeck"
        />
      ) : null}

      {models && models.length > 0 ? (
      <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-10">
        <KpiTile label="Models" value={models.length} />
        <KpiTile label="Replicas" value={totalReplicas} hint="across cluster" />
        <KpiTile label="Overrides" value={models.filter((m) => m.hasOverride).length} hint="dashboard edits" />
        <KpiTile label="KEDA targets" value={models.length} hint="all autoscaling" />
      </div>

      <div className="space-y-5">
        {models.map((m, i) => {
          const ready = m.replicas.filter((r) => r.status === "ready" || r.status === "busy").length;
          return (
            <div
              key={m.id}
              className="rounded-3xl bg-card shadow-soft-2 overflow-hidden fade-in lift"
              style={{ animationDelay: `${i * 80}ms` }}
            >
              <div className="relative">
                <div
                  className="absolute inset-x-0 top-0 h-px"
                  style={{
                    background: i === 0
                      ? "linear-gradient(90deg, transparent, rgba(201,243,28,.7), transparent)"
                      : i === 1
                      ? "linear-gradient(90deg, transparent, rgba(147,180,250,.7), transparent)"
                      : "linear-gradient(90deg, transparent, rgba(0,0,0,.12), transparent)",
                  }}
                />
                <div className="flex items-center gap-6 px-6 py-5 border-b border-gray-1">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <p className="text-[11px] uppercase tracking-wider text-gray-2 font-medium">{m.classLabel}</p>
                      {m.configSource === "override" && (
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-status-yellow/20 text-status-yellow">
                          DASHBOARD OVERRIDE
                        </span>
                      )}
                    </div>
                    <h3 className="text-[22px] font-normal leading-tight">{m.name}</h3>
                    <p className="text-[11px] font-mono text-gray-2 mt-0.5">
                      {m.id}
                      {m.backendModelId !== m.id && (
                        <>
                          {" · served by "}
                          <span className="text-gray-3">{m.backendModelId}</span>
                        </>
                      )}
                      {m.upstreamModel !== m.id && (
                        <>
                          {" · upstream "}
                          <span className="text-gray-3">{m.upstreamModel}</span>
                        </>
                      )}
                    </p>
                  </div>

                  <div className="flex items-center gap-1.5">
                    {m.capabilities.map((c) => (
                      <CapabilityBadge key={c} cap={c} />
                    ))}
                  </div>

                  <div className="text-right shrink-0">
                    <p className="text-[11px] text-gray-2">replicas</p>
                    <p className="display-stat text-[28px] font-normal">
                      <span className="text-status-green">{ready}</span>
                      <span className="text-gray-3 mx-1">/</span>
                      <span>{m.replicas.length}</span>
                    </p>
                    <p className="text-[10px] text-gray-2 font-mono">min {m.minReplicas} · max {m.maxReplicas}</p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-12 gap-0 divide-x divide-gray-1">
                <div className="col-span-12 lg:col-span-7 px-6 py-5">
                  <p className="text-[11px] uppercase tracking-wider text-gray-2 font-medium mb-3">Per-replica state</p>
                  {m.replicas.length === 0 ? (
                    <p className="text-[12px] text-gray-2 leading-relaxed">
                      No replicas are currently reachable. KEDA scales this model from{" "}
                      <span className="font-mono">{m.minReplicas}</span> to{" "}
                      <span className="font-mono">{m.maxReplicas}</span>; replicas appear here once their
                      readiness endpoint reports the model weights are loaded.
                    </p>
                  ) : null}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                    {m.replicas.map((r) => (
                      <div
                        key={r.id}
                        className="rounded-xl border border-gray-1 px-3 py-2.5 flex items-center justify-between hover:bg-gray-1/40 transition lift"
                      >
                        <div className="min-w-0">
                          <p className="text-[12px] font-mono truncate">{r.id}</p>
                          <p className="text-[10px] text-gray-2">
                            {r.tokensPerSec ? `${Number(r.tokensPerSec).toFixed(1)} tps` : "warming"}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <div className="w-16">
                            <div className="h-1.5 rounded-full bg-gray-1 overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all duration-700 ${
                                  r.loadPct > 80
                                    ? "bg-status-red"
                                    : r.loadPct > 50
                                    ? "bg-status-yellow"
                                    : "bg-status-green"
                                }`}
                                style={{ width: `${r.loadPct}%` }}
                              />
                            </div>
                            <p className="text-[9px] text-gray-2 text-right mt-0.5 font-mono tabular-nums">{Math.round(r.loadPct)}%</p>
                          </div>
                          <ReplicaStatusPill status={r.status} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="col-span-12 lg:col-span-5 px-6 py-5 space-y-4">
                  <div>
                    <p className="text-[11px] uppercase tracking-wider text-gray-2 font-medium mb-1">System prompt</p>
                    <p className="text-[12px] leading-relaxed text-ink/80 line-clamp-3">
                      {m.systemPrompt || <span className="text-gray-3 italic">not set</span>}
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-[11px] uppercase tracking-wider text-gray-2 font-medium mb-1">Cost basis</p>
                      <p className="text-[12px] font-mono">
                        ${m.costValue.toFixed(4)}{" "}
                        <span className="text-gray-2">/ {m.costBasis.replace(/_/g, " ")}</span>
                      </p>
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-wider text-gray-2 font-medium mb-1">Source</p>
                      <p className="text-[12px] font-mono">
                        {m.configSource === "gitops" ? "Helm chart" : "Dashboard override + Helm"}
                      </p>
                    </div>
                  </div>

                  <div className="flex gap-2 pt-2">
                    <Link
                      href="/settings"
                      className="flex-1 text-center px-3 py-1.5 rounded-lg bg-ink text-paper text-[12px] hover:bg-ink-soft transition"
                    >
                      Edit
                    </Link>
                    <Link
                      href="/monitoring"
                      className="px-3 py-1.5 rounded-lg border border-gray-3 text-[12px] hover:bg-gray-1 transition"
                    >
                      Logs
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      </>
      ) : null}
    </div>
  );
}
