import { NextResponse } from "next/server";

// Next.js 16 renamed `middleware.js` to `proxy.js` (see AGENTS.md note about
// breaking changes in this Next.js version — confirmed via
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md).
//
// Gate: any request without a valid session cookie gets redirected to
// /login, except for /login itself, the auth API routes, the purchase
// webhook, and Next's own static/internal assets.
const COOKIE_NAME = "sa_session";

const PUBLIC_PATHS = ["/login"];
const PUBLIC_PREFIXES = ["/api/auth", "/api/webhooks", "/_next", "/favicon.ico"];

export function proxy(request) {
  const { pathname } = request.nextUrl;

  const isPublic =
    PUBLIC_PATHS.includes(pathname) ||
    PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));

  if (isPublic) {
    return NextResponse.next();
  }

  const hasSession = request.cookies.has(COOKIE_NAME);
  if (!hasSession) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|.*\\.(?:svg|png|jpg|jpeg|ico)$).*)"],
};
