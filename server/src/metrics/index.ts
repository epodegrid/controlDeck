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
 * Two independent reasons to report demand:
 *
 *   saturation — no ready-idle replica remains while something is serving.
 *                Reactive: we are already out of headroom.
 *   preemptive — a replica just took its first request, even though others
 *                are still free. This is §6.4's "keep one warm spare ahead of
 *                demand", and it is the reason `recentlyRequestedScaleUp` is
 *                threaded in from the scheduler's KEDA client. Without it the
 *                metric could only ever react after headroom ran out.
 */
export async function getKedaMetricForModel(
  modelId: string,
  recentlyRequestedScaleUp = false
): Promise<{ in_flight_ratio: number }> {
  const pool = getPool();
  // Aggregated per model, not grouped by status. Grouping by status and
  // summing in_flight cannot answer "is any single replica free": two ready
  // replicas, one serving and one idle, sum to in_flight=1 and looked
  // saturated even though half the fleet was available.
  //
  // Headroom is per replica — in_flight < max_concurrency — so it has to be
  // evaluated row by row and only then counted.
  const { rows } = await pool.query<{ with_headroom: string; serving: string }>(
    `SELECT
       count(*) FILTER (WHERE status = 'ready' AND in_flight < max_concurrency) AS with_headroom,
       coalesce(sum(in_flight), 0) AS serving
     FROM replicas
     WHERE model_id = $1`,
    [modelId]
  );

  const withHeadroom = Number(rows[0]?.with_headroom ?? 0);
  const serving = Number(rows[0]?.serving ?? 0);
  const saturated = withHeadroom === 0 && serving > 0;

  return { in_flight_ratio: saturated || recentlyRequestedScaleUp ? 1 : 0 };
}
