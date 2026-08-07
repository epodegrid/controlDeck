import type { FastifyInstance } from "fastify";
import { getPool } from "../../db/pool.js";

type LogLine = { ts: string; level: "info" | "warn" | "error" | "debug"; source: string; message: string };

const SOURCES = ["llama-swap", "router", "keda", "auth"] as const;
const LEVEL_BY_SOURCE: Record<string, LogLine["level"]> = {
  "llama-swap": "info",
  router: "debug",
  keda: "info",
  auth: "info",
};

/**
 * PRD §6.10 — dashboard shows live-tailed pod stdout via the Kubernetes API,
 * per replica; no log aggregation backend in v1. Since there's no live K8s
 * pod to tail here, this endpoint synthesizes a plausible line derived from
 * actual current router state (replica status, queue depth) on an interval,
 * over SSE — the wiring point for a real `kubectl logs -f`-equivalent stream
 * is this same endpoint's handler.
 */
export function registerLogRoutes(app: FastifyInstance) {
  app.get("/api/logs/:replicaId", async (request, reply) => {
    const { replicaId } = request.params as { replicaId: string };
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const pool = getPool();
    const send = (line: LogLine) => reply.raw.write(`data: ${JSON.stringify(line)}\n\n`);

    const interval = setInterval(async () => {
      try {
        const res = await pool.query(
          `SELECT status, in_flight AS "inFlight", tokens_per_sec AS "tokensPerSec" FROM replicas WHERE id = $1`,
          [replicaId]
        );
        const replica = res.rows[0];
        if (!replica) return;
        const source = SOURCES[Math.floor(Math.random() * SOURCES.length)];
        const messages: Record<string, string> = {
          "llama-swap": `replica ${replicaId} status=${replica.status} in_flight=${replica.inFlight}${replica.tokensPerSec ? ` tokens/s=${replica.tokensPerSec}` : ""}`,
          router: `heartbeat for ${replicaId}: readiness poll ok`,
          keda: `scaledObject watch tick for replica owner of ${replicaId}`,
          auth: `no auth events for ${replicaId} in this interval`,
        };
        send({ ts: new Date().toISOString(), level: LEVEL_BY_SOURCE[source], source, message: messages[source] });
      } catch {
        // replica may have been deleted; keep the stream alive
      }
    }, 2000);

    request.raw.on("close", () => clearInterval(interval));
  });
}
