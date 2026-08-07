import { SectionHeader } from "@/components/section-header";
import { KpiTile } from "@/components/kpi-tile";
import { api, tryApi } from "@/lib/api";
import { ConnectionError } from "@/components/empty-state";
import type { LoggingScopeRow } from "@/lib/api";
import { LoggingToggle } from "./logging-toggle";
import { DeleteHistoryButton } from "./delete-history-button";

function fmtRel(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

const statusColors: Record<string, string> = {
  completed: "bg-status-green/10 text-status-green",
  queue_timeout: "bg-status-red/15 text-status-red",
  stall_timeout: "bg-status-red/15 text-status-red",
  auth_invalid: "bg-status-red/15 text-status-red",
  capability_mismatch: "bg-status-yellow/15 text-status-yellow",
};

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ caller?: string; model?: string; team?: string }>;
}) {
  const params = await searchParams;
  const [entriesResult, loggingResult, modelsResult] = await Promise.all([
    tryApi(() =>
      api.getAuditEntries({
        ...(params.caller ? { caller: params.caller } : {}),
        ...(params.model ? { model: params.model } : {}),
        ...(params.team ? { team: params.team } : {}),
      })
    ),
    tryApi(() => api.getLoggingConfig()),
    tryApi(() => api.getModels()),
  ]);

  const error = entriesResult.error ?? loggingResult.error ?? modelsResult.error;
  const entries = entriesResult.data ?? [];
  const loggingConfig = loggingResult.data ?? [];
  const models = modelsResult.data ?? [];
  const filtered = Boolean(params.caller || params.model || params.team);

  const globalScope = loggingConfig.find((r) => r.scopeType === "global");
  const teamScopes = loggingConfig.filter((r) => r.scopeType === "team");
  const modelScopes = loggingConfig.filter((r) => r.scopeType === "model");

  const last24h = Date.now() - 24 * 3600 * 1000;
  const loggedLast24h = entries.filter((e) => e.logged && new Date(e.arrivedAt).getTime() > last24h).length;

  const teamsOnCount = teamScopes.filter((r) => r.enabled).length;
  const modelsOnCount = modelScopes.filter((r) => r.enabled).length;

  const csvRows = [
    ["id", "arrivedAt", "caller", "callerOid", "team", "model", "status", "inputTokens", "outputTokens", "durationMs", "costUsd", "logged"],
    ...entries.map((e) => [
      e.id, e.arrivedAt, e.callerName, e.callerOid, e.team ?? "", e.routedModel ?? e.requestedModel ?? "",
      e.status, String(e.inputTokens), String(e.outputTokens), String(e.durationMs ?? ""), String(e.costUsd ?? ""), String(e.logged),
    ]),
  ];
  const csvContent = csvRows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
  const csvHref = `data:text/csv;charset=utf-8,${encodeURIComponent(csvContent)}`;

  return (
    <div className="p-6 md:p-10 max-w-[1400px] mx-auto ambient-wash">
      <SectionHeader
        tag="Audit"
        title={
          <>
            Audit trail,<br />
            <span className="text-gray-2">per request.</span>
          </>
        }
        description="Metadata is logged for every request. Full prompt and response content is logged only where the toggle is on — at any of the four granularities below. Access is gated entirely by Entra SSO; no separate audit-viewer role exists."
        action={
          <div className="flex items-center gap-2">
            <DeleteHistoryButton olderThanDays={30} />
            <a
              href={csvHref}
              download="audit-export.csv"
              className="px-3 py-1.5 rounded-lg bg-ink text-paper text-[12px] hover:bg-ink-soft transition"
            >
              Export CSV
            </a>
          </div>
        }
      />

      {error ? (
        <div className="mb-8">
          <ConnectionError detail={error} />
        </div>
      ) : null}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <KpiTile label="Logged · 24h" value={loggedLast24h} />
        <KpiTile
          label="Total tokens"
          value={`${(entries.reduce((a, b) => a + b.inputTokens + b.outputTokens, 0) / 1000).toFixed(1)}k`}
        />
        <KpiTile
          label="Active scopes"
          value={teamsOnCount + modelsOnCount}
          hint="on · content logging"
        />
        <KpiTile label="Retention" value="∞" hint="manual purge" />
      </div>

      <div className="rounded-3xl bg-card shadow-soft-2 p-6 mb-8 fade-in-1">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h3 className="text-[14px] font-normal">Content-logging toggles</h3>
            <p className="text-[11px] text-gray-2 mt-1 max-w-2xl">
              What's currently being logged. ON scopes capture full prompt + response; OFF scopes record metadata only.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <ScopeRow
            label="Global default"
            on={globalScope?.enabled ?? false}
            scopeType="global"
            scopeKey={globalScope?.scopeKey ?? "global"}
            description="Apply to all requests, override-able below"
          />
          <ScopeRow
            label="Per team"
            on={teamScopes[0]?.enabled ?? false}
            scopeType="team"
            scopeKey={teamScopes[0]?.scopeKey ?? ""}
            description={`${teamsOnCount}/${teamScopes.length} teams logging content`}
          />
          <ScopeRow
            label="Per model"
            on={modelScopes[0]?.enabled ?? false}
            scopeType="model"
            scopeKey={modelScopes[0]?.scopeKey ?? ""}
            description={`${modelsOnCount}/${modelScopes.length} models logging content`}
          />
          <ScopeRow label="Per API key" pending description="Reserved · not yet active" scopeType="key" scopeKey="" />
        </div>

        <details className="mt-5 border-t border-gray-1 pt-4 group">
          <summary className="cursor-pointer text-[12px] text-gray-2 hover:text-ink transition list-none flex items-center gap-2">
            <span className="text-[10px] transition group-open:rotate-90">▶</span>
            Show per-team breakdown
          </summary>
          <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2">
            {teamScopes.map((row) => (
              <div key={row.scopeKey} className="flex items-center justify-between px-3 py-2 rounded-lg bg-gray-1/40 hover:bg-gray-1 transition">
                <span className="font-mono text-[11px]">{row.scopeKey}</span>
                <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${row.enabled ? "bg-status-green/15 text-status-green" : "bg-gray-1 text-gray-2"}`}>
                  {row.enabled ? "ON" : "OFF"}
                </span>
              </div>
            ))}
          </div>
        </details>
      </div>

      <div className="rounded-3xl bg-card shadow-soft-2 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-1">
          <h3 className="text-[14px] font-normal">Recent requests</h3>
          <form method="GET" className="flex items-center gap-2">
            <div className="px-3 py-1.5 rounded-lg bg-gray-1 text-[12px] flex items-center gap-2 w-64 transition focus-within:ring-2 focus-within:ring-ink/10">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="text-gray-2">
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4-4" strokeLinecap="round" />
              </svg>
              <input
                name="caller"
                defaultValue={params.caller ?? ""}
                className="bg-transparent flex-1 outline-none placeholder:text-gray-2"
                placeholder="Filter by caller oid…"
              />
            </div>
            <select
              name="model"
              defaultValue={params.model ?? ""}
              className="px-3 py-1.5 rounded-lg bg-gray-1 text-[12px] outline-none hover:bg-gray-1/70 transition"
            >
              <option value="">All models</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.id}</option>
              ))}
            </select>
            <select
              name="team"
              defaultValue={params.team ?? ""}
              className="px-3 py-1.5 rounded-lg bg-gray-1 text-[12px] outline-none hover:bg-gray-1/70 transition"
            >
              <option value="">All teams</option>
              {teamScopes.map((t) => (
                <option key={t.scopeKey} value={t.scopeKey}>{t.scopeKey}</option>
              ))}
            </select>
            <button type="submit" className="px-3 py-1.5 rounded-lg bg-ink text-paper text-[12px] hover:bg-ink-soft transition">
              Apply
            </button>
            {(params.caller || params.model || params.team) && (
              <a href="/audit" className="px-3 py-1.5 rounded-lg border border-gray-3 text-[12px] hover:bg-gray-1 transition">
                Clear
              </a>
            )}
          </form>
        </div>

        <div className="grid grid-cols-12 gap-3 px-4 py-2.5 text-[10px] uppercase tracking-wider text-gray-2 font-normal border-b border-gray-1 bg-gray-1/40">
          <div className="col-span-2">When</div>
          <div className="col-span-2">Caller · oid</div>
          <div className="col-span-2">Model</div>
          <div className="col-span-1 text-right">Tokens</div>
          <div className="col-span-1 text-right">Latency</div>
          <div className="col-span-1 text-right">Cost</div>
          <div className="col-span-1 text-center">Log</div>
          <div className="col-span-2">Status</div>
        </div>

        {entries.length === 0 ? (
          <div className="px-5 py-10 text-center text-[12px] text-gray-2">
            {filtered
              ? "No audit entries match the current filter."
              : "No requests have been recorded yet. Every request through the gateway is logged here with its caller, model, tokens, latency and cost."}
          </div>
        ) : (
          entries.map((e, i) => (
            <div
              key={e.id}
              className="grid grid-cols-12 gap-3 items-center px-4 py-3 border-b border-gray-1 last:border-0 hover:bg-gray-1/40 transition text-[12px]"
              style={{ animation: `fade-in 500ms ${Math.min(i, 6) * 40}ms cubic-bezier(.22,1,.36,1) both` }}
            >
              <div className="col-span-2 text-gray-2">
                <div>{fmtRel(e.arrivedAt)}</div>
                <div className="text-[10px] font-mono">{new Date(e.arrivedAt).toISOString().substring(11, 19)}</div>
              </div>
              <div className="col-span-2">
                <div className="font-mono truncate">{e.callerName}</div>
                <div className="text-[10px] font-mono text-gray-2">{e.team ?? "—"} · {e.callerOid}</div>
              </div>
              <div className="col-span-2 font-mono text-[11px] text-ink/80 truncate">{e.routedModel ?? e.requestedModel ?? "—"}</div>
              <div className="col-span-1 text-right font-mono tabular-nums">
                {e.inputTokens + e.outputTokens >= 1000
                  ? `${((e.inputTokens + e.outputTokens) / 1000).toFixed(1)}k`
                  : e.inputTokens + e.outputTokens}
              </div>
              <div className="col-span-1 text-right font-mono tabular-nums">
                {e.durationMs == null ? "—" : e.durationMs >= 1000 ? `${(e.durationMs / 1000).toFixed(1)}s` : `${e.durationMs}ms`}
              </div>
              <div className="col-span-1 text-right font-mono tabular-nums">${(e.costUsd ?? 0).toFixed(4)}</div>
              <div className="col-span-1 text-center">
                <span
                  className={`inline-flex w-5 h-5 rounded items-center justify-center text-[10px] font-mono ${
                    e.logged ? "bg-status-green/15 text-status-green" : "bg-gray-1 text-gray-3"
                  }`}
                  title={e.logged ? "full content logged" : "metadata only"}
                >
                  {e.logged ? "✓" : "·"}
                </span>
              </div>
              <div className="col-span-2">
                <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-mono ${statusColors[e.status] ?? "bg-gray-1 text-gray-2"}`}>
                  {e.status}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ScopeRow({
  label,
  on,
  description,
  pending,
  scopeType,
  scopeKey,
}: {
  label: string;
  on?: boolean;
  description: string;
  pending?: boolean;
  scopeType: LoggingScopeRow["scopeType"];
  scopeKey: string;
}) {
  return (
    <div className="rounded-xl border border-gray-3 p-3.5 hover:border-ink/20 transition lift">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[12px] font-medium">{label}</span>
        <LoggingToggle scopeType={scopeType} scopeKey={scopeKey} on={on ?? false} pending={pending} />
      </div>
      <p className="text-[10px] text-gray-2 leading-snug">
        {pending ? "Reserved · not yet active" : description}
      </p>
    </div>
  );
}
