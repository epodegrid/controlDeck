import { apiRequest, currentNamespace, inCluster } from "../replicas/kubernetes.js";

/**
 * What KEDA is actually doing for a model, read from the cluster and reduced
 * to something an operator can act on.
 *
 * Autoscaling is the one feature here that fails completely silently. The
 * ScaledObject reports Ready, the router serves its metric, the deployment
 * sits at minReplicas, and nothing anywhere says why. Every cause needs a
 * different fix and none of them announce themselves, so the answer has to be
 * fetched deliberately.
 *
 * This exists because the alternative is asking someone to run kubectl against
 * a production cluster and send back the output — which is not always possible,
 * and is never the right thing to require of a platform that already holds the
 * credentials to look.
 *
 * Read-only, and every failure to look is reported as "unknown" rather than
 * raised: a missing RBAC rule must not take the dashboard down.
 */

export type ScalingState =
  /** KEDA is managing the deployment and can read the metric. */
  | "active"
  /** A ScaledObject exists but KEDA has not created an HPA for it. */
  | "not_reconciled"
  /** The HPA exists but cannot read the external metric. */
  | "metric_unreadable"
  /** No ScaledObject at all — the chart did not create one. */
  | "absent"
  /** Not in a cluster, or the router may not look. */
  | "unknown";

export type ScalingStatus = {
  state: ScalingState;
  /** One sentence naming the cause, and what to do about it. */
  detail: string;
  minReplicas: number | null;
  maxReplicas: number | null;
  desiredReplicas: number | null;
  /** The value the HPA last read from the router's metric endpoint. */
  currentMetric: number | null;
  /**
   * The URL KEDA was told to poll.
   *
   * Shown because KEDA's HPA condition stops at "encountered error" and never
   * reports what actually failed — so the one thing an operator can check by
   * eye is whether the address is right. A wrong release name, namespace or
   * port is obvious here and invisible everywhere else.
   */
  triggerUrl: string | null;
};

const UNKNOWN = (detail: string): ScalingStatus => ({
  state: "unknown",
  detail,
  minReplicas: null,
  maxReplicas: null,
  desiredReplicas: null,
  currentMetric: null,
  triggerUrl: null,
});

type ScaledObject = {
  spec?: {
    minReplicaCount?: number;
    maxReplicaCount?: number;
    triggers?: Array<{ metadata?: { url?: string } }>;
  };
  status?: { conditions?: Array<{ type: string; status: string; message?: string }> };
};

type Hpa = {
  status?: {
    desiredReplicas?: number;
    // KEDA's metrics-api trigger uses an AverageValue target, so the reading
    // lands in `averageValue`; `value` is only populated for a Value target.
    // Reading one and not the other reported "no metric" on a healthy HPA.
    currentMetrics?: Array<{
      external?: { current?: { value?: string; averageValue?: string } };
    }>;
    conditions?: Array<{ type: string; status: string; reason?: string; message?: string }>;
  };
};

/**
 * Reduces an HPA failure message to the part that names the fault.
 *
 * Kubernetes writes these as a chain — "unable to compute the replica count:
 * unable to get external metric <name>/<serialized label selector>: unable to
 * fetch metrics from external metrics API: rpc error: ... dial tcp: no such
 * host" — where the useful end is preceded by a serialized selector that is
 * longer than everything else put together.
 *
 * So the selector goes, and what remains is kept from the *end*: truncating
 * from the front discards the cause and leaves the boilerplate.
 */
export function summariseHpaMessage(message: string | undefined, limit = 240): string {
  if (!message) return "";
  const cleaned = message
    .replace(/&LabelSelector\{.*?\},?\}/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= limit) return cleaned;
  return `…${cleaned.slice(-limit)}`;
}

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await apiRequest(path);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * `backendModelId`, not the model id: the ScaledObject targets the deployment
 * that owns the workload, which several aliases can share.
 */
