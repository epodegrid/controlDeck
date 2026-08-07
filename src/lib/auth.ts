import { cookies } from "next/headers";
import { SignJWT, jwtVerify, createRemoteJWKSet } from "jose";

/**
 * Dashboard authentication (PRD §6.1).
 *
 * Admin access is gated entirely by Entra SSO group membership. There is no
 * platform-side user table and no platform-side roles — if you are in the
 * configured admin group, you see everything; if you are not, you see nothing.
 *
 * Two modes, matching the router's:
 *   sim        — a fixed local admin session, no tenant required. Clearly
 *                labelled in the UI so it can never be mistaken for a real
 *                login.
 *   production — full OIDC authorization-code flow against Entra.
 *
 * The session itself is a short-lived signed JWT in an httpOnly cookie. We
 * deliberately do not keep server-side session state: the router tier is
 * multi-replica (§8) and a shared session store would be one more thing to
 * run and to synchronise.
 */

export const SESSION_COOKIE = "cd_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;

export const authConfig = {
  simMode: process.env.SIM_MODE === "true",
  tenantId: process.env.DASHBOARD_ENTRA_TENANT_ID ?? "",
  clientId: process.env.DASHBOARD_ENTRA_CLIENT_ID ?? "",
  clientSecret: process.env.DASHBOARD_ENTRA_CLIENT_SECRET ?? "",
  adminGroupId: process.env.DASHBOARD_ADMIN_GROUP_ID ?? "",
  /**
   * App role granting admin access, e.g. `Admin`.
   *
   * Preferred over a group id. The `roles` claim is scoped to this single
   * application, so it cannot overflow the way `groups` does — past ~200
   * groups Entra stops sending the list entirely and substitutes a Graph
   * pointer, which silently locks out exactly the people who are in the most
   * groups. It is also the better question to ask: "is this person an admin of
   * this application" rather than "what groups is this person in".
   */
  adminRole: process.env.DASHBOARD_ADMIN_ROLE ?? "",
  appUrl: process.env.DASHBOARD_APP_URL ?? "http://localhost:3000",
  /**
   * Identity authority host. Configurable because "Entra" is not one endpoint:
   * sovereign clouds live elsewhere (`login.microsoftonline.us` for Azure
   * Government, `login.chinacloudapi.cn` for China), and pointing this at the
   * bundled mock provider is what makes the sign-in flow testable without a
   * tenant.
   */
  authority: (process.env.DASHBOARD_ENTRA_AUTHORITY ?? "https://login.microsoftonline.com").replace(/\/+$/, ""),
  /**
   * Endpoints are derived from the authority and tenant id rather than fetched
   * from a discovery document: PRD §8 forbids unconfigured outbound calls, and
   * OIDC discovery would be exactly that.
   */
  get authorizeUrl() {
    return `${this.authority}/${this.tenantId}/oauth2/v2.0/authorize`;
  },
  get tokenUrl() {
    return `${this.authority}/${this.tenantId}/oauth2/v2.0/token`;
  },
  get jwksUri() {
    return `${this.authority}/${this.tenantId}/discovery/v2.0/keys`;
  },
  get issuer() {
    return `${this.authority}/${this.tenantId}/v2.0`;
  },
  get redirectUri() {
    return `${this.appUrl}/api/auth/callback`;
  },
};

export type Session = {
  oid: string;
  name: string;
  email: string;
  /** Two-letter avatar initials, derived from the display name. */
  initials: string;
  /** True when this is the sim-mode stand-in rather than a real Entra login. */
  simulated: boolean;
};

function sessionSecret(): Uint8Array {
  const secret = process.env.DASHBOARD_SESSION_SECRET;
  if (!secret) {
    if (authConfig.simMode) {
      // Stable within a process so sim sessions survive navigation, but never
      // a value anyone could mistake for production-grade.
      return new TextEncoder().encode("controldeck-sim-mode-session-secret-not-for-production");
    }
    throw new Error(
      "DASHBOARD_SESSION_SECRET must be set in production — it signs the admin session cookie."
    );
  }
  if (secret.length < 32) {
    throw new Error("DASHBOARD_SESSION_SECRET must be at least 32 characters.");
  }
  return new TextEncoder().encode(secret);
}

export function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** The fixed identity used in sim mode, where there is no tenant to log into. */
export const SIM_SESSION: Session = {
  oid: "00000000-0000-0000-0000-00000000sim0",
  name: "Sim Admin",
  email: "sim-admin@localhost",
  initials: "SA",
  simulated: true,
};

