import { buildApp } from "./http/app.js";
import { config } from "./config.js";
import {
  sweepQueueTimeouts,
  sweepStallTimeouts,
  sweepFirstTokenTimeouts,
  sweepAffinities,
} from "./scheduler/index.js";
import { reconcileReplicas } from "./replicas/reconcile.js";
import { runMigrations } from "./db/migrate.js";
import { probeJwks } from "./auth/index.js";
import { syncModelsFromConfigFile } from "./registry/gitops.js";

/** How often to re-probe backend readiness (PRD §6.4). */
const RECONCILE_INTERVAL_MS = Number(process.env.REPLICA_RECONCILE_INTERVAL_MS ?? 5000);
const SWEEP_INTERVAL_MS = 5000;

async function main() {
  await runMigrations();

  // PRD §6.2 — Helm/GitOps is the primary model registration path. This writes
  // only the base config; dashboard edits live in model_registry_overrides and
  // are merged on top at read time, so a redeploy never clobbers them.
  try {
    const synced = await syncModelsFromConfigFile();
    if (synced) {
      console.log(
        `[registry] synced ${synced.upserted} model(s) from config` +
          (synced.removed.length ? `, removed ${synced.removed.join(", ")}` : "")
      );
    }
  } catch (err) {
    // A malformed config must not take the router down: it would still serve
    // whatever registry is already in the database, and an operator needs the
    // dashboard up to see what is wrong.
    console.error(`[registry] model config sync failed: ${err instanceof Error ? err.message : err}`);
  }

  const app = await buildApp();

  // PRD §6.5 — two independent clocks, swept periodically rather than
  // per-request-timer.
  setInterval(() => {
    sweepQueueTimeouts().catch((err) => app.log.error(err, "queue timeout sweep failed"));
  }, SWEEP_INTERVAL_MS);
  setInterval(() => {
    sweepStallTimeouts().catch((err) => app.log.error(err, "stall timeout sweep failed"));
  }, SWEEP_INTERVAL_MS);

  // Separate, far longer clock for requests still waiting on the first token —
  // a backend loading model weights is silent but not stalled.
  setInterval(() => {
    sweepFirstTokenTimeouts().catch((err) =>
      app.log.error(err, "first-token timeout sweep failed")
    );
  }, SWEEP_INTERVAL_MS);

  // Drops expired cache affinities and any pointing at a replica that has gone
  // away — a scaled-down pod took its KV cache with it.
  setInterval(() => {
    sweepAffinities().catch((err) => app.log.error(err, "affinity sweep failed"));
  }, 60_000);

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
