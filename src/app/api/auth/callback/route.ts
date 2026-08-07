import { NextResponse, type NextRequest } from "next/server";
import {
  SESSION_COOKIE,
  authConfig,
  createSessionCookieValue,
  exchangeCodeForTokens,
  sessionFromIdToken,
} from "@/lib/auth";

/** Completes the OIDC flow: validates state, exchanges the code, sets the session. */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const loginUrl = (error: string) => `${authConfig.appUrl}/login?error=${encodeURIComponent(error)}`;

  const entraError = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  if (entraError) return NextResponse.redirect(loginUrl(entraError));

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = request.cookies.get("cd_oauth_state")?.value;
  const codeVerifier = request.cookies.get("cd_oauth_verifier")?.value;

  if (!code || !state || !codeVerifier) return NextResponse.redirect(loginUrl("incomplete_callback"));
  // Constant-time comparison is unnecessary here: state is a public
  // CSRF nonce, not a secret, and a mismatch simply restarts the flow.
  if (state !== expectedState) return NextResponse.redirect(loginUrl("state_mismatch"));

  const tokens = await exchangeCodeForTokens(code, codeVerifier);
  if (!tokens.ok) return NextResponse.redirect(loginUrl(tokens.error));

  const result = await sessionFromIdToken(tokens.idToken);
  if (!result.ok) return NextResponse.redirect(loginUrl(result.error));

  const res = NextResponse.redirect(`${authConfig.appUrl}/`);
  res.cookies.set(SESSION_COOKIE, await createSessionCookieValue(result.session), {
    httpOnly: true,
    secure: authConfig.appUrl.startsWith("https://"),
    sameSite: "lax",
    path: "/",
    maxAge: 8 * 60 * 60,
  });
  // One-shot values; leaving them around would let a stale flow be replayed.
  res.cookies.delete("cd_oauth_state");
  res.cookies.delete("cd_oauth_verifier");
  return res;
}
