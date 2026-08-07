import { jwtVerify, errors as joseErrors } from "jose";
import type { CallerIdentity, StandardError } from "../types.js";
import type { JWKSSource } from "./jwks-source.js";

export type VerifyBearerTokenOptions = {
  jwks: JWKSSource;
  /** Accepts a list so a gateway can serve callers holding tokens for more
   *  than one registered audience (e.g. `api://<id>` and the bare client id). */
  audience: string | string[];
  issuer: string;
  /**
   * Directory claim carrying the caller's team, used for cost attribution and
   * audit scoping. Entra emits no `team` claim; operators surface one through
   * an optional claim such as `department`. Configurable because the attribute
   * a tenant uses for this is a tenant decision.
   */
  teamClaim?: string;
  /**
   * When set, the token's `tid` must match. Only meaningful if `issuer` is a
   * multi-tenant endpoint — with a tenant-pinned issuer the issuer check
   * already constrains the tenant.
   */
  tenantId?: string;
  /** Seconds of clock skew tolerated between us and the token issuer. */
  clockToleranceSec?: number;
};

export type VerifyBearerTokenResult =
  | { ok: true; identity: CallerIdentity }
  | { ok: false; error: StandardError };

function authInvalid(message: string): { ok: false; error: StandardError } {
  return {
    ok: false,
    error: {
      error: {
        type: "auth_error",
        code: "auth_invalid",
        message,
      },
    },
  };
}

/** Returns the value only if it is a non-empty string. */
function firstString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function extractBearerToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) return null;
  const match = /^Bearer\s+(.+)$/.exec(authorizationHeader);
  if (!match) return null;
  const token = match[1].trim();
  if (!token) return null;
  return token;
}

/**
 * Validates an incoming request's bearer token against an Entra-style JWKS
 * endpoint: checks signature, algorithm, expiry, issuer, and audience
 * explicitly. Never throws — always resolves to a discriminated union result.
 */
export async function verifyBearerToken(
  authorizationHeader: string | undefined,
  opts: VerifyBearerTokenOptions
): Promise<VerifyBearerTokenResult> {
  try {
    const token = extractBearerToken(authorizationHeader);
    if (!token) {
      return authInvalid(
        'Missing or malformed Authorization header; expected "Bearer <token>".'
      );
    }

    let payload;
    try {
      const result = await jwtVerify(token, opts.jwks.getKey, {
        issuer: opts.issuer,
        audience: opts.audience,
        // Pin the algorithm. Without this the accepted set is whatever the
        // resolved key permits, which is how algorithm-confusion bugs start.
        algorithms: ["RS256"],
        // Entra and this service will not agree on the clock to the second,
        // and a token rejected for being one second early is indistinguishable
        // from a real auth failure to the caller.
        clockTolerance: opts.clockToleranceSec ?? 60,
      });
      payload = result.payload;
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) {
        return authInvalid("Token has expired.");
      }
      if (err instanceof joseErrors.JWTClaimValidationFailed) {
        return authInvalid(`Token claim validation failed: ${err.claim} (${err.reason}).`);
      }
      if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
        return authInvalid("Token signature verification failed.");
      }
      const message = err instanceof Error ? err.message : "Token verification failed.";
      return authInvalid(`Token verification failed: ${message}`);
    }

    const oid = typeof payload.oid === "string" ? payload.oid : undefined;
    if (!oid) {
      return authInvalid('Token is missing the required "oid" claim.');
    }

    if (opts.tenantId) {
      const tid = typeof payload.tid === "string" ? payload.tid : undefined;
      if (tid !== opts.tenantId) {
        return authInvalid("Token was issued by a different tenant than this gateway accepts.");
      }
    }

    // A display name is nice to have, not a reason to refuse service. Entra
    // access tokens frequently omit `name` unless the app registration adds it
    // as an optional claim, and rejecting those tokens would turn a cosmetic
    // gap into an outage. Fall back through the usable identifiers and, in the
    // last resort, attribute the request to the caller's object id — which is
    // always present and is what the audit trail actually keys on.
    const name =
      firstString(payload.name) ??
      firstString(payload.preferred_username) ??
      firstString(payload.upn) ??
      firstString(payload.email) ??
      oid;

    const team = firstString(payload[opts.teamClaim ?? "department"]);

    const identity: CallerIdentity = {
      oid,
      name,
      ...(team ? { team } : {}),
    };

    return { ok: true, identity };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown authentication error.";
    return authInvalid(`Unexpected error during token verification: ${message}`);
  }
}
