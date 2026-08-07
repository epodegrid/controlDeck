import { getPool } from "../db/pool.js";

export async function renderPrometheusMetrics(): Promise<string> {
  const pool = getPool();
  const lines: string[] = [];

  const replicaRows = await pool.query<{
    model_id: string;
    status: string;
    count: string;
  }>(
    `SELECT model_id, status, count(*) AS count FROM replicas GROUP BY model_id, status`
  );
  lines.push("# HELP controldeck_replicas_total Replica count per model and status");
  lines.push("# TYPE controldeck_replicas_total gauge");
  for (const row of replicaRows.rows) {
    lines.push(
      `controldeck_replicas_total{model_id="${row.model_id}",status="${row.status}"} ${row.count}`
    );
  }

  const inFlightRows = await pool.query<{ model_id: string; in_flight: string }>(
    `SELECT model_id, coalesce(sum(in_flight),0) AS in_flight FROM replicas GROUP BY model_id`
  );
  lines.push("# HELP controldeck_in_flight_requests In-flight requests per model");
  lines.push("# TYPE controldeck_in_flight_requests gauge");
  for (const row of inFlightRows.rows) {
    lines.push(`controldeck_in_flight_requests{model_id="${row.model_id}"} ${row.in_flight}`);
  }

  const queueRows = await pool.query<{ count: string }>(
    `SELECT count(*) FROM requests WHERE status = 'queued'`
  );
  lines.push("# HELP controldeck_queue_depth Requests currently queued (unprocessed)");
  lines.push("# TYPE controldeck_queue_depth gauge");
  lines.push(`controldeck_queue_depth ${queueRows.rows[0].count}`);

  const statusRows = await pool.query<{ status: string; count: string }>(
    `SELECT status, count(*) FROM requests WHERE arrived_at > now() - interval '1 hour' GROUP BY status`
  );
  lines.push("# HELP controldeck_requests_last_hour_total Requests in the last hour by terminal status");
  lines.push("# TYPE controldeck_requests_last_hour_total counter");
  for (const row of statusRows.rows) {
    lines.push(`controldeck_requests_last_hour_total{status="${row.status}"} ${row.count}`);
  }

  return lines.join("\n") + "\n";
}

/**
 * Custom-metric feed consumed by each model's KEDA ScaledObject (see
 * helm/controldeck/templates/keda-scaledobjects.yaml).
 *
 * KEDA hands this value to the HPA, which computes
 *
 *     desiredReplicas = ceil(metricValue / targetValue)
 *
 * so the metric has to be a *quantity of work*, not a flag. It previously
 * reported `in_flight_ratio`, which was 0 or 1 against a targetValue of 1 —
 * meaning ceil(1/1) = 1 and the deployment could never exceed a single
 * replica whatever `maxReplicaCount` said. Autoscaling could not work.
 *
 * It now reports the number of requests needing a replica:
 *
 *   in_flight  — currently being served
 *   queued     — waiting for capacity (§6.5)
 *   +1         — the warm spare of §6.4, requested whenever there is any
 *                demand at all, so capacity is provisioned ahead of
 *                saturation rather than after it
 *
 * The ScaledObject's targetValue is how many of those a single replica should
 * absorb, so ten pending requests at a target of one produce ten replicas,
 * bounded by maxReplicaCount.
 */
export async function getKedaMetricForModel(
  modelId: string,
  recentlyRequestedScaleUp = false
): Promise<{ pending_requests: number; in_flight: number; queued: number }> {
  const pool = getPool();

  const { rows } = await pool.query<{ in_flight: string; queued: string }>(
    `SELECT
       (SELECT coalesce(sum(in_flight), 0) FROM replicas WHERE model_id = $1) AS in_flight,
       (SELECT count(*) FROM requests
         WHERE status = 'queued' AND routed_model = $1) AS queued`,
    [modelId]
  );

  const inFlight = Number(rows[0]?.in_flight ?? 0);
  const queued = Number(rows[0]?.queued ?? 0);
  const demand = inFlight + queued;

  // The warm spare: any demand at all, or a placement that just signalled one,
  // asks for one replica beyond what is strictly needed.
  const spare = demand > 0 || recentlyRequestedScaleUp ? 1 : 0;

  return { pending_requests: demand + spare, in_flight: inFlight, queued };
}
