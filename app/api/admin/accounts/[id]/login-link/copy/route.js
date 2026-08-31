import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { generateId } from "@/lib/auth-crypto";
import { buildLoginLinkUrl } from "@/lib/loginLink";

// PASSWORDLESS-CUSTOMER-LOGIN batch: admin-only, single-customer login
// link retrieval (spec Part 12). Deliberately its OWN dedicated
// endpoint rather than a field on the normal accounts-list response --
// the raw URL must exist "transiently only" and never be included in
// GET /api/admin/accounts (spec: "do NOT include all customer login
// URLs in the normal accounts-list API response").
//
// Every customer (both brand-new JVZoo-provisioned accounts AND
// pre-existing customers created before this batch) can have a
// working link generated here -- spec Part 10 explicitly requires
// "existing customers should also have a valid link available through
// Admin User Management" (no email is sent by this route; it only
// mints/returns the URL for an admin to copy). accounts.
// login_link_version defaults to 1 for every row (including
// pre-existing rows, via lib/db.js's ensureColumn DEFAULT), so this
// works identically for old and new customers with no backfill step.
//
// Security: same requireAdmin() + isSameOrigin() pattern as every
// other admin/[id] route in this codebase (e.g.
// app/api/admin/accounts/[id]/disable/route.js) -- proxy.js already
// blocks non-admin cookies from /api/admin/* at the edge, but this
// route independently re-verifies role server-side (defense in
// depth), and independently rejects cross-origin state-reads the same
// way state-changes are rejected elsewhere (this technically only
// *reads* a live credential-equivalent value, so it is treated with
// the same CSRF discipline as a mutating route).
//
// AUDIT LOGGING: records that a copy happened (event type
// "login_link_copied") WITHOUT ever writing the raw URL/signature
// into audit_log (spec Part 16). Never logged to the server console
// either.
export async function POST(request, { params }) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const guard = await requireAdmin();
  if (!guard.account) {
    return NextResponse.json({ error: guard.errorMessage }, { status: guard.errorStatus });
  }

  const { id: targetId } = await params;
  const db = getDb();
  const target = db
    .prepare(`SELECT id, email, role, auth_mode, login_link_version, account_status FROM accounts WHERE id = ?`)
    .get(targetId);
  if (!target) {
    return NextResponse.json({ error: "Account not found." }, { status: 404 });
  }
  if (target.auth_mode !== "login_link") {
    // PASSWORDLESS-CUSTOMER-LOGIN batch: durable legacy/new gate (spec
    // Part 2/3) -- legacy_password customers (and admin accounts,
    // which never carry auth_mode='login_link') must NEVER have a
    // working login link minted for them, even via this admin-only
    // endpoint. role==='customer' alone is NOT sufficient here, since
    // every pre-existing customer is also role==='customer'.
    return NextResponse.json({ error: "This account does not use passwordless login links." }, { status: 400 });
  }

  const url = buildLoginLinkUrl(target.id, target.login_link_version);
  if (!url) {
    return NextResponse.json({ error: "Login link signing is not configured." }, { status: 500 });
  }

  db.prepare(
    `INSERT INTO audit_log (id, admin_account_id, target_account_id, action, before_json, after_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    generateId("audit"),
    guard.account.id,
    targetId,
    "login_link_copied",
    null,
    // Never the URL/signature itself -- only the non-secret version
    // number, which reveals nothing usable without the signing secret.
    JSON.stringify({ loginLinkVersion: target.login_link_version }),
    new Date().toISOString()
  );

  return NextResponse.json({ ok: true, url });
}
