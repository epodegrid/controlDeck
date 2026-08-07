import { PERSONAS, pickBehaviour, pickPersona, type Persona } from "./personas.js";
import { buildFailingRequest, buildRequest, type SimRequest } from "./build-request.js";

/**
 * Live traffic driver.
 *
 * Sends real HTTP through the real router with real Entra-shaped bearer
 * tokens, so every layer the PRD describes is exercised: JWT validation,
 * capability filtering, complexity routing, replica placement, streaming,
 * cost computation and audit capture. Nothing is written to the database
 * directly — the router does all of it, exactly as it would in production.
 */

export type LiveOptions = {
  routerUrl: string;
  /** Requests per second, aggregate across all personas. */
  rate: number;
  /** How long to run. 0 means run until interrupted. */
  durationSec: number;
  /** Max simultaneous in-flight requests. */
  concurrency: number;
  /** Share of requests deliberately built to fail (§6.6 error paths). */
  failureRate: number;
  /** Print a line per request instead of periodic summaries. */
  verbose: boolean;
};

export const DEFAULT_LIVE_OPTIONS: LiveOptions = {
  routerUrl: process.env.ROUTER_URL ?? "http://localhost:4000",
  rate: 2,
  durationSec: 0,
  concurrency: 8,
  failureRate: 0.08,
  verbose: false,
};

type Tally = {
  sent: number;
  completed: number;
  failed: number;
  byModel: Map<string, number>;
  byErrorCode: Map<string, number>;
  /** Requests whose actual model differed from what the traffic mix expected. */
  routingMismatches: { expected: string; actual: string; behaviour: string }[];
};

const newTally = (): Tally => ({
  sent: 0,
  completed: 0,
  failed: 0,
  byModel: new Map(),
  byErrorCode: new Map(),
  routingMismatches: [],
});

const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

/**
 * Mints a dev token per persona. Requires the router to be running with
 * USE_FAKE_ADAPTERS=true; against a real tenant these would be genuine Entra
 * tokens acquired by each caller's own flow (PRD §6.1).
 */
