import { NextResponse } from "next/server";
import { randomBytes, createHash } from "node:crypto";
import { authConfig } from "@/lib/auth";

const base64url = (buf: Buffer) => buf.toString("base64url");

/**
 * Starts the OIDC authorization-code flow with PKCE.
 *
 * State and the PKCE verifier are stashed in short-lived httpOnly cookies
 * rather than server memory, so any dashboard replica can complete the flow
 * that another replica began.
 */
export async function GET() {
  if (authConfig.simMode) {
    // Nothing to log into in sim mode.
    return NextResponse.redirect(`${authConfig.appUrl}/`);
  }

  if (!authConfig.tenantId || !authConfig.clientId) {
    return NextResponse.redirect(`${authConfig.appUrl}/login?error=not_configured`);
  }

  const state = base64url(randomBytes(24));
  const codeVerifier = base64url(randomBytes(48));
  const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());

  const params = new URLSearchParams({
    client_id: authConfig.clientId,
    response_type: "code",
    redirect_uri: authConfig.redirectUri,
    response_mode: "query",
    // openid+profile identifies the admin; no Graph scopes are requested
    // because the dashboard never calls Graph.
    scope: "openid profile email",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  const res = NextResponse.redirect(`${authConfig.authorizeUrl}?${params.toString()}`);
  const cookieOpts = {
    httpOnly: true,
    secure: authConfig.appUrl.startsWith("https://"),
    sameSite: "lax" as const,
    path: "/",
    maxAge: 600,
  };
  res.cookies.set("cd_oauth_state", state, cookieOpts);
  res.cookies.set("cd_oauth_verifier", codeVerifier, cookieOpts);
  return res;
}
