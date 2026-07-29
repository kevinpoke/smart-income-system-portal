import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { getPayoutTargetAt } from "@/lib/earningsEngine";

// Lists real accounts created via the purchase webhook / login system
// (separate from the client-side Zustand demo users on the main site).
// Used by the Admin Panel's User Management table.
//
// SECURITY: proxy.js already blocks non-admin cookies from ever reaching
// /api/admin/*, but per the CRITICAL IMPLEMENTATION RULES every admin API
// route must independently re-verify role server-side (defense in depth --
// proxy matchers can be bypassed by future routing changes).
//
// Portal reliability pass: this route is now server-side searchable,
// sortable, and paginated so User Management stays fast and usable with
// hundreds of customers (see lib/db.js for the accompanying
// idx_accounts_created_at / idx_accounts_last_login_at / idx_accounts_email
// indexes). Query params:
//   q         -- case-insensitive substring match against name OR email
//   sortBy    -- "createdAt" (default) | "lastLoginAt"
//   sortDir   -- "desc" (default, newest first) | "asc" (oldest first)
//   page      -- 1-indexed page number (default 1)
//   pageSize  -- rows per page (default 20, capped at 100)
// Response includes { accounts, recentEmails, total, page, pageSize,
// totalPages } so the client can render pagination controls without a
// second round-trip.
//
// Also now exposes lastLoginAt, waitlistJoined (Yes/No, from the SAME
// persisted accounts.waitlist_joined_at column the customer-facing
// waitlist widget reads -- lib/waitlistEngine.js), and payoutTargetAt/
// payoutAvailable computed via the SAME shared helper
// (lib/earningsEngine.js getPayoutTargetAt) the Dashboard and
// Withdrawals page use, so the admin table's "Withdraw" countdown can
// never disagree with what the customer themselves sees.
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const SORTABLE_COLUMNS = {
  createdAt: "created_at",
  lastLoginAt: "last_login_at",
};

export async function GET(request) {
  const guard = await requireAdmin();
  if (!guard.account) {
    return NextResponse.json({ error: guard.errorMessage }, { status: guard.errorStatus });
  }

  const { searchParams } = new URL(request.url);
  const q = (searchParams.get("q") || "").trim();
  const sortByParam = searchParams.get("sortBy") || "createdAt";
  const sortBy = SORTABLE_COLUMNS[sortByParam] ? sortByParam : "createdAt";
  const sortDir = searchParams.get("sortDir") === "asc" ? "ASC" : "DESC";
  const page = Math.max(1, Number.parseInt(searchParams.get("page"), 10) || 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Number.parseInt(searchParams.get("pageSize"), 10) || DEFAULT_PAGE_SIZE)
  );
  const offset = (page - 1) * pageSize;

  const db = getDb();

  // Case-insensitive substring search over name OR email. LOWER() on a
  // small/medium accounts table (hundreds of rows, per spec's own scale
  // target) is plenty fast without a dedicated collation index; the
  // existing idx_accounts_email index still helps the common
  // exact/prefix-email case via the query planner's LIKE optimization
  // where applicable.
  const where = q ? `WHERE LOWER(name) LIKE ? OR LOWER(email) LIKE ?` : "";
  const likeParam = `%${q.toLowerCase()}%`;
  const whereParams = q ? [likeParam, likeParam] : [];

  const totalRow = db
    .prepare(`SELECT COUNT(*) as c FROM accounts ${where}`)
    .get(...whereParams);
  const total = totalRow.c;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const orderColumn = SORTABLE_COLUMNS[sortBy];
  // NULLS handling: SQLite sorts NULL first in ASC and last in DESC by
  // default, which is the natural, correct behavior here (accounts that
  // have "Never" logged in sort to the end in a newest-first view and to
  // the beginning in an oldest-first view) -- no special-casing needed.
  const accounts = db
    .prepare(
      `SELECT id, email, name, must_change_password, role, account_status, created_at,
              last_login_at, waitlist_joined_at,
              isp_status, isp_submitted_at, isp_approved_at, user_authorized_at, node_connected_at,
              current_balance_cents, lifetime_earnings_cents, modules_unlocked
       FROM accounts ${where}
       ORDER BY ${orderColumn} ${sortDir}
       LIMIT ? OFFSET ?`
    )
    .all(...whereParams, pageSize, offset);

  const outbox = db
    .prepare(
      `SELECT id, to_email, subject, sent_via, created_at FROM outbox ORDER BY created_at DESC LIMIT 20`
    )
    .all();

  return NextResponse.json({
    accounts: accounts.map((a) => {
      const { payoutTargetAt, payoutAvailable } = getPayoutTargetAt(a);
      return {
        id: a.id,
        email: a.email,
        name: a.name,
        role: a.role,
        accountStatus: a.account_status,
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
        currentBalanceCents: a.current_balance_cents,
        lifetimeEarningsCents: a.lifetime_earnings_cents,
        modulesUnlocked: Boolean(a.modules_unlocked),
        createdAt: a.created_at,
        lastLoginAt: a.last_login_at,
        waitlistJoined: Boolean(a.waitlist_joined_at),
        payoutTargetAt,
        payoutAvailable,
      };
    }),
    recentEmails: outbox,
    total,
    page,
    pageSize,
    totalPages,
  });
}
