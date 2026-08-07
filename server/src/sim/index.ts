import { closePool } from "../db/pool.js";
import { config } from "../config.js";
import { runLive, DEFAULT_LIVE_OPTIONS } from "./live.js";
import { runBackfill, DEFAULT_BACKFILL_OPTIONS } from "./backfill.js";

/**
 * Traffic simulator CLI.
 *
 *   npm run sim:backfill                 7 days of history (writes to Postgres)
 *   npm run sim:backfill -- --days=30 --reset
 *   npm run sim:live                     continuous traffic through the router
 *   npm run sim:live -- --rate=5 --duration=60 --verbose
 *
 * Backfill gives the Cost and Audit views something to chart; live gives the
 * Overview and Requests views something to move. Run backfill once, then live
 * whenever you want the dashboard to breathe.
 */

const USAGE = `
controldeck traffic simulator

  tsx src/sim/index.ts backfill [options]
    --days=N            days of history to synthesize   (default ${DEFAULT_BACKFILL_OPTIONS.days})
    --requests=N        approximate requests per day    (default ${DEFAULT_BACKFILL_OPTIONS.requestsPerDay})
    --reset             delete previously simulated rows first

  tsx src/sim/index.ts live [options]
    --url=URL           router base url                 (default ${DEFAULT_LIVE_OPTIONS.routerUrl})
    --rate=N            requests per second             (default ${DEFAULT_LIVE_OPTIONS.rate})
    --duration=N        seconds to run, 0 = forever     (default ${DEFAULT_LIVE_OPTIONS.durationSec})
    --concurrency=N     max in-flight requests          (default ${DEFAULT_LIVE_OPTIONS.concurrency})
    --failure-rate=N    share of deliberate failures    (default ${DEFAULT_LIVE_OPTIONS.failureRate})
    --verbose           log every request
`;

function flag(args: string[], name: string): string | undefined {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const [, value] = hit.split("=");
  return value ?? "true";
}

const numberFlag = (args: string[], name: string): number | undefined => {
  const raw = flag(args, name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number, got "${raw}"`);
  return parsed;
};

/**
 * Drops undefined entries. The run* functions merge their argument over a
 * defaults object, and spreading an explicit `undefined` would clobber the
 * default rather than fall through to it.
 */
function compact<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);

  // The simulator fabricates callers and traffic. Running it against a real
  // deployment would inject fictional identities into the audit trail — the
  // one record that has to stay trustworthy (PRD §6.8).
  if (mode && mode !== "help" && !config.simMode) {
    throw new Error(
      "Refusing to run: the traffic simulator only operates in sim mode.\n" +
        "Set SIM_MODE=true to run it against a local or demo environment."
    );
  }

  if (!mode || mode === "help" || flag(args, "help")) {
    console.log(USAGE);
    return;
  }

  if (mode === "backfill") {
    await runBackfill(
      compact({
        days: numberFlag(args, "days"),
        requestsPerDay: numberFlag(args, "requests"),
        reset: flag(args, "reset") === "true" ? true : undefined,
      })
    );
    return;
  }

  if (mode === "live") {
    await runLive(
      compact({
        routerUrl: flag(args, "url"),
        rate: numberFlag(args, "rate"),
        durationSec: numberFlag(args, "duration"),
        concurrency: numberFlag(args, "concurrency"),
        failureRate: numberFlag(args, "failure-rate"),
        verbose: flag(args, "verbose") === "true" ? true : undefined,
      })
    );
    return;
  }

  console.error(`Unknown mode "${mode}".`);
  console.log(USAGE);
  process.exitCode = 1;
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await closePool().catch(() => {});
    process.exit(1);
  });