export async function getScalingStatus(backendModelId: string): Promise<ScalingStatus> {
  if (!inCluster()) {
    return UNKNOWN("Not running in Kubernetes, so there is no autoscaler to inspect.");
  }

  let namespace: string;
  try {
    namespace = await currentNamespace();
  } catch {
    return UNKNOWN("Could not determine the namespace.");
  }

  const so = await getJson<ScaledObject>(
    `/apis/keda.sh/v1alpha1/namespaces/${namespace}/scaledobjects/${backendModelId}-scaledobject`
  );
  if (!so) {
    return {
      state: "absent",
      detail:
        `No ScaledObject "${backendModelId}-scaledobject" in ${namespace}. Either the chart did ` +
        `not create one, or the router may not read them — the Role needs get/list on ` +
        `keda.sh/scaledobjects.`,
      minReplicas: null,
      maxReplicas: null,
      desiredReplicas: null,
      currentMetric: null,
      triggerUrl: null,
    };
  }

  const triggerUrl = so.spec?.triggers?.[0]?.metadata?.url ?? null;
  const minReplicas = so.spec?.minReplicaCount ?? null;
  const maxReplicas = so.spec?.maxReplicaCount ?? null;

  // KEDA reconciles a ScaledObject by creating an HPA. No HPA means the
  // operator never processed it, which is a different problem from a metric it
  // cannot read — and the usual cause on a shared cluster is a KEDA installed
  // with watchNamespace set to somewhere else, which logs nothing here.
  const hpa = await getJson<Hpa>(
    `/apis/autoscaling/v2/namespaces/${namespace}/horizontalpodautoscalers/` +
      `keda-hpa-${backendModelId}-scaledobject`
  );
  if (!hpa) {
    return {
      state: "not_reconciled",
      detail:
        `KEDA has not created an HPA for this ScaledObject. The operator is not processing it: ` +
        `most often it was installed watching a single namespace (WATCH_NAMESPACE) that is not ` +
        `${namespace}. Check the keda-operator Deployment, or install the chart's own KEDA with ` +
        `keda.enabled=true.`,
      minReplicas,
      maxReplicas,
      desiredReplicas: null,
      currentMetric: null,
      triggerUrl,
    };
  }

  const desiredReplicas = hpa.status?.desiredReplicas ?? null;
  const current = hpa.status?.currentMetrics?.[0]?.external?.current;
  const rawMetric = current?.averageValue ?? current?.value;
  const currentMetric = rawMetric === undefined ? null : Number(rawMetric);

  const scalingActive = hpa.status?.conditions?.find((c) => c.type === "ScalingActive");
  if (scalingActive && scalingActive.status === "False") {
    // The condition's own message carries the real cause — "no such host",
    // "i/o timeout", "connection refused" each point somewhere different — so
    // it is quoted rather than replaced with a guess.
    //
    // The serialized label selector is stripped first. Kubernetes embeds the
    // whole `&LabelSelector{MatchLabels:...}` blob in the middle of the
    // sentence, which is ~150 characters of noise sitting between the reader
    // and the part that names the fault.
    const upstream = summariseHpaMessage(scalingActive.message);

    return {
      state: "metric_unreadable",
      detail:
        `The HPA cannot read the router's metric (${scalingActive.reason ?? "unknown reason"}). ` +
        `A timeout or refused connection usually means traffic from KEDA's namespace to this ` +
        `one is blocked — a default-deny NetworkPolicy is the common cause in a locked-down ` +
        `cluster, and the chart can render an allow rule (networkPolicy.enabled). "no such ` +
        `host" means the Service name does not resolve. If instead the metrics API itself is ` +
        `failing, check that KEDA still serves v1beta1.external.metrics.k8s.io — it is a ` +
        `cluster singleton, so a second metrics adapter breaks every KEDA HPA.` +
        (upstream ? ` Kubernetes reports: ${upstream}` : ""),
      minReplicas,
      maxReplicas,
      desiredReplicas,
      currentMetric,
      triggerUrl,
    };
  }

  return {
    state: "active",
    detail:
      currentMetric === 0
        ? "Scaling normally. The metric is 0 because nothing is queued or in flight, so holding at the minimum is correct."
        : "Scaling normally.",
    minReplicas,
    maxReplicas,
    desiredReplicas,
    currentMetric,
    triggerUrl,
  };
}