export async function createSessionCookieValue(session: Session): Promise<string> {
  return new SignJWT({ ...session })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(sessionSecret());
}

/**
 * Resolves the current admin session, or null if unauthenticated.
 * In sim mode this always succeeds — there is nothing to log into.
 */
export async function getSession(): Promise<Session | null> {
  if (authConfig.simMode) return SIM_SESSION;

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, sessionSecret());
    return {
      oid: String(payload.oid ?? ""),
      name: String(payload.name ?? "Unknown"),
      email: String(payload.email ?? ""),
      initials: String(payload.initials ?? "?"),
      simulated: false,
    };
  } catch {
    // Expired or tampered-with: treat as signed out rather than erroring.
    return null;
  }
}

/**
 * Explains *why* access was refused, distinguishing the three causes that look
 * identical from the outside — genuinely not a member, the claim was never
 * configured, or the claim overflowed. Without this an operator sees "not a
 * member" for a user who demonstrably is one, and has nothing to go on.
 */
function accessDeniedMessage(payload: Record<string, unknown>): string {
  const overflowed =
    typeof payload._claim_names === "object" &&
    payload._claim_names !== null &&
    "groups" in (payload._claim_names as Record<string, unknown>);

  if (overflowed) {
    return (
      "Your group membership could not be read from the sign-in token. This account belongs to " +
      "too many groups for Entra to list them in a token, so it sent a lookup reference instead. " +
      "Fix this by granting admin access with an app role (DASHBOARD_ADMIN_ROLE) instead of a " +
      "group id, or by setting the app registration's groups claim to " +
      '"Groups assigned to the application".'
    );
  }

  const configured: string[] = [];
  if (authConfig.adminRole) configured.push(`app role "${authConfig.adminRole}"`);
  if (authConfig.adminGroupId) configured.push("the configured admin group");

  return (
    `Your account does not hold ${configured.join(" or ")}. ` +
    "If you believe it should, check that the app registration is configured to emit the " +
    "corresponding roles or groups claim — a claim that is never issued looks identical to one " +
    "you are not a member of."
  );
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

/**
 * Validates the id_token returned by Entra and enforces admin group
 * membership. Returns the session to persist, or an error string explaining
 * why access was refused.
 */
export async function sessionFromIdToken(
  idToken: string
): Promise<{ ok: true; session: Session } | { ok: false; error: string }> {
  if (!jwks) jwks = createRemoteJWKSet(new URL(authConfig.jwksUri));

  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, jwks, {
      issuer: authConfig.issuer,
      audience: authConfig.clientId,
    }));
  } catch (err) {
    return { ok: false, error: `Token validation failed: ${err instanceof Error ? err.message : "unknown"}` };
  }

  // §6.1: authorization is directory membership, nothing else — there is no
  // platform-side role table. Either an app role or a group may be configured;
  // satisfying any configured check is enough, so a tenant can migrate from
  // groups to roles without a flag day. Configuring neither means any tenant
  // member who can reach the dashboard may use it, which is a deliberate
  // operator choice rather than an oversight.
  const roles = Array.isArray(payload.roles) ? (payload.roles as string[]) : [];
  const groups = Array.isArray(payload.groups) ? (payload.groups as string[]) : [];

  const checks: boolean[] = [];
  if (authConfig.adminRole) checks.push(roles.includes(authConfig.adminRole));
  if (authConfig.adminGroupId) checks.push(groups.includes(authConfig.adminGroupId));

  if (checks.length > 0 && !checks.some(Boolean)) {
    return { ok: false, error: accessDeniedMessage(payload) };
  }

  const name = String(payload.name ?? payload.preferred_username ?? "Unknown");
  return {
    ok: true,
    session: {
      oid: String(payload.oid ?? payload.sub ?? ""),
      name,
      email: String(payload.preferred_username ?? payload.email ?? ""),
      initials: initialsFor(name),
      simulated: false,
    },
  };
}

/** Exchanges an authorization code for tokens. */
export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string
): Promise<{ ok: true; idToken: string } | { ok: false; error: string }> {
  const body = new URLSearchParams({
    client_id: authConfig.clientId,
    client_secret: authConfig.clientSecret,
    code,
    redirect_uri: authConfig.redirectUri,
    grant_type: "authorization_code",
    code_verifier: codeVerifier,
  });

  const res = await fetch(authConfig.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { ok: false, error: `Token exchange failed (${res.status}): ${detail.slice(0, 300)}` };
  }

  const json = (await res.json()) as { id_token?: string };
  if (!json.id_token) return { ok: false, error: "Entra response contained no id_token." };
  return { ok: true, idToken: json.id_token };
}
