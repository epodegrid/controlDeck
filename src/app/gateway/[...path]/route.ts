import type { NextRequest } from "next/server";

/**
 * Same-origin proxy from the browser to the router's dashboard API.
 *
 * Client components cannot use `NEXT_PUBLIC_API_BASE_URL`. Next inlines
 * `NEXT_PUBLIC_*` into the client bundle at *build* time, so a value set in the
 * Helm chart at run time never reaches the browser — the published image ships
 * with the build-time fallback, `http://localhost:4000`, baked into every
 * client-side call. Nothing in a deployed cluster is listening there, so the
 * log stream and every dashboard write silently failed while server-rendered
 * pages, which use the run-time `API_BASE_URL`, worked perfectly.
 *
 * Routing the browser straight at the router instead would mean exposing
 * `/api/*` through the ingress, and those endpoints are deliberately
 * unauthenticated — they are internal, and the dashboard's own session is what
 * guards them (PRD §6.1). Publishing them would hand anyone who can reach the
 * host the ability to edit the model registry and delete audit history.
 *
 * So the browser talks to its own origin and the server forwards. This route
 * sits behind the session middleware like every other dashboard path, needs no
 * ingress rule, and works unchanged under `kubectl port-forward` and in local
 * development.
 */

// The address of the router as seen from the dashboard *server*. Set by the
// chart to the in-cluster Service; falls back to the local dev router.
const API_BASE_URL =
  process.env.API_BASE_URL || process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4000";

// Never cached or statically evaluated: this forwards live requests, and one
// of them is an endless log stream.
export const dynamic = "force-dynamic";

/** Hop-by-hop and length headers that must not be copied onto a piped body. */
const STRIPPED = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "content-encoding",
  "host",
]);

// Typed explicitly rather than with the generated `RouteContext` helper: those
// types only exist after a build, and the typecheck runs before one.
async function forward(request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const target = `${API_BASE_URL}/${path.join("/")}${request.nextUrl.search}`;

  const headers = new Headers();
  for (const [k, v] of request.headers) {
    if (!STRIPPED.has(k.toLowerCase())) headers.set(k, v);
  }

  // Request bodies are buffered rather than piped. They are small JSON
  // payloads, and streaming one through requires `duplex: "half"` support all
  // the way down — where it is missing the body arrives empty and the write
  // silently does nothing, which is precisely how the audit toggle failed.
  // Only the *response* needs to stream, for the log tail.
  const isRead = request.method === "GET" || request.method === "HEAD";
  const body = isRead ? undefined : await request.arrayBuffer();

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      ...(body && body.byteLength > 0 ? { body } : {}),
      // Aborts propagate for reads only. The log stream never ends on its own
      // — it ends when the browser goes away, and without this the tail would
      // outlive the page watching it.
      //
      // Writes deliberately do not: a mutation that has already reached this
      // proxy should finish. Cancelling one because the user navigated leaves
      // the click looking applied and the change never made, which is how the
      // audit toggle failed to persist once the extra hop widened the window.
      ...(isRead ? { signal: request.signal } : {}),
      cache: "no-store",
    } as RequestInit);
  } catch (err) {
    // A failure here is the dashboard not reaching the router at all, which is
    // worth saying plainly rather than surfacing as an opaque 500.
    return Response.json(
      {
        error: `Dashboard could not reach the router at ${API_BASE_URL}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
      { status: 502 }
    );
  }

  const responseHeaders = new Headers();
  for (const [k, v] of upstream.headers) {
    if (!STRIPPED.has(k.toLowerCase())) responseHeaders.set(k, v);
  }
  // Belt and braces for the SSE path: any buffering between here and the
  // browser turns a live tail into nothing at all until the stream closes.
  if (responseHeaders.get("content-type")?.includes("text/event-stream")) {
    responseHeaders.set("cache-control", "no-cache, no-transform");
    responseHeaders.set("x-accel-buffering", "no");
  }

  // Body passed through as a stream rather than awaited, so an endless
  // response stays endless.
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export const GET = forward;
export const POST = forward;
export const PATCH = forward;
export const PUT = forward;
export const DELETE = forward;
