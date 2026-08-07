import type { FastifyInstance } from "fastify";
import { configuredLogSource, tailReplicaLogs, type LogLine } from "../../logs/sources.js";
import { writeSseHead } from "../sse.js";

/**
 * PRD §6.10 — live-tailed replica stdout, streamed to the dashboard over SSE.
 *
 * The lines are the container's own output. When they cannot be obtained the
 * stream says so and closes, rather than filling the panel with anything
 * generated here: an operator reading this view during an incident has to be
 * able to trust that what they see is what the replica actually said.
 */
export function registerLogRoutes(app: FastifyInstance) {
  app.get("/api/logs/:replicaId", async (request, reply) => {
    const { replicaId } = request.params as { replicaId: string };
    const tail = Number((request.query as { tail?: string }).tail ?? 50) || 50;

    writeSseHead(reply);

    const write = (line: LogLine) => {
      if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(line)}\n\n`);
    };

    /** Reports a problem in-band so the panel can explain itself. */
    const fail = (message: string) => {
      write({
        ts: new Date().toISOString(),
        level: "error",
        source: "controldeck",
        message,
      });
      reply.raw.end();
    };

    let stream: Awaited<ReturnType<typeof tailReplicaLogs>> | null = null;
    let closed = false;

    request.raw.on("close", () => {
      closed = true;
      stream?.cancel();
    });

    try {
      stream = await tailReplicaLogs(replicaId, write, { tail });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return fail(
        `Could not attach to logs for ${replicaId} (source: ${configuredLogSource()}). ${detail}`
      );
    }

    // Keeps intermediate proxies from dropping a stream that is simply quiet.
    const keepAlive = setInterval(() => {
      if (!reply.raw.writableEnded) reply.raw.write(": keep-alive\n\n");
    }, 20_000);

    try {
      await stream.done;
      if (!closed) {
        write({
          ts: new Date().toISOString(),
          level: "warn",
          source: "controldeck",
          message: "Log stream ended — the replica may have been restarted or scaled down.",
        });
      }
    } catch (err) {
      if (!closed) {
        const detail = err instanceof Error ? err.message : String(err);
        write({
          ts: new Date().toISOString(),
          level: "error",
          source: "controldeck",
          message: `Log stream failed: ${detail}`,
        });
      }
    } finally {
      clearInterval(keepAlive);
      if (!reply.raw.writableEnded) reply.raw.end();
    }

    return reply;
  });
}
