import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPair, exportJWK, SignJWT, UnsecuredJWT } from "jose";
import type { KeyLike } from "jose";
import { verifyBearerToken } from "../src/auth/verify.js";
import { createLocalJwksSource } from "../src/auth/jwks-source.js";
import type { JWKSSource } from "../src/auth/jwks-source.js";

/**
 * Contract tests for token validation against Entra-shaped tokens.
 *
 * `auth.test.ts` covers the everyday paths. This file covers the shapes a real
 * tenant produces that a hand-rolled dev token never does — missing optional
 * claims, group-claim overage, multi-tenant issuers, algorithm substitution —
 * because those are the cases that turn into a production incident on the day
 * the gateway is first pointed at a real tenant.
 */

const TENANT = "11111111-2222-3333-4444-555555555555";
const ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;
const AUDIENCE = "api://control-deck";

describe("token validation contract (Entra-shaped)", () => {
  let jwks: JWKSSource;
  let privateKey: KeyLike;

  beforeAll(async () => {
    const { publicKey, privateKey: priv } = await generateKeyPair("RS256");
    privateKey = priv;
    const jwk = await exportJWK(publicKey);
    jwk.kid = "k1";
    jwk.alg = "RS256";
    jwk.use = "sig";
    jwks = createLocalJwksSource({ keys: [jwk] });
  });

  async function token(claims: Record<string, unknown> = {}, opts: { audience?: string | string[] } = {}) {
    return new SignJWT({ oid: "caller-oid-1", tid: TENANT, ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(opts.audience ?? AUDIENCE)
      .setExpirationTime("1h")
      .sign(privateKey);
  }

  const verify = (t: string, over: Partial<Parameters<typeof verifyBearerToken>[1]> = {}) =>
    verifyBearerToken(`Bearer ${t}`, { jwks, audience: AUDIENCE, issuer: ISSUER, ...over });

  describe("caller identity", () => {
    it("accepts an access token with no name claim at all", async () => {
      // The case that would have taken production down: Entra access tokens
      // omit `name` unless the app registration adds it as an optional claim.
      // A missing display name must never cost a caller their access.
      const result = await verify(await token());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.identity.oid).toBe("caller-oid-1");
        // Attribution falls back to the object id, which the audit trail keys on.
        expect(result.identity.name).toBe("caller-oid-1");
      }
    });

    it("prefers name, then preferred_username, then upn", async () => {
      const full = await verify(
        await token({ name: "Ada Lovelace", preferred_username: "ada@corp.com", upn: "ada@corp.com" })
      );
      expect(full.ok && full.identity.name).toBe("Ada Lovelace");

      const noName = await verify(await token({ preferred_username: "ada@corp.com", upn: "a@corp.com" }));
      expect(noName.ok && noName.identity.name).toBe("ada@corp.com");

      const upnOnly = await verify(await token({ upn: "ada@corp.com" }));
      expect(upnOnly.ok && upnOnly.identity.name).toBe("ada@corp.com");
    });

    it("ignores a blank name claim rather than attributing requests to an empty string", async () => {
      const result = await verify(await token({ name: "   ", preferred_username: "ada@corp.com" }));
      expect(result.ok && result.identity.name).toBe("ada@corp.com");
    });

    it("still rejects a token with no oid — there is nothing to attribute to", async () => {
      const t = await new SignJWT({ name: "No Oid" })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime("1h")
        .sign(privateKey);
      const result = await verify(t);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.error.code).toBe("auth_invalid");
    });
  });

  describe("team attribution", () => {
    it("reads team from the configured directory claim", async () => {
      const result = await verify(await token({ department: "platform" }));
      expect(result.ok && result.identity.team).toBe("platform");
    });

    it("honours a custom TEAM_CLAIM", async () => {
      const result = await verify(await token({ extn_costCentre: "search" }), {
        teamClaim: "extn_costCentre",
      });
      expect(result.ok && result.identity.team).toBe("search");
    });

    it("does not invent a team from group GUIDs", async () => {
      // Groups are unordered GUIDs; picking one would make a caller's team
      // change between logins and fill the cost report with identifiers.
      const result = await verify(
        await token({ groups: ["8f14e45f-ceea-467a-9f8b-1c1d0f1e2a3b", "c9f0f895-fb98-4ebc-b3f4-1f4d5e6a7b8c"] })
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.identity.team).toBeUndefined();
    });

    it("survives group-claim overage without a team rather than failing the request", async () => {
      // Past ~200 groups Entra drops `groups` and points at Graph instead.
      // The caller must still be served; they simply have no team label.
      const result = await verify(
        await token({
          _claim_names: { groups: "src1" },
          _claim_sources: { src1: { endpoint: "https://graph.microsoft.com/v1.0/users/x/getMemberObjects" } },
        })
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.identity.team).toBeUndefined();
    });
  });

  describe("audience", () => {
    it("accepts any of several configured audiences", async () => {
      const clientIdToken = await token({}, { audience: "22222222-3333-4444-5555-666666666666" });
      const result = await verify(clientIdToken, {
        audience: [AUDIENCE, "22222222-3333-4444-5555-666666666666"],
      });
      expect(result.ok).toBe(true);
    });

    it("rejects a token minted for another resource", async () => {
      // The Open WebUI trap: a token issued for a different API must not be
      // usable here just because it is a valid Entra token.
      const other = await token({}, { audience: "api://some-other-service" });
      const result = await verify(other);
      expect(result.ok).toBe(false);
    });
  });

  describe("tenant pinning", () => {
    it("rejects a token from a different tenant when a tenant is pinned", async () => {
      const foreign = await new SignJWT({ oid: "x", tid: "99999999-0000-0000-0000-000000000000" })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime("1h")
        .sign(privateKey);
      const result = await verify(foreign, { tenantId: TENANT });
      expect(result.ok).toBe(false);
    });

    it("accepts the pinned tenant", async () => {
      const result = await verify(await token(), { tenantId: TENANT });
      expect(result.ok).toBe(true);
    });
  });

  describe("algorithm and timing", () => {
    it("rejects an unsigned token", async () => {
      const unsecured = new UnsecuredJWT({ oid: "x" })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime("1h")
        .encode();
      const result = await verify(unsecured);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.error.code).toBe("auth_invalid");
    });

    it("tolerates small clock skew on a token that is not yet valid", async () => {
      const t = await new SignJWT({ oid: "skewed" })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuedAt()
        .setNotBefore(Math.floor(Date.now() / 1000) + 20)
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime("1h")
        .sign(privateKey);
      expect((await verify(t)).ok).toBe(true);
    });

    it("still rejects a token whose nbf is beyond the skew allowance", async () => {
      const t = await new SignJWT({ oid: "way-early" })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuedAt()
        .setNotBefore(Math.floor(Date.now() / 1000) + 600)
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime("2h")
        .sign(privateKey);
      expect((await verify(t)).ok).toBe(false);
    });

    it("accepts a token that expired within the skew allowance", async () => {
      const t = await new SignJWT({ oid: "just-expired" })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuedAt(Math.floor(Date.now() / 1000) - 120)
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 20)
        .sign(privateKey);
      expect((await verify(t)).ok).toBe(true);
    });
  });

  describe("key rotation", () => {
    it("rejects a token signed by a key absent from the JWKS", async () => {
      const { privateKey: rogue } = await generateKeyPair("RS256");
      const t = await new SignJWT({ oid: "rogue" })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime("1h")
        .sign(rogue);
      expect((await verify(t)).ok).toBe(false);
    });

    it("selects the right key by kid when the JWKS holds several", async () => {
      // Mid-rotation Entra publishes the outgoing and incoming keys together.
      const { publicKey: pub2, privateKey: priv2 } = await generateKeyPair("RS256");
      const jwk1 = await exportJWK((await generateKeyPair("RS256")).publicKey);
      jwk1.kid = "old";
      jwk1.alg = "RS256";
      const jwk2 = await exportJWK(pub2);
      jwk2.kid = "new";
      jwk2.alg = "RS256";
      const rotating = createLocalJwksSource({ keys: [jwk1, jwk2] });

      const t = await new SignJWT({ oid: "rotated" })
        .setProtectedHeader({ alg: "RS256", kid: "new" })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime("1h")
        .sign(priv2);

      const result = await verifyBearerToken(`Bearer ${t}`, {
        jwks: rotating,
        audience: AUDIENCE,
        issuer: ISSUER,
      });
      expect(result.ok).toBe(true);
    });
  });
});
