import { jwtVerify, errors as joseErrors } from "jose";
import type { CallerIdentity, StandardError } from "../types.js";
import type { JWKSSource } from "./jwks-source.js";

export type VerifyBearerTokenOptions = {
  jwks: JWKSSource;
  audience: string;
  issuer: string;
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
 * endpoint: checks signature, expiry, issuer, and audience explicitly.
 * Never throws — always resolves to a discriminated union result.
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

    const name =
      (typeof payload.name === "string" && payload.name) ||
      (typeof payload.preferred_username === "string" && payload.preferred_username) ||
      undefined;
    if (!name) {
      return authInvalid('Token is missing a usable "name" or "preferred_username" claim.');
    }

    const teamClaim = payload.team ?? payload.groups;
    let team: string | undefined;
    if (typeof teamClaim === "string") {
      team = teamClaim;
    } else if (Array.isArray(teamClaim) && typeof teamClaim[0] === "string") {
      team = teamClaim[0];
    }

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
