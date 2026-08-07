import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { renderPrometheusMetrics, getKedaMetricForModel } from "../../metrics/index.js";
import { config, getDevSigningKey } from "../../config.js";
import { MetricsKedaClient, type KedaClient } from "../../adapters/keda.js";
import { QUEUE_TIMEOUT_MS, STALL_TIMEOUT_MS } from "../../scheduler/index.js";

export function registerSystemRoutes(app: FastifyInstance, deps: { kedaClient?: KedaClient } = {}) {
  app.get("/healthz", async () => ({ status: "ok" }));

  // Real, currently-active timeout config — backs the Settings page's
  // "Timeout policy" panel (previously hardcoded display strings that would
  // silently drift from the actual env-configured values).
  app.get("/api/settings/config", async () => ({
    queueTimeoutMs: QUEUE_TIMEOUT_MS,
    stallTimeoutMs: STALL_TIMEOUT_MS,
    simMode: config.simMode,
    entraAudience: config.audience,
    entraIssuer: config.issuer,
  }));

  app.get("/metrics", async (_req, reply) => {
    reply.header("content-type", "text/plain; version=0.0.4");
    return renderPrometheusMetrics();
  });

  app.get("/metrics/keda/:modelId", async (request) => {
    const { modelId } = request.params as { modelId: string };
    const keda = deps.kedaClient;
    const preemptive = keda instanceof MetricsKedaClient ? keda.wantsScaleUp(modelId) : false;
    return getKedaMetricForModel(modelId, preemptive);
  });

  if (config.simMode) {
    // Sim-mode only: mints a locally-signed bearer token so the API can be
    // exercised end to end without a live Entra tenant. The route is not
    // registered at all in production — it cannot be reached even by an
    // authenticated caller, because it does not exist.
    app.post("/dev/token", async (request) => {
      const body = (request.body as { oid?: string; name?: string; team?: string }) ?? {};
      const { privateKey } = await getDevSigningKey();
      const token = await new SignJWT({
        oid: body.oid ?? "dev-user-oid",
        name: body.name ?? "Dev User",
        preferred_username: body.name ?? "dev.user@example.com",
        team: body.team ?? "platform",
      })
        .setProtectedHeader({ alg: "RS256", kid: "dev-key-1" })
        .setIssuedAt()
        .setIssuer(config.issuer)
        .setAudience(config.audience)
        .setExpirationTime("2h")
        .sign(privateKey);
      return { access_token: token, token_type: "Bearer", expires_in: 7200 };
    });
  }
}
