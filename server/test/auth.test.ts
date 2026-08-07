import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import type { KeyLike } from "jose";
import { verifyBearerToken } from "../src/auth/verify.js";
import { createLocalJwksSource } from "../src/auth/jwks-source.js";
import type { JWKSSource } from "../src/auth/jwks-source.js";

const ISSUER = "https://login.microsoftonline.com/test-tenant/v2.0";
const AUDIENCE = "api://control-deck";

describe("verifyBearerToken", () => {
  let jwksSource: JWKSSource;
  let privateKey: KeyLike;
  let kid: string;

  let otherPrivateKey: KeyLike;

  beforeAll(async () => {
    const { publicKey, privateKey: priv } = await generateKeyPair("RS256");
    privateKey = priv;
    kid = "test-key-1";
    const jwk = await exportJWK(publicKey);
    jwk.kid = kid;
    jwk.alg = "RS256";
    jwk.use = "sig";
    const jwks = { keys: [jwk] };
    jwksSource = createLocalJwksSource(jwks);

    const otherPair = await generateKeyPair("RS256");
    otherPrivateKey = otherPair.privateKey;
  });

  async function signToken(overrides: {
    issuer?: string;
    audience?: string;
    expSecondsFromNow?: number;
    oid?: string;
    name?: string;
    preferred_username?: string;
    /** Extra claims merged into the payload, e.g. `department`, `tid`, `upn`. */
    claims?: Record<string, unknown>;
    signingKey?: KeyLike;
    kidOverride?: string;
    notBeforeSecondsFromNow?: number;
  } = {}) {
    const {
      issuer = ISSUER,
      audience = AUDIENCE,
      expSecondsFromNow = 3600,
      oid = "abc-123-oid",
      preferred_username,
      claims = {},
      signingKey = privateKey,
      kidOverride = kid,
      notBeforeSecondsFromNow,
    } = overrides;
    const name = "name" in overrides ? overrides.name : "Jane Doe";

    let builder = new SignJWT({
      oid,
      ...(name ? { name } : {}),
      ...(preferred_username ? { preferred_username } : {}),
      ...claims,
    })
      .setProtectedHeader({ alg: "RS256", kid: kidOverride })
      .setIssuedAt()
      .setIssuer(issuer)
      .setAudience(audience)
      .setExpirationTime(Math.floor(Date.now() / 1000) + expSecondsFromNow);

    if (notBeforeSecondsFromNow !== undefined) {
      builder = builder.setNotBefore(Math.floor(Date.now() / 1000) + notBeforeSecondsFromNow);
    }

    return builder.sign(signingKey);
  }

  it("returns ok with identity for a valid token", async () => {
    const token = await signToken({ claims: { department: "platform" } });
    const result = await verifyBearerToken(`Bearer ${token}`, {
      jwks: jwksSource,
      audience: AUDIENCE,
      issuer: ISSUER,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.oid).toBe("abc-123-oid");
      expect(result.identity.name).toBe("Jane Doe");
      expect(result.identity.team).toBe("platform");
    }
  });

  it("falls back to preferred_username for name when name claim absent", async () => {
    const token = await signToken({ name: undefined, preferred_username: "jane@example.com" });
    const result = await verifyBearerToken(`Bearer ${token}`, {
      jwks: jwksSource,
      audience: AUDIENCE,
      issuer: ISSUER,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.name).toBe("jane@example.com");
    }
  });

  it("rejects an expired token", async () => {
    const token = await signToken({ expSecondsFromNow: -3600 });
    const result = await verifyBearerToken(`Bearer ${token}`, {
      jwks: jwksSource,
      audience: AUDIENCE,
      issuer: ISSUER,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error.code).toBe("auth_invalid");
      expect(result.error.error.type).toBe("auth_error");
    }
  });

  it("rejects a token with the wrong audience", async () => {
    const token = await signToken({ audience: "api://someone-else" });
    const result = await verifyBearerToken(`Bearer ${token}`, {
      jwks: jwksSource,
      audience: AUDIENCE,
      issuer: ISSUER,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error.code).toBe("auth_invalid");
    }
  });

  it("rejects a token with the wrong issuer", async () => {
    const token = await signToken({ issuer: "https://login.microsoftonline.com/other-tenant/v2.0" });
    const result = await verifyBearerToken(`Bearer ${token}`, {
      jwks: jwksSource,
      audience: AUDIENCE,
      issuer: ISSUER,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error.code).toBe("auth_invalid");
    }
  });

  it("rejects a malformed header without 'Bearer ' prefix", async () => {
    const token = await signToken();
    const result = await verifyBearerToken(token, {
      jwks: jwksSource,
      audience: AUDIENCE,
      issuer: ISSUER,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error.code).toBe("auth_invalid");
      expect(result.error.error.type).toBe("auth_error");
    }
  });

  it("rejects a missing header", async () => {
    const result = await verifyBearerToken(undefined, {
      jwks: jwksSource,
      audience: AUDIENCE,
      issuer: ISSUER,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error.code).toBe("auth_invalid");
    }
  });

  it("rejects a token with a tampered signature", async () => {
    const token = await signToken({ signingKey: otherPrivateKey });
    const result = await verifyBearerToken(`Bearer ${token}`, {
      jwks: jwksSource,
      audience: AUDIENCE,
      issuer: ISSUER,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error.code).toBe("auth_invalid");
    }
  });

  it("never throws even on garbage input", async () => {
    await expect(
      verifyBearerToken("Bearer not-a-real-jwt", {
        jwks: jwksSource,
        audience: AUDIENCE,
        issuer: ISSUER,
      })
    ).resolves.toMatchObject({ ok: false });
  });
});
