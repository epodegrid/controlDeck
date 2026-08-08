/**
 * Checks that each registry entry's `upstreamModel` is a name its backend
 * actually answers to.
 *
 * This is the failure that has no good symptom. llama-swap selects the process
 * to proxy to entirely from the request's `model` field; a name it does not
 * recognise comes back as `{"error":"no model id could be identified"}` — at
 * request time, to the caller, with nothing in the gateway to say the config
 * was wrong. And it is easy to get wrong, because the names live in the
 * container image's own config.yaml rather than in the Helm values: an image
 * rebuild can rename `ornith` to `ornith-1.0` and the deployment stays green
 * while every request to it fails.
 *
 * llama-swap's /v1/models lists configured models and their aliases without
 * loading any weights, so this costs one cheap request per backend and can run
 * on every reconcile pass.
 */

import type { ModelConfig } from "../types.js";

export type UpstreamCheck =
  | { state: "ok" }
  | { state: "unknown"; detail: string }
  | { state: "missing"; detail: string; available: string[] };

const CHECK_TIMEOUT_MS = Number(process.env.UPSTREAM_CHECK_TIMEOUT_MS ?? 3000);

type ModelsListEntry = {
  id?: unknown;
  meta?: { llamaswap?: { aliases?: unknown } };
};

/**
 * Every name a backend will accept in the `model` field: the model ids it
 * lists, plus llama-swap's aliases for them.
 *
 * Returns null when the backend does not offer a usable listing — plenty of
 * OpenAI-compatible servers do not, and "cannot check" must never be reported
 * as "wrong".
 */
export async function listUpstreamNames(endpointUrl: string): Promise<string[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(`${endpointUrl}/v1/models`, { signal: controller.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: unknown };
    if (!Array.isArray(body?.data)) return null;

    const names: string[] = [];
    for (const entry of body.data as ModelsListEntry[]) {
      if (typeof entry?.id === "string") names.push(entry.id);
      const aliases = entry?.meta?.llamaswap?.aliases;
      if (Array.isArray(aliases)) {
        for (const alias of aliases) if (typeof alias === "string") names.push(alias);
      }
    }
    return names;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Checks one model's configured upstream name against what its backend lists.
 *
 * `available` is null where the backend offered no listing, which is reported
 * as `unknown` rather than as a fault.
 */
export function checkUpstreamName(model: ModelConfig, available: string[] | null): UpstreamCheck {
  if (available === null) {
    return {
      state: "unknown",
      detail: "backend does not list its models, so the name could not be verified",
    };
  }
  if (available.includes(model.upstreamModel)) return { state: "ok" };
  return {
    state: "missing",
    detail:
      `backend does not serve "${model.upstreamModel}". ` +
      (available.length > 0
        ? `It answers to: ${available.join(", ")}.`
        : "It lists no models at all."),
    available,
  };
}

/**
 * Latest check per model id, refreshed by the reconciler and read by the
 * dashboard. In memory on purpose: it describes what a backend is doing right
 * now, and a stale row surviving a restart would be worse than none.
 */
const reports = new Map<string, UpstreamCheck>();

export function recordUpstreamCheck(modelId: string, check: UpstreamCheck): void {
  const previous = reports.get(modelId);
  reports.set(modelId, check);

  // Log only on change. Repeating a config error every reconcile pass buries
  // everything else; saying nothing at all leaves it undiscovered.
  if (previous?.state === check.state) return;
  if (check.state === "missing") {
    console.error(`[registry] model "${modelId}": ${check.detail}`);
  } else if (previous?.state === "missing" && check.state === "ok") {
    console.log(`[registry] model "${modelId}": upstream name now resolves`);
  }
}

export function getUpstreamCheck(modelId: string): UpstreamCheck | null {
  return reports.get(modelId) ?? null;
}

/** Test seam. */
export function clearUpstreamChecks(): void {
  reports.clear();
}
