import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";

/**
 * Gates every dashboard page behind a session (PRD §6.1).
 *
 * This only checks for the *presence* of a session cookie — verifying its
 * signature needs the secret, and middleware runs on the edge runtime where we
 * would rather not handle it. Pages call `getSession()` themselves, which does
 * verify; this is a cheap first pass so an unauthenticated visitor lands on
 * the sign-in screen instead of a page that renders empty and then redirects.
 */
export function middleware(request: NextRequest) {
  if (process.env.SIM_MODE === "true") return NextResponse.next();

  if (request.cookies.get(SESSION_COOKIE)) return NextResponse.next();

  const loginUrl = new URL("/login", request.url);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Everything except the auth endpoints, the sign-in screen, and static assets.
  matcher: ["/((?!api/auth|login|_next/static|_next/image|favicon.ico).*)"],
};
