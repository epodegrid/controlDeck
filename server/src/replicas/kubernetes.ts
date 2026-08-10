import { readFile } from "node:fs/promises";

/**
 * Pod discovery through the Kubernetes API.
 *
 * Without this, in-cluster discovery falls back to the model's Service
 * address, which makes a replica a fiction: every request goes to one DNS name
 * and kube-proxy decides where it lands. Least-loaded placement, per-replica
 * throughput and readiness gating all become guesses about a black box, and
 * pod-log tailing asks for logs from a "pod" named after a Service.
 *
 * Listing pods makes a replica an actual pod — addressed by its own IP, with
 * its own readiness, its own measured throughput, and a name `kubectl logs`
 * recognises. It also means a KEDA scale-up shows up as new replicas rather
 * than as unchanged capacity.
 *
 * Requires `get`/`list` on `pods` (and `pods/log` for the log tail) in the
 * namespace — granted by the chart's Role.
 */

const SA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount";

export type DiscoveredPod = {
  /** Pod name, which doubles as the replica id so logs can be fetched by it. */
  name: string;
  /** Address the router talks to, e.g. http://10.244.0.7:8080 */
  endpointUrl: string;
  /** Whether kubelet currently considers the pod ready. */
  ready: boolean;
  /**
   * Times the containers in this pod have restarted.
   *
   * Straight off the pod we already fetch — no metrics API involved. It is the
   * cheapest signal there is that a replica is unhealthy in a way readiness
   * does not show: a model server being OOM-killed mid-generation comes back
   * Ready a moment later, and the only trace is this number climbing.
   */
  restartCount: number;
};

/** A point-in-time resource sample for one pod, from metrics.k8s.io. */
export type PodMetrics = {
  name: string;
  /** Millicores. 1000 = one core. */
  cpuMillicores: number;
  memoryBytes: number;
};

export function inCluster(): boolean {
  return Boolean(process.env.KUBERNETES_SERVICE_HOST);
}

async function serviceAccount(): Promise<{ token: string; namespace: string }> {
  const [token, namespace] = await Promise.all([
    readFile(`${SA_PATH}/token`, "utf8"),
    process.env.POD_NAMESPACE
      ? Promise.resolve(process.env.POD_NAMESPACE)
      : readFile(`${SA_PATH}/namespace`, "utf8"),
  ]);
  return { token: token.trim(), namespace: namespace.trim() };
}

export async function apiRequest(path: string, timeoutMs = 5000): Promise<Response> {
  const { token } = await serviceAccount();
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? "443";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`https://${host}:${port}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
  } catch (err) {
    // fetch reports TLS problems as a bare "fetch failed" with the real reason
    // one level down. Surfacing the cause matters: the usual failure here is
    // Node not trusting the cluster CA, and the generic message points nowhere
    // near that.
    const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
    const detail = cause?.code ?? cause?.message;
    throw new Error(
      `Kubernetes API request to ${path} failed${detail ? `: ${detail}` : ""}` +
        (detail && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(detail)
          ? " — set NODE_EXTRA_CA_CERTS to the service account's ca.crt"
          : "")
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function currentNamespace(): Promise<string> {
  return (await serviceAccount()).namespace;
}

type PodList = {
  items: Array<{
    metadata: { name: string; deletionTimestamp?: string };
    status?: {
      podIP?: string;
      phase?: string;
      conditions?: Array<{ type: string; status: string }>;
      containerStatuses?: Array<{ restartCount?: number }>;
    };
  }>;
};

type PodMetricsList = {
  items: Array<{
    metadata: { name: string };
    containers?: Array<{ usage?: { cpu?: string; memory?: string } }>;
  }>;
};

/**
 * Lists the pods serving a model, identified by the label the chart puts on
 * every model replica Deployment.
 *
 * Pods with no IP yet (still scheduling) are skipped — there is nothing to
 * probe or route to. Pods that are not Ready are returned anyway, marked as
 * such, so a replica loading its weights appears in the dashboard as `loading`
 * rather than vanishing until it is ready.
 *
 * Terminating pods are excluded. A pod being scaled down keeps its IP and
 * answers /health until the process actually exits, so without this check the
 * router happily places new requests on a replica that is shutting down and
 * they fail as `replica_unavailable`. This was observed during a KEDA
 * scale-down: ten requests failed against pods that were already terminating.
 * Kubernetes signals the intent by setting deletionTimestamp the moment
 * deletion begins, which is what makes it visible before the process dies.
 */
export async function listModelPods(modelId: string, port = 8080): Promise<DiscoveredPod[]> {
  const namespace = await currentNamespace();
  const selector = encodeURIComponent(`controldeck.io/model-id=${modelId}`);
  const res = await apiRequest(`/api/v1/namespaces/${namespace}/pods?labelSelector=${selector}`);

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`pod list for "${modelId}" returned ${res.status}: ${detail.slice(0, 200)}`);
  }

  const body = (await res.json()) as PodList;
  return body.items
    .filter(
      (pod) =>
        pod.status?.podIP && pod.status.phase === "Running" && !pod.metadata.deletionTimestamp
    )
    .map((pod) => ({
      name: pod.metadata.name,
      endpointUrl: `http://${pod.status!.podIP}:${port}`,
      ready:
        pod.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True") ?? false,
      // Summed across containers: a pod usually has one, and where it has more
      // the total is the honest answer to "has this replica been restarting".
      restartCount: (pod.status?.containerStatuses ?? []).reduce(
        (total, c) => total + (c.restartCount ?? 0),
        0
      ),
    }));
}

