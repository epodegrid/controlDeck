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
    metadata: { name: string };
    status?: {
      podIP?: string;
      phase?: string;
      conditions?: Array<{ type: string; status: string }>;
    };
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
    .filter((pod) => pod.status?.podIP && pod.status.phase === "Running")
    .map((pod) => ({
      name: pod.metadata.name,
      endpointUrl: `http://${pod.status!.podIP}:${port}`,
      ready:
        pod.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True") ?? false,
    }));
}
