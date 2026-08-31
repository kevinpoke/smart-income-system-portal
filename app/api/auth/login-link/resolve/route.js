import { NextResponse } from "next/server";
import { resolveAccountForLoginLinkToken } from "@/lib/loginLinkAccess";

// PASSWORDLESS-CUSTOMER-LOGIN batch: tiny public GET endpoint used ONLY
// by app/l/[token]/page.js (a Server Component) to decide 404 vs. the
// email-entry form, WITHOUT that page importing lib/db directly.
//
// Every other page.js/layout.js Server Component in this codebase
// reaches the database exclusively through a Route Handler (never a
// direct lib/db import) -- Route Handlers are compiled as CommonJS
// and can use node:sqlite via `require` under the hood, while this
// Next.js version's Server Components are bundled as ESM and fail at
// module-eval time with "Failed to load external module node:sqlite:
// ReferenceError: require is not defined" if lib/db (or anything that
// imports it) is imported directly into a page.js. This route
// preserves that exact same architectural boundary for the new
// login-link page instead of introducing a one-off exception.
//
// Returns ONLY a boolean -- never the account id/email/status/refund
// reason, matching resolveAccountForLoginLinkToken()'s own "reveal
// nothing about the account" contract (spec Part 3).
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get("token") || "";
  const account = resolveAccountForLoginLinkToken(token);
  if (!account) {
    return NextResponse.json({ valid: false }, { status: 404 });
  }
  return NextResponse.json({ valid: true });
}
