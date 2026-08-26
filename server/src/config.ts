import { generateKeyPair, exportJWK, type JWK, type KeyLike } from "jose";
import { createLocalJwksSource, createRemoteJwksSource, type JWKSSource } from "./auth/index.js";

/**
 * Sim mode is the single switch between "this is a demo you can explore" and
 * "this is a gateway serving a real tenant".
 *
 *   SIM_MODE=true  — mint local dev tokens without an Entra tenant, allow the
 *                    seed to install its fictional model registry, and let the
 *                    traffic simulator run. For local dev, demos, and CI.
 *   SIM_MODE unset — production. No token minting, no fictional data, no
 *                    simulator. A fresh deploy starts completely empty and
 *                    fills only with real traffic.
 *
 * It must default to off: a deployment that forgets to set it should be safe
 * and empty, never one that silently exposes a token-minting endpoint.
 */
const simMode = process.env.SIM_MODE === "true" || process.env.USE_FAKE_ADAPTERS === "true";

export const config = {
  port: Number(process.env.PORT ?? 4000),
  simMode,
  /**
   * Accepted audiences, comma-separated. Usually one — this API's Application
   * ID URI. A second entry is occasionally needed while migrating a client
   * from the bare client id to `api://<id>`.
   */
  audience: (process.env.ENTRA_AUDIENCE ?? "api://llm-gateway")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean),
  issuer: process.env.ENTRA_ISSUER ?? "https://login.microsoftonline.com/dev-tenant/v2.0",
  jwksUri: process.env.ENTRA_JWKS_URI ?? "",
  /** Optional tenant pin; only meaningful with a multi-tenant issuer. */
  tenantId: process.env.ENTRA_TENANT_ID ?? "",
  /**
   * Directory claim carrying the caller's team (PRD §6.7 cost-by-team, §6.8
   * per-team logging scopes). Entra has no `team` claim, so a tenant surfaces
   * one as an optional claim — `department` is the usual choice.
   */
  teamClaim: process.env.TEAM_CLAIM ?? "department",
  /**
   * Largest request body accepted, in bytes.
   *
   * Fastify defaults to 1 MiB, which is fine for a chat turn and far too small
   * for the traffic this gateway actually carries. An agent compacting its
   * history sends the entire conversation in one request; a vision request
   * carries base64 images. Both routinely exceed a megabyte, and the rejection
   * lands on precisely the request an agent cannot simply retry.
   *
   * 32 MiB by default, matching the ingress annotation in the worked example —
   * a gateway that accepts less than its own ingress passes is a trap.
   */
  bodyLimitBytes: Number(process.env.BODY_LIMIT_BYTES ?? 32 * 1024 * 1024),
};

let devSigningKey: { privateKey: KeyLike; jwks: { keys: JWK[] } } | null = null;

/**
 * Sim-mode identity provider stand-in. Generates a local RSA keypair once at
 * process start and exposes it as a JWKS, so SIM_MODE=true can validate and
 * mint tokens without a live Entra tenant. Never reachable in production —
 * there, ENTRA_JWKS_URI must point at a real tenant.
 */
export async function getDevSigningKey() {
  if (!devSigningKey) {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    jwk.kid = "dev-key-1";
    jwk.alg = "RS256";
    jwk.use = "sig";
    devSigningKey = { privateKey, jwks: { keys: [jwk] } };
  }
  return devSigningKey;
}

export async function getJwksSource(): Promise<JWKSSource> {
  if (config.simMode) {
    const { jwks } = await getDevSigningKey();
    return createLocalJwksSource(jwks);
  }
  if (!config.jwksUri) {
    throw new Error(
      "ENTRA_JWKS_URI must be set in production. Point it at your tenant's JWKS endpoint, " +
        "or set SIM_MODE=true to run against locally-minted dev tokens instead."
    );
  }
  return createRemoteJwksSource(config.jwksUri);
}
