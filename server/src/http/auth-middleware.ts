import type { FastifyReply, FastifyRequest } from "fastify";
import { verifyBearerToken, type JWKSSource } from "../auth/index.js";
import { config } from "../config.js";
import { statusForError } from "./errors.js";
import type { CallerIdentity } from "../types.js";

declare module "fastify" {
  interface FastifyRequest {
    identity?: CallerIdentity;
  }
}

/**
 * PRD §6.1: every API request's bearer token is validated against Entra's
 * JWKS (signature, expiry, issuer, audience). No platform-issued credentials.
 */
export function createAuthPreHandler(jwks: JWKSSource) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const result = await verifyBearerToken(request.headers.authorization, {
      jwks,
      audience: config.audience,
      issuer: config.issuer,
      teamClaim: config.teamClaim,
      ...(config.tenantId ? { tenantId: config.tenantId } : {}),
    });
    if (!result.ok) {
      reply.code(statusForError(result.error)).send(result.error);
      return reply;
    }
    request.identity = result.identity;
  };
}
