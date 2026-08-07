import { SectionHeader } from "@/components/section-header";
import { api, tryApi } from "@/lib/api";
import { ConnectionError } from "@/components/empty-state";
import { ModelRowActions } from "./model-row-actions";
import { LoggingToggle } from "../audit/logging-toggle";

export default async function SettingsPage() {
  const [modelsResult, loggingResult, configResult] = await Promise.all([
    tryApi(() => api.getModels()),
    tryApi(() => api.getLoggingConfig()),
    tryApi(() => api.getSettingsConfig()),
  ]);

  const error = modelsResult.error ?? loggingResult.error ?? configResult.error;
  const models = modelsResult.data ?? [];
  const loggingConfig = loggingResult.data ?? [];
  const timeoutConfig = configResult.data;
  const globalScope = loggingConfig.find((r) => r.scopeType === "global");

  return (
    <div className="p-6 md:p-10 max-w-[1400px] mx-auto ambient-wash">
      <SectionHeader
        tag="Settings"
        title={
          <>
            Settings<br />
            <span className="text-gray-2">admin.</span>
          </>
        }
        description="Model registry, KEDA autoscaling, content-logging policy, and the explicit override-layer relationship with the Helm-deployed base config."
      />

      {error ? (
        <div className="mb-8">
          <ConnectionError detail={error} />
        </div>
      ) : null}

      <div className="space-y-6">
        <div className="rounded-3xl bg-card shadow-soft-2 p-6 fade-in-1">
          <div className="flex items-baseline justify-between mb-5">
            <div>
              <h3 className="text-[14px] font-normal">Model registry</h3>
              <p className="text-[11px] text-gray-2 mt-1 max-w-2xl">
                Helm chart defines the base config. Dashboard edits write to <code className="font-mono">model_registry_overrides</code> in Postgres
                and are merged on top at read time — never clobbering the Helm-managed resource.
              </p>
            </div>
            <span className="text-[11px] text-gray-2 shrink-0 ml-4">
              Registration is GitOps-only
            </span>
          </div>

          <div className="rounded-2xl border border-gray-1 overflow-hidden">
            <table className="w-full text-[12px]">
              <thead className="bg-gray-1/60 text-[10px] uppercase tracking-wider text-gray-2 font-normal">
                <tr>
                  <th className="text-left px-4 py-2.5 font-normal">Model</th>
                  <th className="text-left px-4 py-2.5 font-normal">KEDA (min/max)</th>
                  <th className="text-left px-4 py-2.5 font-normal">Cost basis</th>
                  <th className="text-left px-4 py-2.5 font-normal">Source</th>
                  <th className="text-left px-4 py-2.5 font-normal">Override layer</th>
                </tr>
              </thead>
              <tbody>
                {models.map((m, i) => (
                  <tr
                    key={m.id}
                    className="border-t border-gray-1 hover:bg-gray-1/30 transition"
                    style={{ animation: `fade-in 400ms ${i * 60}ms cubic-bezier(.22,1,.36,1) both` }}
                  >
                    <td className="px-4 py-3">
                      <div className="font-mono">{m.name}</div>
                      <div className="text-[10px] font-mono text-gray-2">{m.id}</div>
                    </td>
                    <td className="px-4 py-3 font-mono">
                      {m.minReplicas} <span className="text-gray-2">→</span> {m.maxReplicas}
                    </td>
                    <td className="px-4 py-3 font-mono">
                      ${m.costValue.toFixed(4)} / {m.costBasis.replace(/_/g, " ")}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5 text-[11px]">
                        <span className={`w-1.5 h-1.5 rounded-full ${m.configSource === "gitops" ? "bg-status-green" : "bg-status-yellow"}`} />
                        {m.configSource === "gitops" ? "Helm chart" : "Dashboard override + Helm"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <ModelRowActions
                        modelId={m.id}
                        hasOverride={m.hasOverride}
                        minReplicas={m.minReplicas}
                        maxReplicas={m.maxReplicas}
                        costValue={m.costValue}
                        costBasis={m.costBasis}
                        systemPrompt={m.systemPrompt}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="rounded-3xl bg-card shadow-soft-2 p-6 fade-in-2">
            <h3 className="text-[14px] font-normal mb-5">Global content-logging policy</h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between rounded-xl border border-gray-1 p-3.5 hover:border-ink/20 transition">
                <div>
                  <p className="text-[13px] font-medium">Log full prompt + response body</p>
                  <p className="text-[11px] text-gray-2 mt-0.5">
                    When off, only metadata (caller, oid, model, tokens, latency) is stored.
                  </p>
                </div>
                <LoggingToggle scopeType="global" scopeKey={globalScope?.scopeKey ?? ""} on={globalScope?.enabled ?? false} />
              </div>
              <div className="rounded-xl border border-gray-1 p-3.5">
                <p className="text-[13px] font-medium">Retention</p>
                <p className="text-[11px] text-gray-2 mt-0.5 leading-relaxed">
                  Indefinite. There is no automatic purge or archival job — audit history is removed only by the
                  manual &ldquo;delete last X days&rdquo; action on the Audit page.
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-3xl bg-card shadow-soft-2 p-6 fade-in-3">
            <h3 className="text-[14px] font-normal mb-5">Timeout policy</h3>
            <div className="space-y-3">
              <FieldRow label="Queue-wait timeout" value={timeoutConfig ? (timeoutConfig.queueTimeoutMs / 60000).toString() : "—"} unit="min" hint="After this, request fails with queue_timeout." />
              <FieldRow label="Stall / inactivity timeout" value={timeoutConfig ? (timeoutConfig.stallTimeoutMs / 1000).toString() : "—"} unit="sec" hint="Time since last token. Slow-but-progressing generations still complete." />
              <FieldRow label="Replicas warm-up threshold" value="1" unit="req" hint="Spin up a spare replica the moment any replica gets its first request." />
              <FieldRow label="SSE mid-stream error event" value="enabled" hint="Each error code emits a proper SSE event before close." />
            </div>
          </div>
        </div>

        <div className="rounded-3xl bg-card shadow-soft-2 p-6 fade-in-4">
          <div className="flex items-baseline justify-between mb-5">
            <h3 className="text-[14px] font-normal">Access & identity</h3>
            <span className="text-[11px] text-gray-2">no platform-issued credentials · Entra is the only IdP</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="rounded-2xl border border-gray-1 p-4 hover:border-ink/20 transition lift">
              <p className="text-[11px] uppercase tracking-wider text-gray-2 font-medium">JWT validation</p>
              <p className="text-[14px] font-normal mt-2">
                {timeoutConfig?.simMode ? "JWKS · local sim key" : "JWKS · Entra"}
              </p>
              <p className="text-[10px] text-gray-2 mt-1 font-mono break-all">iss = {timeoutConfig?.entraIssuer ?? "—"}</p>
              <p className="text-[10px] text-gray-2 mt-1 font-mono">aud = {timeoutConfig?.entraAudience ?? "—"}</p>
            </div>
            <div className="rounded-2xl border border-gray-1 p-4 hover:border-ink/20 transition lift">
              <p className="text-[11px] uppercase tracking-wider text-gray-2 font-medium">Dashboard SSO</p>
              <p className="text-[14px] font-normal mt-2 text-status-yellow">Not wired</p>
              <p className="text-[10px] text-gray-2 mt-1">
                This build's dashboard API is unauthenticated — production would gate it via Entra SSO group membership, independent of the API's JWT path.
              </p>
            </div>
            <div className="rounded-2xl border border-gray-1 p-4 hover:border-ink/20 transition lift">
              <p className="text-[11px] uppercase tracking-wider text-gray-2 font-medium">Platform RBAC</p>
              <p className="text-[14px] font-normal mt-2 text-status-green">Off</p>
              <p className="text-[10px] text-gray-2 mt-1">No internal user/role table by design.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function FieldRow({ label, value, unit, hint }: { label: string; value: string; unit?: string; hint?: string }) {
  return (
    <div className="flex items-start justify-between rounded-xl border border-gray-1 p-3.5 hover:border-ink/20 transition">
      <div className="flex-1">
        <p className="text-[13px] font-medium">{label}</p>
        {hint ? <p className="text-[11px] text-gray-2 mt-0.5">{hint}</p> : null}
      </div>
      <div className="flex items-baseline gap-1 px-3 py-1.5 rounded-lg bg-gray-1 min-w-[120px] justify-end">
        <span className="display-stat text-[18px] font-normal font-mono">{value}</span>
        {unit ? <span className="text-[11px] text-gray-2 font-mono">{unit}</span> : null}
      </div>
    </div>
  );
}