async function mintTokens(routerUrl: string): Promise<Map<string, string>> {
  const tokens = new Map<string, string>();
  for (const persona of PERSONAS) {
    const res = await fetch(`${routerUrl}/dev/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ oid: persona.oid, name: persona.name, team: persona.team }),
    });
    if (!res.ok) {
      throw new Error(
        `Could not mint a dev token for ${persona.name} (${res.status}). ` +
          `The router must be running with USE_FAKE_ADAPTERS=true for /dev/token to exist.`
      );
    }
    const body = (await res.json()) as { access_token: string };
    tokens.set(persona.oid, body.access_token);
  }
  return tokens;
}

/** Drains an SSE body and returns the model id seen in the chunks. */
async function drainStream(res: Response): Promise<{ model: string | null; tokens: number }> {
  if (!res.body) return { model: null, tokens: 0 };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let model: string | null = null;
  let tokens = 0;
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload);
        if (parsed.model) model = parsed.model;
        if (parsed.choices?.[0]?.delta?.content) tokens += 1;
      } catch {
        // keep-alive or partial line; ignore
      }
    }
  }
  return { model, tokens };
}

async function sendOne(
  opts: LiveOptions,
  persona: Persona,
  token: string,
  spec: SimRequest,
  tally: Tally
): Promise<void> {
  tally.sent += 1;
  try {
    const res = await fetch(`${opts.routerUrl}${spec.endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(spec.body),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
      const code = body?.error?.code ?? `http_${res.status}`;
      tally.failed += 1;
      bump(tally.byErrorCode, code);
      if (opts.verbose) {
        const tag = spec.expectedError === code ? "expected" : "UNEXPECTED";
        console.log(`  ${persona.name} ${spec.behaviour} -> ${code} (${tag})`);
      }
      return;
    }

    let model: string | null = null;
    if (spec.body.stream === true) {
      model = (await drainStream(res)).model;
    } else {
      const body = (await res.json()) as { model?: string };
      model = body.model ?? null;
    }

    tally.completed += 1;
    if (model) bump(tally.byModel, model);
    if (spec.expectedModel && model && model !== spec.expectedModel) {
      tally.routingMismatches.push({ expected: spec.expectedModel, actual: model, behaviour: spec.behaviour });
    }
    if (opts.verbose) console.log(`  ${persona.name} ${spec.behaviour} -> ${model}`);
  } catch (err) {
    tally.failed += 1;
    bump(tally.byErrorCode, "transport_error");
    if (opts.verbose) console.log(`  ${persona.name} ${spec.behaviour} -> transport error: ${String(err)}`);
  }
}

function printSummary(tally: Tally, elapsedSec: number): void {
  const models = [...tally.byModel.entries()].sort((a, b) => b[1] - a[1]).map(([m, c]) => `${m}=${c}`).join(" ");
  const errors = [...tally.byErrorCode.entries()].sort((a, b) => b[1] - a[1]).map(([e, c]) => `${e}=${c}`).join(" ");
  console.log(
    `[sim] ${elapsedSec.toFixed(0)}s  sent=${tally.sent} ok=${tally.completed} failed=${tally.failed}` +
      `  models: ${models || "-"}  errors: ${errors || "-"}` +
      (tally.routingMismatches.length ? `  routingMismatches=${tally.routingMismatches.length}` : "")
  );
}

export async function runLive(options: Partial<LiveOptions> = {}): Promise<void> {
  const opts = { ...DEFAULT_LIVE_OPTIONS, ...options };
  const tokens = await mintTokens(opts.routerUrl);
  const tally = newTally();

  console.log(
    `[sim] live traffic -> ${opts.routerUrl} at ~${opts.rate} req/s, concurrency ${opts.concurrency}, ` +
      `${(opts.failureRate * 100).toFixed(0)}% deliberate failures` +
      (opts.durationSec ? `, for ${opts.durationSec}s` : ", until interrupted (ctrl-c)")
  );

  const startedAt = Date.now();
  const deadline = opts.durationSec ? startedAt + opts.durationSec * 1000 : Infinity;
  const intervalMs = 1000 / Math.max(0.1, opts.rate);
  const inFlight = new Set<Promise<void>>();
  let stopping = false;

  const onSigint = () => {
    if (stopping) process.exit(1); // second ctrl-c: bail immediately
    stopping = true;
    console.log("\n[sim] stopping, draining in-flight requests…");
  };
  process.on("SIGINT", onSigint);

  const reporter = setInterval(() => printSummary(tally, (Date.now() - startedAt) / 1000), 5000);

  while (!stopping && Date.now() < deadline) {
    // Backpressure: never exceed the configured concurrency, so the simulator
    // can't fabricate load the router never actually saw.
    while (inFlight.size >= opts.concurrency) {
      await Promise.race(inFlight);
    }

    const persona = pickPersona();
    const spec =
      Math.random() < opts.failureRate ? buildFailingRequest() : buildRequest(persona, pickBehaviour(persona));

    const task = sendOne(opts, persona, tokens.get(persona.oid)!, spec, tally).finally(() => inFlight.delete(task));
    inFlight.add(task);

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  await Promise.allSettled([...inFlight]);
  clearInterval(reporter);
  process.off("SIGINT", onSigint);

  console.log("\n[sim] final:");
  printSummary(tally, (Date.now() - startedAt) / 1000);

  if (tally.routingMismatches.length > 0) {
    console.log(`[sim] ${tally.routingMismatches.length} routing expectation mismatch(es):`);
    const grouped = new Map<string, number>();
    for (const m of tally.routingMismatches) bump(grouped, `${m.behaviour}: expected ${m.expected}, got ${m.actual}`);
    for (const [desc, count] of grouped) console.log(`   ${count}x ${desc}`);
  }
}
