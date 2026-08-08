import { getPool } from "../db/pool.js";
import { createRedactor } from "./redact.js";

/**
 * Where a replica's stdout comes from (PRD §6.10).
 *
 * This used to be synthesized — plausible-looking lines generated from
 * database state on a timer. That is worse than showing nothing: an operator
 * triaging a crash-looping replica would read "readiness poll ok" and conclude
 * the replica was fine. Logs must either be real or visibly absent.
 *
 * Two real sources, and an explicit "unavailable" that says so:
 *
 *   kubernetes — the pod log endpoint, which is what §6.10 specifies
 *   endpoint   — the replica's own /logs stream, used in local development
 *                where there is no Kubernetes to ask
 */
export type LogLine = {
  ts: string;
  level: "info" | "warn" | "error" | "debug";
  source: string;
  message: string;
};

export type LogStream = {
  /** Resolves when the upstream closes. Call `cancel` to stop early. */
  done: Promise<void>;
  cancel: () => void;
};

export type LogSourceKind = "kubernetes" | "endpoint" | "none";

export function configuredLogSource(): LogSourceKind {
  const explicit = process.env.LOG_SOURCE;
  if (explicit === "kubernetes" || explicit === "endpoint" || explicit === "none") return explicit;
  // In-cluster the service account is mounted at a known path; its presence is
  // a reliable signal that the Kubernetes API is the right source.
  return process.env.KUBERNETES_SERVICE_HOST ? "kubernetes" : "endpoint";
}

/** Parses a line of container stdout into the shape the dashboard renders. */
export function parseLine(raw: string, source: string): LogLine | null {
  const text = raw.trimEnd();
  if (!text) return null;

  // Kubernetes prefixes each line with an RFC3339 timestamp when asked to.
  const withTs = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s+(.*)$/.exec(text);
  const ts = withTs ? withTs[1] : new Date().toISOString();
  let message = withTs ? withTs[2] : text;

  // Honour a leading level marker if the container emits one, otherwise infer
  // from the text — an operator scanning for red should find it.
  let level: LogLine["level"] = "info";
  // Two shapes in practice: `[info] ...` from the mock model, and
  // `INFO [ func] ...` from llama.cpp / ik_llama.cpp. Reading the level the
  // server actually declared beats inferring it from words in the text, which
  // mislabels a line like "0 errors" as an error.
  const bracketed = /^\[(info|warn|warning|error|debug)\]\s*(.*)$/i.exec(message);
  const prefixed = /^(INFO|WARN|WARNING|ERROR|DEBUG)\s+(.*)$/.exec(message);
  if (bracketed) {
    const m = bracketed[1].toLowerCase();
    level = m === "warning" ? "warn" : (m as LogLine["level"]);
    message = bracketed[2];
  } else if (prefixed) {
    const m = prefixed[1].toLowerCase();
    level = m === "warning" ? "warn" : (m as LogLine["level"]);
    message = prefixed[2];
  } else if (/\b(error|fatal|panic|failed|exception)\b/i.test(message)) {
    level = "error";
  } else if (/\b(warn|warning|retry|degraded)\b/i.test(message)) {
    level = "warn";
  }

  return { ts, level, source, message };
}

/** Reads an SSE or newline stream, emitting one parsed line at a time. */
async function pump(
  body: ReadableStream<Uint8Array>,
  source: string,
  onLine: (line: LogLine) => void,
  { sse }: { sse: boolean }
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      if (sse) {
        if (!part.startsWith("data:")) continue;
        try {
          const parsed = JSON.parse(part.slice(5).trim()) as LogLine;
          if (parsed && parsed.message !== undefined) onLine(parsed);
        } catch {
          // keep-alive or partial frame
        }
      } else {
        const line = parseLine(part, source);
        if (line) onLine(line);
      }
    }
  }
}

/**
 * Tails the replica's own /logs endpoint. Used where there is no Kubernetes —
 * docker compose, or anything running the mock model.
 */
async function tailFromEndpoint(
  endpointUrl: string,
  replicaId: string,
  tail: number,
  onLine: (line: LogLine) => void,
  signal: AbortSignal
): Promise<void> {
  const res = await fetch(`${endpointUrl}/logs?follow=true&tail=${tail}`, { signal });
  if (!res.ok || !res.body) {
    throw new Error(`replica log endpoint returned ${res.status}`);
  }
  await pump(res.body, replicaId, onLine, { sse: true });
}

/**
 * Tails pod stdout through the Kubernetes API (PRD §6.10).
 *
 * Uses the in-cluster service account, which needs `get` on `pods/log` in the
 * namespace. Deliberately no client library: one authenticated GET against a
 * documented endpoint does not justify the dependency, and this keeps the
 * image free of anything that needs registry access to build.
 */
async function tailFromKubernetes(
  podName: string,
  tail: number,
  onLine: (line: LogLine) => void,
  signal: AbortSignal
): Promise<void> {
  const { readFile } = await import("node:fs/promises");
  const base = "/var/run/secrets/kubernetes.io/serviceaccount";

  const [token, namespace] = await Promise.all([
    readFile(`${base}/token`, "utf8"),
    process.env.POD_NAMESPACE
      ? Promise.resolve(process.env.POD_NAMESPACE)
      : readFile(`${base}/namespace`, "utf8"),
  ]);

  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? "443";
  const url =
    `https://${host}:${port}/api/v1/namespaces/${namespace.trim()}/pods/` +
    `${encodeURIComponent(podName)}/log?follow=true&timestamps=true&tailLines=${tail}`;

  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token.trim()}` },
    signal,
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`kubernetes pod log request returned ${res.status}: ${detail.slice(0, 200)}`);
  }
  await pump(res.body, podName, onLine, { sse: false });
}

/**
 * Starts tailing a replica, or throws with a message explaining why it can't.
 * The caller surfaces that message rather than substituting invented lines.
 */
export async function tailReplicaLogs(
  replicaId: string,
  onLine: (line: LogLine) => void,
  opts: { tail?: number } = {}
): Promise<LogStream> {
  const tail = opts.tail ?? 50;
  const kind = configuredLogSource();

  if (kind === "none") {
    throw new Error("Log streaming is disabled (LOG_SOURCE=none).");
  }

  const { rows } = await getPool().query<{ endpoint_url: string }>(
    `SELECT endpoint_url FROM replicas WHERE id = $1`,
    [replicaId]
  );
  if (rows.length === 0) {
    throw new Error(`No replica "${replicaId}" is currently registered.`);
  }

  const controller = new AbortController();

  // Model servers print the prompt itself at higher verbosity. The log panel
  // is not the audit trail and has none of its scoping, so content is masked
  // on the way through — see logs/redact.ts.
  const redact = createRedactor();
  const emit = (line: LogLine) => onLine({ ...line, message: redact(line.message) });

  const done =
    kind === "kubernetes"
      ? tailFromKubernetes(replicaId, tail, emit, controller.signal)
      : tailFromEndpoint(rows[0].endpoint_url, replicaId, tail, emit, controller.signal);

  return {
    done: done.catch((err) => {
      // An aborted stream is the caller disconnecting, not a failure.
      if (controller.signal.aborted) return;
      throw err;
    }),
    cancel: () => controller.abort(),
  };
}
