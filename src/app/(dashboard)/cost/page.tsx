import Link from "next/link";
import { SectionHeader } from "@/components/section-header";
import { KpiTile } from "@/components/kpi-tile";
import { api, tryApi } from "@/lib/api";
import { EmptyState, ConnectionError } from "@/components/empty-state";

function PeriodTabs({ period }: { period: string }) {
  const periods = ["1h", "24h", "7d", "30d"];
  return (
    <div className="inline-flex items-center gap-1 p-1 rounded-lg bg-gray-1 text-[12px]">
      {periods.map((p) => (
        <Link
          key={p}
          href={`/cost?period=${p}`}
          className={`px-3 py-1 rounded-md transition ${
            p === period ? "bg-card card-shadow font-medium" : "text-gray-2 hover:text-ink"
          }`}
        >
          {p}
        </Link>
      ))}
    </div>
  );
}

function BigBar({ max, value, accent, delay }: { max: number; value: number; accent?: boolean; delay: number }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="h-2 rounded-full bg-gray-1 overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-700 ${accent ? "bg-accent shadow-glow-yellow" : "bg-accent-2"}`}
        style={{ width: `${Math.max(pct, 2)}%`, transitionDelay: `${delay}ms` }}
      />
    </div>
  );
}

export default async function CostPage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const params = await searchParams;
  const period = params.period ?? "24h";

  const [cost, byCallerResult] = await Promise.all([
    tryApi(() => api.getCost(period, "model")),
    tryApi(() => api.getCost(period, "caller")),
  ]);

  const error = cost.error ?? byCallerResult.error;
  const byModel = cost.data?.breakdown ?? [];
  const byCaller = byCallerResult.data?.breakdown ?? [];
  const timeseries = cost.data?.timeseries ?? [];
  const hasData = byModel.length > 0;

  const totalCost = byModel.reduce((a, b) => a + b.cost, 0);
  const totalTokens = byModel.reduce((a, b) => a + b.tokens, 0);
  const totalRequests = byModel.reduce((a, b) => a + b.requests, 0);
  const maxTokens = byModel.length > 0 ? Math.max(...byModel.map((m) => m.tokens)) : 0;
  const maxCallerCost = byCaller.length > 0 ? Math.max(...byCaller.map((c) => c.cost)) : 0;
  const avgPer1k = totalTokens > 0 ? totalCost / (totalTokens / 1000) : 0;

  const tsNums = timeseries.map((h) => ({
    hour: h.hour,
    tokensIn: Number(h.tokensIn),
    tokensOut: Number(h.tokensOut),
    cost: Number(h.cost),
    requests: Number(h.requests),
  }));
  const maxHourTokens = tsNums.length > 0 ? Math.max(...tsNums.map((x) => x.tokensIn + x.tokensOut)) : 0;
  const totalTokensIn = tsNums.reduce((a, b) => a + b.tokensIn, 0);
  const totalTokensOut = tsNums.reduce((a, b) => a + b.tokensOut, 0);
  const totalTsRequests = tsNums.reduce((a, b) => a + b.requests, 0);
  const avgTokensPerReq = totalTsRequests > 0 ? (totalTokensIn + totalTokensOut) / totalTsRequests : 0;

  return (
    <div className="p-6 md:p-10 max-w-[1400px] mx-auto ambient-wash">
      <SectionHeader
        tag="Cost"
        title={
          <>
            Cost by model,<br />
            <span className="text-gray-2">caller, time.</span>
          </>
        }
        description="Per-model discretionary cost (set under Settings · Model registry), computed from the raw tokens / request / compute-second figures shown alongside. Cost is observational only — the platform never blocks a request on spend."
        action={<PeriodTabs period={period} />}
      />

      {error ? (
        <div className="mb-8">
          <ConnectionError detail={error} />
        </div>
      ) : null}

      {!error && !hasData ? (
        <EmptyState
          title="No cost data yet"
          description="Cost is derived from completed requests. Once traffic flows through the gateway, spend appears here broken down by model, caller and time period — alongside the raw token and duration figures it was computed from."
          action={{ label: "Configure per-model cost", href: "/settings" }}
        />
      ) : null}

      {hasData ? (
      <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-10">
        <KpiTile label={`Total cost · ${period}`} value={`$${totalCost.toFixed(2)}`} />
        <KpiTile label="Tokens served" value={totalTokens >= 1e6 ? `${(totalTokens / 1e6).toFixed(1)}M` : totalTokens.toLocaleString()} />
        <KpiTile label="Requests" value={totalRequests.toLocaleString()} />
        <KpiTile label="Avg / 1k tokens" value={totalTokens > 0 ? `$${avgPer1k.toFixed(4)}` : "—"} hint="blended" />
      </div>

      <div className="grid grid-cols-12 gap-6 mb-8">
        <div className="col-span-12 lg:col-span-7 rounded-3xl bg-card shadow-soft-2 p-6 fade-in-1">
          <div className="flex items-center justify-between mb-5">
            <h3 className="text-[14px] font-normal">By model</h3>
            <span className="text-[11px] text-gray-2">tokens served</span>
          </div>
          <div className="space-y-4">
            {byModel.length === 0 ? (
              <p className="text-[12px] text-gray-2">No cost data for this period.</p>
            ) : (
              byModel.map((m, i) => (
                <div key={m.key}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="font-mono text-[12px]">{m.key}</span>
                    <span className="font-mono text-[11px] text-gray-2">
                      {m.requests.toLocaleString()} req · ${m.cost.toFixed(2)}
                    </span>
                  </div>
                  <BigBar max={maxTokens} value={m.tokens} accent={i === 0} delay={i * 80} />
                </div>
              ))
            )}
          </div>
        </div>

        <div className="col-span-12 lg:col-span-5 rounded-3xl bg-card shadow-soft-2 p-6 fade-in-2">
          <div className="flex items-center justify-between mb-5">
            <h3 className="text-[14px] font-normal">By caller</h3>
            <span className="text-[11px] text-gray-2">$ · {period}</span>
          </div>
          <div className="space-y-4">
            {byCaller.length === 0 ? (
              <p className="text-[12px] text-gray-2">No cost data for this period.</p>
            ) : (
              byCaller.map((c, i) => (
                <div key={c.key}>
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono text-[12px]">{c.key}</span>
                    </div>
                    <span className="font-mono text-[11px] tabular-nums">${c.cost.toFixed(2)}</span>
                  </div>
                  <BigBar max={maxCallerCost} value={c.cost} accent={i === 0} delay={i * 80} />
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <div className="rounded-3xl bg-card shadow-soft-2 p-6">
        <div className="flex items-center justify-between mb-7">
          <div>
            <h3 className="text-[14px] font-normal">Hourly distribution</h3>
            <p className="text-[11px] text-gray-2 mt-0.5">token throughput · {period}</p>
          </div>
          <div className="flex items-center gap-3 text-[11px]">
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-ink" /> input</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-accent" /> output</span>
          </div>
        </div>

        {tsNums.length === 0 ? (
          <div className="h-48 flex items-center justify-center text-[12px] text-gray-2">No hourly data for this period.</div>
        ) : (
          <div className="flex items-end gap-2 h-48">
            {tsNums.map((h, i) => {
              const inH = maxHourTokens > 0 ? (h.tokensIn / maxHourTokens) * 100 : 0;
              const outH = maxHourTokens > 0 ? (h.tokensOut / maxHourTokens) * 100 : 0;
              const label = new Date(h.hour).toLocaleTimeString([], { hour: "2-digit" });
              return (
                // h-full on the column and flex-1 on the bar row are what make
                // the bars visible at all: a percentage height resolves against
                // the parent's height, and this column had none, so every bar
                // computed to 0px while carrying a correct inline style.
                <div key={h.hour + i} className="flex-1 flex flex-col items-center gap-1 min-w-0 h-full">
                  <div className="w-full flex items-end gap-0.5 flex-1 min-h-0">
                    <div
                      className="flex-1 rounded-t bar-grow bg-ink"
                      style={{ height: `${inH}%`, animationDelay: `${i * 40}ms` }}
                      title={`in: ${h.tokensIn}`}
                    />
                    <div
                      className="flex-1 rounded-t bar-grow bg-accent-2"
                      style={{ height: `${outH}%`, animationDelay: `${i * 40 + 20}ms` }}
                      title={`out: ${h.tokensOut}`}
                    />
                  </div>
                  <span className="text-[9px] font-mono text-gray-2">{label}</span>
                </div>
              );
            })}
          </div>
        )}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6 pt-6 border-t border-gray-1">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-gray-2 font-medium">Tokens in</p>
            <p className="display-stat text-[20px] font-normal mt-1">{(totalTokensIn / 1000).toFixed(1)}k</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-gray-2 font-medium">Tokens out</p>
            <p className="display-stat text-[20px] font-normal mt-1">{(totalTokensOut / 1000).toFixed(1)}k</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-gray-2 font-medium">Avg tokens / req</p>
            <p className="display-stat text-[20px] font-normal mt-1">
              {totalTsRequests > 0 ? `${(avgTokensPerReq / 1000).toFixed(1)}k` : "—"}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-gray-2 font-medium">Cost / 1k tokens</p>
            <p className="display-stat text-[20px] font-normal mt-1">
              {totalTokens > 0 ? `$${avgPer1k.toFixed(4)}` : "—"}
            </p>
          </div>
        </div>
      </div>
      </>
      ) : null}
    </div>
  );
}
