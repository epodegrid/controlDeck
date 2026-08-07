import { buildApp } from "./http/app.js";
import { config } from "./config.js";
import { sweepQueueTimeouts, sweepStallTimeouts } from "./scheduler/index.js";
import { reconcileReplicas } from "./replicas/reconcile.js";
import { runMigrations } from "./db/migrate.js";
import { probeJwks } from "./auth/index.js";

/** How often to re-probe backend readiness (PRD §6.4). */
const RECONCILE_INTERVAL_MS = Number(process.env.REPLICA_RECONCILE_INTERVAL_MS ?? 5000);
const SWEEP_INTERVAL_MS = 5000;

async function main() {
  await runMigrations();
  const app = await buildApp();

  // PRD §6.5 — two independent clocks, swept periodically rather than
  // per-request-timer.
  setInterval(() => {
    sweepQueueTimeouts().catch((err) => app.log.error(err, "queue timeout sweep failed"));
  }, SWEEP_INTERVAL_MS);
  setInterval(() => {
    sweepStallTimeouts().catch((err) => app.log.error(err, "stall timeout sweep failed"));
  }, SWEEP_INTERVAL_MS);

  // Replica discovery + readiness probing. Runs once up front so the router
  // has a real view of its fleet before it accepts the first request, rather
  // than routing into a table that is still empty.
  const reconcile = () =>
    reconcileReplicas()
      .then((summary) => {
        app.log.debug(summary, "replica reconcile");
      })
      .catch((err) => app.log.error(err, "replica reconcile failed"));

  await reconcile();
  setInterval(reconcile, RECONCILE_INTERVAL_MS);

  // Check the identity provider is reachable, but never block startup on it.
  // A brief Entra outage must not also take down the dashboard, the health
  // probe and the metrics endpoint.
  if (!config.simMode && config.jwksUri) {
    const probe = await probeJwks(config.jwksUri);
    if (probe.ok) {
      app.log.info({ jwksUri: config.jwksUri }, "JWKS endpoint reachable");
    } else {
      app.log.error(
        { jwksUri: config.jwksUri, detail: probe.detail },
        "JWKS endpoint unreachable at startup — API requests will fail auth until it recovers"
      );
    }
  }

  await app.listen({ port: config.port, host: "0.0.0.0" });
  app.log.info(
    { simMode: config.simMode, modelBackend: process.env.MODEL_BACKEND ?? "auto" },
    config.simMode
      ? "controlDeck router started in SIM MODE — dev tokens enabled, data is simulated"
      : "controlDeck router started"
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
