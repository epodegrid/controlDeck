import { NextResponse } from "next/server";
import { SESSION_COOKIE, authConfig } from "@/lib/auth";

/**
 * Clears the local session. We intentionally do not redirect on to Entra's
 * end-session endpoint: signing out of the dashboard should not sign the admin
 * out of every other Entra application in the same browser.
 */
export async function GET() {
  const res = NextResponse.redirect(`${authConfig.appUrl}/login?signed_out=1`);
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