/**
 * Kubernetes quantities are strings with unit suffixes, and CPU in particular
 * arrives as nanocores from metrics-server ("123456789n") but can be written
 * "100m" or "2" elsewhere. Parsed rather than assumed, because getting this
 * wrong produces a number that looks plausible and is off by a thousand.
 */
export function parseCpuToMillicores(raw: string | undefined): number {
  if (!raw) return 0;
  if (raw.endsWith("n")) return Number(raw.slice(0, -1)) / 1_000_000;
  if (raw.endsWith("u")) return Number(raw.slice(0, -1)) / 1_000;
  if (raw.endsWith("m")) return Number(raw.slice(0, -1));
  return Number(raw) * 1000;
}

const MEMORY_UNITS: Record<string, number> = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  K: 1000,
  M: 1000 ** 2,
  G: 1000 ** 3,
  T: 1000 ** 4,
};

export function parseMemoryToBytes(raw: string | undefined): number {
  if (!raw) return 0;
  for (const [suffix, factor] of Object.entries(MEMORY_UNITS)) {
    if (raw.endsWith(suffix)) return Number(raw.slice(0, -suffix.length)) * factor;
  }
  return Number(raw);
}

/**
 * Current CPU and memory for the pods of one model, from the metrics API.
 *
 * Returns null when metrics-server is not installed, rather than throwing:
 * it is an add-on, not part of Kubernetes, and a cluster without it is a
 * cluster where these figures are genuinely unavailable — which the dashboard
 * should say plainly instead of failing the whole reconcile pass.
 *
 * AKS installs it by default, so on the deployment this was built for these
 * numbers are real.
 */
export async function listPodMetrics(modelId: string): Promise<PodMetrics[] | null> {
  const namespace = await currentNamespace();
  const selector = encodeURIComponent(`controldeck.io/model-id=${modelId}`);
  let res: Response;
  try {
    res = await apiRequest(
      `/apis/metrics.k8s.io/v1beta1/namespaces/${namespace}/pods?labelSelector=${selector}`
    );
  } catch {
    return null;
  }

  // 404 is "metrics-server is not installed"; 403 is "the Role does not grant
  // metrics.k8s.io". Both mean no figures, neither is worth failing over.
  if (!res.ok) return null;

  const body = (await res.json().catch(() => null)) as PodMetricsList | null;
  if (!body?.items) return null;

  return body.items.map((pod) => {
    // Summed across containers so the number matches the pod as a whole,
    // which is the unit the dashboard shows.
    let cpu = 0;
    let memory = 0;
    for (const c of pod.containers ?? []) {
      cpu += parseCpuToMillicores(c.usage?.cpu);
      memory += parseMemoryToBytes(c.usage?.memory);
    }
    return { name: pod.metadata.name, cpuMillicores: cpu, memoryBytes: memory };
  });
}
