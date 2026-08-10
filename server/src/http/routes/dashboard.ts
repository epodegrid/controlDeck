import type { FastifyInstance } from "fastify";
import { getPool } from "../../db/pool.js";
import { listModels, listReplicasForModel, setModelOverride } from "../../registry/index.js";
import { getUpstreamCheck } from "../../registry/verify-upstream.js";
import { getScalingStatus } from "../../scaling/status.js";
import { getCostBreakdown } from "../../cost/index.js";
import { getAuditEntries, isContentLoggingEnabled, setLoggingScope, deleteAuditHistory } from "../../audit/index.js";

const PERIOD_TO_INTERVAL: Record<string, string> = {
  "1h": "1 hour",
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
};

/**
 * Dashboard/admin API. In production this sits behind Entra SSO group
 * membership (PRD §6.1), independent of the API's JWT validation path — that
 * OIDC login flow requires a live Entra app registration and isn't wired up
 * here (see README); routes are unauthenticated in this build.
 */
export function registerDashboardRoutes(app: FastifyInstance) {
  app.get("/api/overview", async () => {
    const pool = getPool();
    const [queued, inFlight, replicaCounts, recentReqs, lastHour] = await Promise.all([
      pool.query(`SELECT id, caller_name AS caller, team, requested_model AS model, capabilities, arrived_at,
                    extract(epoch from (now() - arrived_at))::int AS "waitingSec"
                  FROM requests WHERE status = 'queued' ORDER BY arrived_at ASC`),
      pool.query(`SELECT id, caller_name AS caller, team, routed_model AS model, status, replica_id AS "replicaId",
                    arrived_at, started_at, input_tokens AS "inputTokens", output_tokens AS "outputTokensSoFar"
                  FROM requests WHERE status IN ('routed','streaming') ORDER BY arrived_at DESC`),
      pool.query(`SELECT status, count(*) FROM replicas GROUP BY status`),
      pool.query(`SELECT count(*) FROM requests WHERE arrived_at > now() - interval '24 hours'`),
      pool.query(`SELECT
          count(*) FILTER (WHERE arrived_at > now() - interval '1 minute') AS last_min,
          count(*) FILTER (WHERE status IN ('queue_timeout','stall_timeout','auth_invalid','capability_mismatch','error') AND arrived_at > now() - interval '1 hour') AS failures,
          coalesce(avg(duration_ms) FILTER (WHERE status = 'completed' AND completed_at > now() - interval '1 hour'), 0) AS avg_latency,
          coalesce(sum(output_tokens) FILTER (WHERE completed_at > now() - interval '1 minute'), 0) AS tokens_last_min
        FROM requests`),
    ]);

    const statusCounts = Object.fromEntries(replicaCounts.rows.map((r) => [r.status, Number(r.count)]));
    const activeReplicas = (statusCounts.ready ?? 0) + (statusCounts.busy ?? 0);
    const totalReplicas = Object.values(statusCounts).reduce((a: number, b) => a + Number(b), 0);
    const failuresLastHour = Number(lastHour.rows[0]?.failures ?? 0);

    const spark = await pool.query(
      `SELECT date_trunc('hour', arrived_at) AS bucket, count(*) AS value
       FROM requests WHERE arrived_at > now() - interval '12 hours'
       GROUP BY bucket ORDER BY bucket ASC`
    );

    const capabilityCounts = await pool.query<{ capability: string; count: string }>(
      `SELECT unnest(capabilities) AS capability, count(*) AS count
       FROM requests WHERE arrived_at > now() - interval '24 hours'
       GROUP BY capability`
    );
    const byCapability = Object.fromEntries(capabilityCounts.rows.map((r) => [r.capability, Number(r.count)]));

    const stallStats = await pool.query<{ total: string; stalled: string }>(
      `SELECT count(*) AS total, count(*) FILTER (WHERE status = 'stall_timeout') AS stalled
       FROM requests WHERE arrived_at > now() - interval '24 hours'`
    );
    const stallTotal = Number(stallStats.rows[0]?.total ?? 0);
    const stallCount = Number(stallStats.rows[0]?.stalled ?? 0);
    const stallTimeoutRatePct = stallTotal > 0 ? Number(((stallCount / stallTotal) * 100).toFixed(2)) : 0;

    return {
      requestsPerMin: Number(lastHour.rows[0]?.last_min ?? 0),
      avgLatencyMs: Math.round(Number(lastHour.rows[0]?.avg_latency ?? 0)),
      tokensPerSec: Math.round(Number(lastHour.rows[0]?.tokens_last_min ?? 0) / 60),
      activeReplicas,
      totalReplicas,
      queuedRequests: queued.rows.length,
      inFlightRequests: inFlight.rows.length,
      failuresLastHour,
      systemHealth: failuresLastHour > 5 ? "red" : queued.rows.length > 0 ? "yellow" : "green",
      totalRequests24h: Number(recentReqs.rows[0]?.count ?? 0),
      spark: spark.rows.map((r) => ({ label: r.bucket, value: Number(r.value) })),
      queuedPreview: queued.rows.slice(0, 5),
      inFlightPreview: inFlight.rows.slice(0, 5),
      byCapability: {
        chat: byCapability.chat ?? 0,
        tools: byCapability.tools ?? 0,
        embeddings: byCapability.embeddings ?? 0,
        vision: byCapability.vision ?? 0,
      },
      stallTimeoutRatePct,
    };
  });

  app.get("/api/models", async () => {
    const models = await listModels();
    const withReplicas = await Promise.all(
      models.map(async (m) => ({
        ...m,
        replicas: await listReplicasForModel(m.id),
        // Null until the reconciler has reached this model's backend once.
        upstreamCheck: getUpstreamCheck(m.id),
        // Read from the cluster, because autoscaling fails silently and the
        // alternative is asking someone to run kubectl in production.
        scaling: await getScalingStatus(m.backendModelId),
      }))
    );
    return withReplicas;
  });

  app.patch("/api/models/:id/override", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;
    const updated = await setModelOverride(id, body, "dashboard-admin");
    if (!updated) {
      reply.code(404).send({ error: "model not found" });
      return;
    }
    return updated;
  });

  app.get("/api/requests", async (request) => {
    const { state } = request.query as { state?: string };
    const pool = getPool();
    if (state === "queued") {
      const res = await pool.query(
        `SELECT id, caller_name AS caller, team, requested_model AS model, capabilities, status,
           arrived_at AS "arrivedAt", input_tokens AS "inputTokens",
           extract(epoch from (now() - arrived_at))::int AS "waitingSec"
         FROM requests WHERE status = 'queued' ORDER BY arrived_at ASC`
      );
      return res.rows;
    }
    if (state === "failed") {
      // "Recent failures · last 5 min" per the dashboard label — matches the
      // queue-wait timeout window, not an arbitrary lookback.
      const res = await pool.query(
        `SELECT id, caller_name AS caller, team, routed_model AS model, requested_model, status, error_code AS "errorCode",
           arrived_at AS "arrivedAt", input_tokens AS "inputTokens"
         FROM requests
         WHERE status IN ('queue_timeout','stall_timeout','auth_invalid','capability_mismatch','error','replica_unavailable')
           AND arrived_at > now() - interval '5 minutes'
         ORDER BY arrived_at DESC LIMIT 50`
      );
      return res.rows;
    }
    const res = await pool.query(
      `SELECT id, caller_name AS caller, team, routed_model AS model, status, replica_id AS "replicaId",
         arrived_at AS "arrivedAt", started_at AS "startedAt", input_tokens AS "inputTokens",
         output_tokens AS "outputTokensSoFar"
       FROM requests WHERE status IN ('routed','streaming') ORDER BY arrived_at DESC`
    );
    return res.rows;
  });

  app.get("/api/cost", async (request) => {
    const { groupBy = "model", period = "24h" } = request.query as { groupBy?: "model" | "caller"; period?: string };
    const interval = PERIOD_TO_INTERVAL[period] ?? "24 hours";
    const pool = getPool();
    const since = (await pool.query(`SELECT now() - $1::interval AS since`, [interval])).rows[0].since as Date;
    const breakdown = await getCostBreakdown({ since, until: new Date(), groupBy });

    const hourly = await pool.query(
      `SELECT date_trunc('hour', arrived_at) AS hour,
         coalesce(sum(input_tokens),0) AS "tokensIn", coalesce(sum(output_tokens),0) AS "tokensOut",
         coalesce(sum(cost_usd),0) AS cost, count(*) AS requests
       FROM requests WHERE status = 'completed' AND arrived_at > now() - $1::interval
       GROUP BY hour ORDER BY hour ASC`,
      [interval]
    );

    return { breakdown, timeseries: hourly.rows, period };
  });

  app.get("/api/audit", async (request) => {
    const q = request.query as {
      caller?: string;
      model?: string;
      team?: string;
      status?: string;
      limit?: string;
      offset?: string;
    };
    const entries = await getAuditEntries({
      caller: q.caller || undefined,
      model: q.model || undefined,
      team: q.team || undefined,
      status: q.status || undefined,
      limit: q.limit ? Number(q.limit) : 50,
      offset: q.offset ? Number(q.offset) : 0,
    });
    return entries;
  });

  // Real per-error-code counts over the last 24h, backing the Monitoring
  // page's "Error summary" panel (previously a hardcoded illustrative array).
  app.get("/api/errors/summary", async () => {
    const pool = getPool();
    const res = await pool.query<{ error_code: string; count: string }>(
      `SELECT error_code, count(*) AS count FROM requests
       WHERE error_code IS NOT NULL AND arrived_at > now() - interval '24 hours'
       GROUP BY error_code ORDER BY count DESC`
    );
    return res.rows.map((r) => ({ errorCode: r.error_code, count: Number(r.count) }));
  });

  app.get("/api/audit/logging-config", async () => {
    const pool = getPool();
    const res = await pool.query(`SELECT scope_type AS "scopeType", scope_key AS "scopeKey", enabled FROM audit_logging_config ORDER BY scope_type, scope_key`);
    return res.rows;
  });

  app.put("/api/audit/logging-config", async (request) => {
    const { scopeType, scopeKey = "", enabled } = request.body as {
      scopeType: "global" | "team" | "model" | "key";
      scopeKey?: string;
      enabled: boolean;
    };
    await setLoggingScope(scopeType, scopeKey, enabled);
    return { scopeType, scopeKey, enabled };
  });

  app.get("/api/audit/logging-status", async (request) => {
    const { team, model, apiKey } = request.query as { team?: string; model?: string; apiKey?: string };
    const enabled = await isContentLoggingEnabled({ team, modelId: model, apiKey });
    return { enabled };
  });

  // No confirmation gating beyond normal SSO-gated dashboard access — treated
  // as a personnel-trust boundary per PRD §6.8 / Non-Goals.
  app.post("/api/audit/delete", async (request) => {
    const { olderThanDays } = request.body as { olderThanDays: number };
    const result = await deleteAuditHistory(olderThanDays);
    return result;
  });
}
