import { createLocalJWKSet, createRemoteJWKSet } from "jose";
import type { JWTVerifyGetKey } from "jose";

/**
 * Abstracts "how we get the JWKS key set" used to verify a JWT's signature.
 *
 * Production points this at a live Entra tenant's JWKS URI; tests/dev use a
 * locally-generated key set so no network call is ever required.
 */
export interface JWKSSource {
  /** A jose-compatible key resolver, suitable for passing to `jwtVerify`. */
  getKey: JWTVerifyGetKey;
}

/** How long a JWKS fetch may take before we give up on it. */
const DEFAULT_TIMEOUT_MS = Number(process.env.ENTRA_JWKS_TIMEOUT_MS ?? 5000);

/** How long a fetched key set is reused before being refreshed. */
const DEFAULT_CACHE_MAX_AGE_MS = Number(process.env.ENTRA_JWKS_CACHE_MS ?? 10 * 60 * 1000);

/**
 * Wraps `jose`'s `createRemoteJWKSet`, fetching and caching keys from a live
 * JWKS endpoint, e.g. an Entra tenant's
 * `https://login.microsoftonline.com/<tenant>/discovery/v2.0/keys`.
 *
 * Three settings matter here, and all three are about what happens when that
 * endpoint misbehaves rather than when it works:
 *
 * - `timeoutDuration` — every API request's auth depends on this resolver. An
 *   untimed fetch against a hung endpoint would stall the whole gateway, not
 *   just the one request that triggered the refresh.
 * - `cooldownDuration` — an unrecognised `kid` triggers a refetch, which is how
 *   key rollover is picked up without a restart. The cooldown stops a burst of
 *   tokens signed by an unknown key from turning into a request flood against
 *   the identity provider.
 * - `cacheMaxAge` — keys are refreshed periodically even when nothing looks
 *   wrong, so a rotation is picked up before any request fails.
 *
 * PRD §8 permits this: the constraint is on calls to endpoints the operator
 * has not explicitly configured, and `ENTRA_JWKS_URI` is explicit.
 */
export function createRemoteJwksSource(
  jwksUri: string,
  opts: { timeoutMs?: number; cacheMaxAgeMs?: number } = {}
): JWKSSource {
  const getKey = createRemoteJWKSet(new URL(jwksUri), {
    timeoutDuration: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    cooldownDuration: 30_000,
    cacheMaxAge: opts.cacheMaxAgeMs ?? DEFAULT_CACHE_MAX_AGE_MS,
  });
  return { getKey };
}

/**
 * Wraps `jose`'s `createLocalJWKSet` for a JWKS document already in hand
 * (e.g. one built in tests from a generated keypair). Never hits the network.
 */
export function createLocalJwksSource(jwks: object): JWKSSource {
  const getKey = createLocalJWKSet(jwks as Parameters<typeof createLocalJWKSet>[0]);
  return { getKey };
}

/**
 * Verifies the JWKS endpoint is reachable, without making it a startup
 * dependency.
 *
 * A gateway that refuses to boot because the identity provider is briefly
 * unreachable cannot serve its dashboard, its health probe, or its metrics —
 * so an outage at Entra becomes a total outage here. Instead we probe once,
 * log loudly on failure, and let the resolver retry naturally on first use.
 */
export async function probeJwks(jwksUri: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{ ok: boolean; detail?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(jwksUri, { signal: controller.signal });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const body = (await res.json()) as { keys?: unknown[] };
    if (!Array.isArray(body.keys) || body.keys.length === 0) {
      return { ok: false, detail: "response contained no keys" };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
