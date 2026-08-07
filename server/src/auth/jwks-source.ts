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

/**
 * Wraps `jose`'s `createRemoteJWKSet`, fetching (and caching) keys from a
 * live JWKS endpoint, e.g. an Entra tenant's
 * `https://login.microsoftonline.com/<tenant>/discovery/v2.0/keys`.
 */
export function createRemoteJwksSource(jwksUri: string): JWKSSource {
  const getKey = createRemoteJWKSet(new URL(jwksUri));
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
