import { getPool } from "../db/pool.js";

// PRD §6.4 — "Preemptive scaling": the moment any replica of a model receives
// its first request, nudge KEDA to spin up an additional replica in parallel,
// so the platform always tries to keep one warm spare ahead of demand rather
// than waiting for saturation.
//
// KEDA polls this router rather than being pushed to, so "requesting" a
// scale-up means making the next poll report demand.

export interface KedaClient {
  requestScaleUp(modelId: string): Promise<void>;
}

/**
 * In-memory KedaClient for tests. Records every call (in order, including
 * duplicates) so tests can assert exactly how many times — and for which
 * models — a scale-up was requested.
 */
export class FakeKedaClient implements KedaClient {
  calls: string[] = [];

  async requestScaleUp(modelId: string): Promise<void> {
    this.calls.push(modelId);
  }
}

/** No-op client used as the default when the caller doesn't wire up KEDA. */
export class NoopKedaClient implements KedaClient {
  async requestScaleUp(_modelId: string): Promise<void> {
    // intentionally a no-op
  }
}

/**
 * Records scale-up demand for KEDA to observe.
 *
 * KEDA polls `/metrics/keda/:modelId` on this router (see the ScaledObject in
 * helm/controldeck/templates/keda-scaledobjects.yaml) rather than being pushed
 * to, so "requesting" a scale-up means making the next poll report demand.
 *
 * The signal lives in Postgres, not in this process. It used to be a Map, on
 * the reasoning that the rest of the metric already came from shared state —
 * but the flag itself did not, and KEDA polls the router *Service*. With the
 * two router replicas §8 asks for, the poll reached the pod holding the signal
 * about half the time, so the warm spare was requested by coin flip.
 *
 * It hid well: in_flight and queued do come from Postgres, so once there is
 * measurable demand the spare is added regardless. The flag decides only the
 * case where demand is still zero — which is the one preemptive scaling exists
 * for (§6.4).
 *
 * Deliberately not calling the Kubernetes API: doing so would need the router
 * to hold scaling permissions on its own Deployments, and KEDA already owns
 * that responsibility.
 */
export class MetricsKedaClient implements KedaClient {
  /** Suppress repeat signals within this window; KEDA's poll interval is coarser anyway. */
  constructor(private readonly debounceMs = 1000) {}

  async requestScaleUp(modelId: string): Promise<void> {
    // The debounce is expressed in the UPDATE predicate so it holds across
    // replicas too: a second router signalling the same model within the
    // window is a no-op rather than a competing write.
    await getPool().query(
      `INSERT INTO scale_signals (model_id, requested_at)
       VALUES ($1, now())
       ON CONFLICT (model_id) DO UPDATE SET requested_at = now()
       WHERE scale_signals.requested_at < now() - ($2 || ' milliseconds')::interval`,
      [modelId, this.debounceMs]
    );
  }

  /** Whether a scale-up was signalled for this model inside the given window. */
  async wantsScaleUp(modelId: string, withinMs = 30_000): Promise<boolean> {
    const { rows } = await getPool().query<{ fresh: boolean }>(
      `SELECT requested_at > now() - ($2 || ' milliseconds')::interval AS fresh
       FROM scale_signals WHERE model_id = $1`,
      [modelId, withinMs]
    );
    return rows[0]?.fresh ?? false;
  }
}

export function createKedaClient(): KedaClient {
  return process.env.KEDA_ENABLED === "false" ? new NoopKedaClient() : new MetricsKedaClient();
}
