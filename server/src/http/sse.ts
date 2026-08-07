import type { FastifyReply } from "fastify";

/**
 * Opens a Server-Sent Events response without discarding the headers Fastify
 * has already prepared.
 *
 * Writing to `reply.raw` bypasses Fastify's reply object, so any header a
 * plugin set through `reply.header()` — CORS most importantly — is silently
 * dropped. The stream then reaches a browser with no
 * `access-control-allow-origin`, and `EventSource` refuses it while curl,
 * which does not enforce CORS, shows a perfectly healthy stream. That gap is
 * why this went unnoticed: every server-side check passed.
 *
 * Merging `reply.getHeaders()` first keeps the plugin headers and lets the
 * SSE-specific ones win.
 */
export function writeSseHead(reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    ...(reply.getHeaders() as Record<string, string | number | string[]>),
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    // Nginx and similar buffer proxied responses by default, which turns a
    // live stream into one long pause followed by everything at once.
    "x-accel-buffering": "no",
  });
}
