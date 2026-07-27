import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

// Lists real accounts created via the purchase webhook / login system
// (separate from the client-side Zustand demo users on the main site).
// Used by the Admin Panel's "Real Accounts" table.
//
// NOTE: this is the minimal Phase 1/2 read-only listing (extended in Phase
// 2 with ISP workflow fields so admin ISP approval can be tested/driven).
// The full admin customer-management table/search/actions UI is Phase 5.
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
      `SELECT id, email, name, must_change_password, role, account_status, created_at,
              isp_status, isp_submitted_at, isp_approved_at, user_authorized_at, node_connected_at
       FROM accounts ORDER BY created_at DESC`
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
      ispStatus: a.isp_status,
      ispSubmittedAt: a.isp_submitted_at,
      ispApprovedAt: a.isp_approved_at,
      userAuthorizedAt: a.user_authorized_at,
      nodeConnectedAt: a.node_connected_at,
      createdAt: a.created_at,
    })),
    recentEmails: outbox,
  });
}
