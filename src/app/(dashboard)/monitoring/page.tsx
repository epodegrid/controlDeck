import { SectionHeader } from "@/components/section-header";
import { api, tryApi } from "@/lib/api";
import { EmptyState, ConnectionError } from "@/components/empty-state";
import { MonitoringView } from "./monitoring-view";

export default async function MonitoringPage() {
  const [modelsResult, errorsResult] = await Promise.all([
    tryApi(() => api.getModels()),
    tryApi(() => api.getErrorSummary()),
  ]);

  const error = modelsResult.error ?? errorsResult.error;
  const models = modelsResult.data ?? [];
  const errorSummary = errorsResult.data ?? [];

  // PRD §6.9: link out to Grafana rather than duplicating infra metrics here.
  // Only rendered when an operator has actually configured a Grafana.
  const grafanaUrl = process.env.GRAFANA_URL;

  return (
    <div className="p-6 md:p-10 max-w-[1400px] mx-auto ambient-wash">
      <SectionHeader
        tag="Monitoring"
        title={
          <>
            Live monitoring<br />
            <span className="text-gray-2">per replica.</span>
          </>
        }
        description="Live-tailed pod stdout per replica. Deep infra metrics (CPU/RAM/node health) live in Grafana — this view is for fast triage of llama-swap and router-level events."
        action={
          grafanaUrl ? (
            <a
              href={grafanaUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-3 text-[12px] hover:bg-white transition glow-on-hover"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-status-green live-dot" />
              Open in Grafana →
            </a>
          ) : null
        }
      />

      {error ? <ConnectionError detail={error} /> : null}

      {!error && models.length === 0 ? (
        <EmptyState
          title="No replicas to monitor"
          description="Live pod logs are tailed per replica. Once a model is registered and its replicas pass their readiness probe, you can stream each replica's stdout here for fast triage."
          action={{ label: "View models", href: "/models" }}
        />
      ) : null}

      {models.length > 0 ? <MonitoringView models={models} errorSummary={errorSummary} /> : null}
    </div>
  );
}
