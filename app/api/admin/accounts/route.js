import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

// Lists real accounts created via the purchase webhook / login system
// (separate from the client-side Zustand demo users on the main site).
// Used by the Admin Panel's "Real Accounts" table.
//
// SECURITY: proxy.js already blocks non-admin cookies from ever reaching
// /api/admin/*, but per the CRITICAL IMPLEMENTATION RULES every admin API
// route must independently re-verify role server-side (defense in depth --
// proxy matchers can be bypassed by future routing changes).
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.account) {
    return NextResponse.json({ error: guard.errorMessage }, { status: guard.errorStatus });
  }

  const db = getDb();
  const accounts = db
    .prepare(
      `SELECT id, email, name, must_change_password, role, account_status, created_at FROM accounts ORDER BY created_at DESC`
    )
    .all();

  const outbox = db
    .prepare(
      `SELECT id, to_email, subject, sent_via, created_at FROM outbox ORDER BY created_at DESC LIMIT 20`
    )
    .all();

  return NextResponse.json({
    accounts: accounts.map((a) => ({
      id: a.id,
      email: a.email,
      name: a.name,
      role: a.role,
      status: a.account_status === "disabled"
        ? "Disabled"
        : a.must_change_password
        ? "New (must change password)"
        : "Active",
      createdAt: a.created_at,
    })),
    recentEmails: outbox,
  });
}
