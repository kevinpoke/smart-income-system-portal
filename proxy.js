import { NextResponse } from "next/server";
import { getAccountByToken } from "@/lib/authz";

// Next.js 16 renamed `middleware.js` to `proxy.js` (see AGENTS.md note about
// breaking changes in this Next.js version — confirmed via
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md).
// Per that doc, Proxy defaults to the Node.js runtime (the `runtime` config
// option is not even selectable here), so it's safe to require the
// node:sqlite-backed session lookup directly instead of only checking
// whether a cookie is merely present.
//
// This is the FIRST line of defense: it redirects unauthenticated/invalid
// sessions to /login and blocks customers from /admin routes at the edge of
// routing. It is NOT the only line of defense -- every API route under
// app/api/admin/** independently re-verifies role server-side (see
// lib/session.js requireAdmin()), because proxy matchers can be
// accidentally bypassed by route changes and Server Functions are not
// separate routes in the proxy chain (see the runtime doc's warning).
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

  const token = request.cookies.get(COOKIE_NAME)?.value;
  const account = getAccountByToken(token);

  if (!account) {
    // Covers: no cookie, expired session, deleted session, and disabled
    // accounts (getAccountByToken revokes + refuses disabled accounts).
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    const res = NextResponse.redirect(loginUrl);
    // Clear a stale/invalid cookie so the browser doesn't keep resending it.
    res.cookies.delete(COOKIE_NAME);
    return res;
  }

  const isAdminRoute = pathname === "/admin" || pathname.startsWith("/admin/");
  const isAdminApi = pathname.startsWith("/api/admin/");

  if ((isAdminRoute || isAdminApi) && account.role !== "admin") {
    if (isAdminApi) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    return NextResponse.redirect(new URL("/", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|.*\\.(?:svg|png|jpg|jpeg|ico)$).*)"],
};
