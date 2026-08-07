import Link from "next/link";
import { KpiTile } from "@/components/kpi-tile";
import { EmptyState, ConnectionError } from "@/components/empty-state";
import { RingGauge } from "@/components/charts/ring-gauge";
import { ColumnChart } from "@/components/charts/column-chart";
import { TickBar } from "@/components/charts/tick-bar";
import { ArcGauge } from "@/components/charts/arc-gauge";
import { api, tryApi } from "@/lib/api";
import { getSession } from "@/lib/auth";

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

/** Thin-space grouping, matching the display style of the hero numerals. */
function fmtGrouped(n: number): string {
  return n.toLocaleString("en-US").replace(/,/g, " ");
}

export default async function OverviewPage() {
  const session = await getSession();
  const [modelsResult, overviewResult, queuedResult, inFlightResult] = await Promise.all([
    tryApi(() => api.getModels()),
    tryApi(() => api.getOverview()),
    tryApi(() => api.getQueuedRequests()),
    tryApi(() => api.getInFlightRequests()),
  ]);

  const error = modelsResult.error ?? overviewResult.error;
  const models = modelsResult.data ?? [];
  const overview = overviewResult.data;
  const queuedRequests = queuedResult.data ?? [];
  const inFlightRequests = inFlightResult.data ?? [];

  const replicas = models.flatMap((m) => m.replicas);
  const ready = replicas.filter((r) => r.status === "ready" || r.status === "busy").length;
  const loading = replicas.filter((r) => r.status === "loading").length;
  const down = replicas.filter((r) => r.status === "error" || r.status === "idle").length;

  const cap = overview?.byCapability ?? { chat: 0, tools: 0, embeddings: 0, vision: 0 };
  const capTotal = cap.chat + cap.tools + cap.embeddings + cap.vision;

  const failures = overview?.failuresLastHour ?? 0;
  const total24h = overview?.totalRequests24h ?? 0;

  // A gateway with no models registered has nothing to show yet — that is the
  // expected state of a fresh install, not a failure.
  const unconfigured = !error && models.length === 0;

  return (
    <div className="px-8 pt-2 pb-14 max-w-[1500px] ambient-wash">
      {error ? (
        <div className="mb-8">
          <ConnectionError detail={error} />
        </div>
      ) : null}

      {unconfigured ? (
        <EmptyState
          title="No models registered yet"
          description="This gateway is running and ready, but no models are registered. Add them to the Helm values file and deploy — replicas will appear here as they pass their readiness probe, and traffic will begin populating cost and audit."
          hint="helm upgrade --install controldeck ./helm/controldeck"
          action={{ label: "Go to settings", href: "/settings" }}
        />
      ) : null}

      {overview && !unconfigured ? (
        <div className="grid grid-cols-12 gap-5">
          {/* ---- Fleet panel ------------------------------------------- */}
          <section className="col-span-12 lg:col-span-4 panel-accent p-7 flex flex-col rise-in">
            <div>
              <h1 className="text-[26px] leading-tight font-light">
                Hello, {session?.name.split(" ")[0] ?? "there"}!
              </h1>
              <p className="text-[26px] leading-tight ghost-italic -mt-1">Operations overview</p>
              <p className="text-[12.5px] opacity-85 mt-3 leading-relaxed">
                Replicas scale on demand through KEDA. Everything below is live.
              </p>
            </div>

            <div className="my-8 flex justify-center">
              <RingGauge
                value={ready}
                total={replicas.length}
                label="Ready"
                caption={`${ready} of ${replicas.length} replicas`}
                tone="light"
              />
            </div>

            <div className="grid grid-cols-3 gap-3 mb-7">
              {[
                { dot: "bg-card", label: "Ready", value: ready },
                { dot: "bg-white/55", label: "Loading", value: loading },
                { dot: "bg-white/30", label: "Down", value: down },
              ].map((s, i) => (
                <div
                  key={s.label}
                  style={{ animation: `rise-in 560ms ${340 + i * 70}ms var(--ease-out-soft) both` }}
                >
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
                    <span className="text-[10px] uppercase tracking-[0.14em] opacity-80">{s.label}</span>
                  </div>
                  <p className="stat-md text-[26px]">{s.value}</p>
                </div>
              ))}
            </div>

            <div className="mt-auto pt-6 border-t border-white/20">
              <p className="text-[10px] uppercase tracking-[0.14em] opacity-80 mb-2">Requests · 24h</p>
              <div className="flex items-baseline">
                <span className="stat-hero text-[58px]">{fmtGrouped(total24h)}</span>
                <span className="text-[15px] italic opacity-70 ml-2">req</span>
              </div>
            </div>
          </section>

          {/* ---- Right column ------------------------------------------ */}
          <div className="col-span-12 lg:col-span-8 flex flex-col gap-5">
            <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
              <KpiTile label="Requests / min" value={overview.requestsPerMin} index={0} />
              <KpiTile label="Avg latency" value={fmtCompact(overview.avgLatencyMs)} unit="ms" index={1} />
              <KpiTile label="Tokens / sec" value={overview.tokensPerSec} index={2} />
              <KpiTile
                label="In flight"
                value={inFlightRequests.length}
                hint={queuedRequests.length > 0 ? `${queuedRequests.length} queued` : undefined}
                index={3}
              />
            </div>

            <section className="card p-6 fade-in-2">
              <div className="flex items-baseline justify-between mb-2">
                <h2 className="text-[15px] font-normal">Request volume</h2>
                <span className="text-[11px] text-gray-2">last 12 hours</span>
              </div>
              <ColumnChart
                data={overview.spark}
                height={216}
                footerLabel="Total · 24h"
                footerValue={fmtGrouped(total24h)}
              />
            </section>

            <div className="grid grid-cols-1 md:grid-cols-5 gap-5">
              <section className="md:col-span-3 card p-6 fade-in-3">
                <div className="flex items-baseline justify-between mb-5">
                  <h2 className="text-[15px] font-normal">Requests by capability</h2>
                  <Link href="/requests" className="text-[11px] text-gray-2 hover:text-ink">
                    View all →
                  </Link>
                </div>

                <div className="grid grid-cols-4 gap-3 mb-6">
                  {[
                    { label: "Chat", value: cap.chat },
                    { label: "Tools", value: cap.tools },
                    { label: "Embeddings", value: cap.embeddings },
                    { label: "Vision", value: cap.vision },
                  ].map((c) => (
                    <div key={c.label}>
                      <p className="text-[11px] text-gray-2 mb-1.5">{c.label}</p>
                      <p className="stat-md text-[22px]">{fmtGrouped(c.value)}</p>
                    </div>
                  ))}
                </div>

                <TickBar fraction={capTotal > 0 ? cap.chat / capTotal : 0} />
                <p className="text-[11px] text-gray-2 mt-3">
                  {capTotal > 0
                    ? `${Math.round((cap.chat / capTotal) * 100)}% of traffic is plain chat`
                    : "No traffic yet"}
                </p>
              </section>

              <section className="md:col-span-2 card p-6 fade-in-4">
                <div className="flex items-baseline justify-between mb-4">
                  <h2 className="text-[15px] font-normal">Failures</h2>
                  <span className="text-[11px] text-gray-2">1h</span>
                </div>

                <div className="flex items-center gap-5">
                  <ArcGauge value={failures} total={total24h || 1} />
                  <div className="space-y-3 min-w-0">
                    <div>
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-ink" />
                        <span className="text-[11px] text-gray-2">Failed</span>
                      </div>
                      <p className="stat-md text-[22px]">{fmtGrouped(failures)}</p>
                    </div>
                    <div>
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-gray-3" />
                        <span className="text-[11px] text-gray-2">Completed</span>
                      </div>
                      <p className="stat-md text-[22px]">{fmtGrouped(Math.max(total24h - failures, 0))}</p>
                    </div>
                  </div>
                </div>

                <p className="text-[11px] text-gray-2 mt-5 leading-relaxed">
                  Stall-timeout rate {overview.stallTimeoutRatePct}% over the same window.
                </p>
              </section>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
