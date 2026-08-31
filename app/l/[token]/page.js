import { headers } from "next/headers";
import { notFound } from "next/navigation";
import LoginLinkForm from "./LoginLinkForm";

// PASSWORDLESS-CUSTOMER-LOGIN batch: public unique login-link landing
// page. Deliberately a SERVER component (not client) so the
// malformed/modified/reset/disabled/refunded -> 404 decision (spec
// Part 3) happens entirely server-side via Next's real notFound(),
// before any HTML describing "an email form" is ever sent to a
// request carrying an invalid link -- an attacker probing links gets
// byte-for-byte the same 404 response Next already serves for any
// other nonexistent route, never a "this link is invalid but at least
// tells you a form would normally be here" tell.
//
// Resolves the token via the internal GET /api/auth/login-link/resolve
// Route Handler (a plain server-to-server fetch) rather than importing
// lib/db / lib/loginLinkAccess directly here -- every existing
// page.js/layout.js in this codebase reaches the database exclusively
// through a Route Handler; Route Handlers compile in a way that
// supports node:sqlite's native module, but this Next.js version's
// Server Component bundling does not (confirmed: importing lib/db
// straight into this page throws "Failed to load external module
// node:sqlite: ReferenceError: require is not defined" at module-eval
// time). Keeping the existing architectural boundary intact avoids
// that failure without any one-off workaround.
//
// proxy.js must allow this path publicly (unauthenticated) -- see the
// PUBLIC_PATHS/PUBLIC_PREFIXES update in proxy.js. This route reveals
// NOTHING about the account (not even that resolution succeeded) in
// its own right -- the only information disclosed to the browser is
// "render an email-entry form" vs. "404", identical to what an admin
// generating this link already knows.
export default async function LoginLinkPage({ params }) {
  const { token } = await params;

  const headerList = await headers();
  const host = headerList.get("host");
  const protocol = headerList.get("x-forwarded-proto") || "http";
  const base = `${protocol}://${host}`;

  const res = await fetch(`${base}/api/auth/login-link/resolve?token=${encodeURIComponent(token)}`, {
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({ valid: false }));

  if (!res.ok || !data.valid) {
    notFound();
  }

  // Only a non-identifying confirmation that SOME valid link resolved
  // is passed to the client -- never the account id, email, or any
  // other field. The client form re-submits the raw token (opaque to
  // it) plus the customer-entered email to the verify API, which does
  // its own full re-resolution server-side before ever creating a
  // session.
  return <LoginLinkForm token={token} />;
}
