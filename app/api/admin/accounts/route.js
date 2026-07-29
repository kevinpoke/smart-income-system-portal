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
// Refinement pass: adds server-side per-column filters on top of the
// existing search/sort/pagination (see the "User Management Filters and
// Pagination" spec section). Every filter is applied via SQL WHERE
// clauses (with the accompanying indexes in lib/db.js) so filtering never
// requires loading the full accounts table into the browser, and
// filters compose with search/sort/pagination rather than replacing them.
// Query params:
//   q               -- case-insensitive substring match against name OR email
//   sortBy          -- "createdAt" (default) | "lastLoginAt"
//   sortDir         -- "desc" (default, newest first) | "asc" (oldest first)
//   page            -- 1-indexed page number (default 1)
//   pageSize        -- rows per page (default 30, capped at 100)
//   status          -- "active" | "disabled" | "all" (default "all")
//   isp             -- "on" (isp_status active AND wifi on) | "off" | "all"
//   balanceMin      -- minimum balance in DOLLARS (converted to cents)
//   balanceMax      -- maximum balance in DOLLARS (converted to cents)
//   joinedFrom      -- ISO date string, inclusive lower bound on created_at
//   joinedTo        -- ISO date string, inclusive upper bound on created_at
//   lastLogin       -- "never" | "range" | "all" (default "all")
//   lastLoginFrom   -- ISO date string, used when lastLogin=range
//   lastLoginTo     -- ISO date string, used when lastLogin=range
//   withdraw        -- "available" | "not_available" | "all" (default "all")
//   waitlist        -- "yes" | "no" | "all" (default "all")
// Response includes { accounts, recentEmails, total, page, pageSize,
// totalPages } so the client can render pagination controls without a
// second round-trip.
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;
const SORTABLE_COLUMNS = {
  createdAt: "created_at",
  lastLoginAt: "last_login_at",
};

function dollarsToCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

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

  const status = searchParams.get("status") || "all";
  const isp = searchParams.get("isp") || "all";
  const balanceMinParam = searchParams.get("balanceMin");
  const balanceMaxParam = searchParams.get("balanceMax");
  const joinedFrom = searchParams.get("joinedFrom") || "";
  const joinedTo = searchParams.get("joinedTo") || "";
  const lastLogin = searchParams.get("lastLogin") || "all";
  const lastLoginFrom = searchParams.get("lastLoginFrom") || "";
  const lastLoginTo = searchParams.get("lastLoginTo") || "";
  const withdraw = searchParams.get("withdraw") || "all";
  const waitlist = searchParams.get("waitlist") || "all";

  const db = getDb();

  const clauses = [];
  const params = [];

  if (q) {
    clauses.push(`(LOWER(name) LIKE ? OR LOWER(email) LIKE ?)`);
    const likeParam = `%${q.toLowerCase()}%`;
    params.push(likeParam, likeParam);
  }
  if (status === "active" || status === "disabled") {
    clauses.push(`account_status = ?`);
    params.push(status);
  }
  if (isp === "on") {
    // "On (Actively running)" per spec -- ISP setup active AND the
    // customer's own WiFi toggle currently on.
    clauses.push(`(isp_status = 'active' AND wifi_enabled = 1)`);
  } else if (isp === "off") {
    clauses.push(`NOT (isp_status = 'active' AND wifi_enabled = 1)`);
  }
  const balanceMinCents = balanceMinParam !== null ? dollarsToCents(balanceMinParam) : null;
  const balanceMaxCents = balanceMaxParam !== null ? dollarsToCents(balanceMaxParam) : null;
  if (balanceMinCents !== null) {
    clauses.push(`current_balance_cents >= ?`);
    params.push(balanceMinCents);
  }
  if (balanceMaxCents !== null) {
    clauses.push(`current_balance_cents <= ?`);
    params.push(balanceMaxCents);
  }
  if (joinedFrom) {
    clauses.push(`created_at >= ?`);
    params.push(joinedFrom);
  }
  if (joinedTo) {
    // Inclusive of the whole day when a bare date (no time component) is
    // supplied -- append a time ceiling so "2026-07-28" includes that day.
    clauses.push(`created_at <= ?`);
    params.push(joinedTo.length <= 10 ? `${joinedTo}T23:59:59.999Z` : joinedTo);
  }
  if (lastLogin === "never") {
    clauses.push(`last_login_at IS NULL`);
  } else if (lastLogin === "range") {
    if (lastLoginFrom) {
      clauses.push(`last_login_at >= ?`);
      params.push(lastLoginFrom);
    }
    if (lastLoginTo) {
      clauses.push(`last_login_at <= ?`);
      params.push(lastLoginTo.length <= 10 ? `${lastLoginTo}T23:59:59.999Z` : lastLoginTo);
    }
  }
  if (waitlist === "yes") {
    clauses.push(`waitlist_joined_at IS NOT NULL`);
  } else if (waitlist === "no") {
    clauses.push(`waitlist_joined_at IS NULL`);
  }

  // Withdraw availability depends on calendar-month math
  // (lib/earningsEngine.js addCalendarMonths) that SQLite's own date
  // modifiers cannot reproduce exactly (SQLite's "+N months" has a
  // documented day-overflow bug -- see the addCalendarMonths comment for
  // the concrete Jan-31 example). Rather than risk a filter that
  // disagrees with what the customer/admin actually sees elsewhere, this
  // computes eligibility in JS via the SAME shared helper and narrows the
  // main query to matching ids. Bounded by this app's stated "hundreds of
  // customers" scale target, so one extra lightweight (id + timestamp
  // only) query is an acceptable cost for exact correctness.
  let withdrawIds = null;
  if (withdraw === "available" || withdraw === "not_available") {
    const candidateWhere = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const candidates = db
      .prepare(`SELECT id, node_connected_at FROM accounts ${candidateWhere}`)
      .all(...params);
    withdrawIds = candidates
      .filter((c) => {
        const { payoutAvailable } = getPayoutTargetAt(c);
        return withdraw === "available" ? payoutAvailable : !payoutAvailable;
      })
      .map((c) => c.id);
    if (withdrawIds.length === 0) {
      return NextResponse.json({
        accounts: [],
        recentEmails: [],
        total: 0,
        page,
        pageSize,
        totalPages: 1,
      });
    }
    clauses.push(`id IN (${withdrawIds.map(() => "?").join(",")})`);
    params.push(...withdrawIds);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  const totalRow = db.prepare(`SELECT COUNT(*) as c FROM accounts ${where}`).get(...params);
  const total = totalRow.c;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const orderColumn = SORTABLE_COLUMNS[sortBy];
  // NULLS handling: SQLite sorts NULL first in ASC and last in DESC by
  // default, which is the natural, correct behavior here (accounts that
  // have "Never" logged in sort to the end in a newest-first view and to
  // the beginning in an oldest-first view) -- no special-casing needed.
  const accounts = db
    .prepare(
      `SELECT id, email, name, first_name, last_name, must_change_password, role, account_status, created_at,
              last_login_at, waitlist_joined_at,
              isp_status, isp_submitted_at, isp_approved_at, user_authorized_at, node_connected_at,
              current_balance_cents, lifetime_earnings_cents, modules_unlocked, wifi_enabled
       FROM accounts ${where}
       ORDER BY ${orderColumn} ${sortDir}
       LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, offset);

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
        firstName: a.first_name,
        lastName: a.last_name,
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
        wifiEnabled: Boolean(a.wifi_enabled),
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
