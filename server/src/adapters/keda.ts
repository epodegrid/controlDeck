// PRD §6.4 — "Preemptive scaling": the moment any replica of a model receives
// its first request, nudge KEDA to spin up an additional replica in parallel,
// so the platform always tries to keep one warm spare ahead of demand rather
// than waiting for saturation.
//
// In a real deployment this would poke a custom metric (or call the K8s API)
// that a KEDA ScaledObject watches. That integration is out of scope here —
// this module only defines the interface the scheduler depends on, plus an
// in-memory fake for tests.

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
 * The metric is derived from replica state in Postgres, which is already
 * shared across router replicas — so this marks the intent and lets the
 * existing metric endpoint answer truthfully.
 *
 * Deliberately not calling the Kubernetes API: doing so would need the router
 * to hold scaling permissions on its own Deployments, and KEDA already owns
 * that responsibility.
 */
export class MetricsKedaClient implements KedaClient {
  private readonly recent = new Map<string, number>();

  /** Suppress repeat signals within this window; KEDA's poll interval is coarser anyway. */
  constructor(private readonly debounceMs = 1000) {}

  async requestScaleUp(modelId: string): Promise<void> {
    const now = Date.now();
    const last = this.recent.get(modelId) ?? 0;
    if (now - last < this.debounceMs) return;
    this.recent.set(modelId, now);
  }

  /** Whether a scale-up was signalled for this model inside the given window. */
  wantsScaleUp(modelId: string, withinMs = 30_000): boolean {
    const last = this.recent.get(modelId);
    return last !== undefined && Date.now() - last < withinMs;
  }
}

export function createKedaClient(): KedaClient {
  return process.env.KEDA_ENABLED === "false" ? new NoopKedaClient() : new MetricsKedaClient();
}
