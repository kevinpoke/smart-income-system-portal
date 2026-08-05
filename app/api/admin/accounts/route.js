import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { getPayoutTargetAt } from "@/lib/earningsEngine";
import { displayNameToTierKey } from "@/lib/nodeTiers";

// Lists real accounts created via the purchase webhook / login system
// (separate from the client-side Zustand demo users on the main site).
// Used by the Admin Panel's User Management table.
//
// SECURITY: proxy.js already blocks non-admin cookies from ever reaching
// /api/admin/*, but per the CRITICAL IMPLEMENTATION RULES every admin API
// route must independently re-verify role server-side (defense in depth --
// proxy matchers can be bypassed by future routing changes).
//
// User Management redesign: the old per-column FILTER UI (status/isp/
// balance-range/joined-range/last-login-range/withdraw/waitlist filter
// popovers) has been removed entirely and replaced with per-column
// SORTING -- global text search (`q`) is the only remaining filter.
// Every sort is still applied server-side; the client only ever
// receives the current page's rows, never the full account list.
// Query params:
//   q        -- case-insensitive substring match against name OR email
//   sortBy   -- "joined" (default) | "lastLogin" | "status" | "isp" |
//               "balance" | "withdraw" | "waitlist" | "node" | "city" |
//               "state" | "upsell"
//   sortDir  -- "desc" (default) | "asc"
//   page     -- 1-indexed page number (default 1)
//   pageSize -- rows per page (default 30, capped at 100)
// Response includes { accounts, recentEmails, total, page, pageSize,
// totalPages } so the client can render pagination controls without a
// second round-trip.
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;

// Plain SQL-column sorts. "withdraw" is handled separately below (it
// depends on lib/earningsEngine.js's calendar-month math, which
// SQLite's own date arithmetic cannot reproduce exactly -- see the
// addCalendarMonths comment there for the concrete Jan-31 example).
// "waitlist" is also handled separately (a derived Yes/No boolean, not
// a plain column) via a CASE expression.
const SQL_SORT_COLUMNS = {
  joined: "created_at",
  lastLogin: "last_login_at",
  status: "account_status",
  isp: "isp_status",
  balance: "current_balance_cents",
  city: "isp_city",
  state: "isp_state",
};

// User Management redesign: "Upsell" column. There is no dedicated
// upsell-purchase field anywhere in the real (SQLite) accounts schema --
// the only existing "upsell" concept in this codebase is
// lib/store.js's demo-only Zustand `upsellsPurchased` counter, which is
// client-side mock state for the OLD, now-unused simulated dashboard and
// is never read by any real account/admin route. Per spec ("use the
// existing canonical upsell-related account field if one already
// exists... do not invent duplicate storage"), the closest genuine
// server-persisted signal is completion of Training Module 3, "How to
// Earn More (Upsell)" (see lib/mockData.js MODULES_META id 3 and
// lib/moduleEngine.js / the account_module_progress table) -- this
// module's entire content IS the upsell pitch, and its completed_at
// column already exists for exactly this purpose. Rather than adding a
// new column that would duplicate information already derivable from
// account_module_progress, the Upsell column here reads
// account_module_progress.completed_at for module_key = 3 directly.
// "Yes" = the customer has completed the upsell training module (has
// engaged with the upsell pitch); "No" = not yet completed; non-customer
// rows show "—" since modules/upsell status is not a meaningful concept
// for admin accounts.
const UPSELL_COMPLETED_SUBQUERY = `(SELECT completed_at FROM account_module_progress WHERE account_module_progress.account_id = accounts.id AND account_module_progress.module_key = 3)`;

const ACCOUNT_SELECT_COLUMNS = `id, email, name, first_name, last_name, must_change_password, role, account_status, created_at,
              last_login_at, waitlist_joined_at,
              isp_status, isp_submitted_at, isp_approved_at, user_authorized_at, node_connected_at,
              isp_city, isp_state,
              current_balance_cents, lifetime_earnings_cents, modules_unlocked, wifi_enabled`;

// Primary Node tier per the PRIMARY NODE RULE (lib/ownedNodes.js): the
// earliest-created Node for an account, i.e. the row with the lowest
// node_number. Expressed as a SQL subquery (rather than a JS
// post-processing pass like the `withdraw`/`waitlist` special cases
// below) because `tier` is already a plain orderable string column on a
// child table -- a correlated subquery works natively in SQLite's own
// ORDER BY / SELECT list without needing to pull every account's full
// Node list into JS first.
const PRIMARY_NODE_TIER_SUBQUERY = `(SELECT tier FROM owned_nodes WHERE owned_nodes.account_id = accounts.id AND owned_nodes.removed_at IS NULL ORDER BY node_number ASC LIMIT 1)`;
const NODE_COUNT_SUBQUERY = `(SELECT COUNT(*) FROM owned_nodes WHERE owned_nodes.account_id = accounts.id AND owned_nodes.removed_at IS NULL)`;

export async function GET(request) {
  const guard = await requireAdmin();
  if (!guard.account) {
    return NextResponse.json({ error: guard.errorMessage }, { status: guard.errorStatus });
  }

  const { searchParams } = new URL(request.url);
  const q = (searchParams.get("q") || "").trim();
  const sortByParam = searchParams.get("sortBy") || "joined";
  const sortDir = searchParams.get("sortDir") === "asc" ? "ASC" : "DESC";
  const page = Math.max(1, Number.parseInt(searchParams.get("page"), 10) || 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Number.parseInt(searchParams.get("pageSize"), 10) || DEFAULT_PAGE_SIZE)
  );
  const offset = (page - 1) * pageSize;

  const db = getDb();

  const clauses = [];
  const params = [];
  if (q) {
    clauses.push(`(LOWER(name) LIKE ? OR LOWER(email) LIKE ?)`);
    const likeParam = `%${q.toLowerCase()}%`;
    params.push(likeParam, likeParam);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  const totalRow = db.prepare(`SELECT COUNT(*) as c FROM accounts ${where}`).get(...params);
  const total = totalRow.c;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  let accountRows;

  if (sortByParam === "withdraw") {
    // "Most/least time remaining" ordering: computed in JS via the SAME
    // shared helper the Withdrawals/Payouts pages and the old withdraw
    // filter used (lib/earningsEngine.js getPayoutTargetAt), since exact
    // calendar-month math can't be replicated in a plain SQL ORDER BY.
    // Already-eligible accounts ("Yes") sort as remainingMs = 0 (the
    // least possible wait); accounts with no countdown at all (no Node
    // connected yet) always sort last regardless of direction -- the
    // same "consistent placement" treatment already used for
    // never-logged-in accounts under lastLogin sorting. Only the
    // resolved id list is used to fetch this page's full rows -- the
    // full candidate set (bounded by this app's stated "hundreds of
    // customers" scale) is never sent to the client.
    const candidates = db
      .prepare(`SELECT id, node_connected_at FROM accounts ${where}`)
      .all(...params);
    const withRemaining = candidates.map((c) => {
      const { payoutTargetAt, payoutAvailable } = getPayoutTargetAt(c);
      let remainingMs;
      if (payoutAvailable) {
        remainingMs = 0;
      } else if (payoutTargetAt) {
        remainingMs = Math.max(0, new Date(payoutTargetAt).getTime() - Date.now());
      } else {
        remainingMs = null;
      }
      return { id: c.id, remainingMs };
    });
    withRemaining.sort((a, b) => {
      if (a.remainingMs === null && b.remainingMs === null) return 0;
      if (a.remainingMs === null) return 1;
      if (b.remainingMs === null) return -1;
      return sortDir === "ASC" ? a.remainingMs - b.remainingMs : b.remainingMs - a.remainingMs;
    });
    const pageIds = withRemaining.slice(offset, offset + pageSize).map((r) => r.id);
    if (pageIds.length === 0) {
      accountRows = [];
    } else {
      const placeholders = pageIds.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT ${ACCOUNT_SELECT_COLUMNS}, ${PRIMARY_NODE_TIER_SUBQUERY} as primary_node_tier, ${NODE_COUNT_SUBQUERY} as node_count, ${UPSELL_COMPLETED_SUBQUERY} as upsell_completed_at
           FROM accounts WHERE id IN (${placeholders})`
        )
        .all(...pageIds);
      const byId = new Map(rows.map((r) => [r.id, r]));
      accountRows = pageIds.map((id) => byId.get(id)).filter(Boolean);
    }
  } else if (sortByParam === "waitlist") {
    // Alphabetical "No"/"Yes" ordering reduces to a boolean sort since
    // there are only ever two possible values: "No" < "Yes"
    // alphabetically is exactly waitlist_joined_at IS NULL (0) before
    // IS NOT NULL (1) in ascending order.
    accountRows = db
      .prepare(
        `SELECT ${ACCOUNT_SELECT_COLUMNS}, ${PRIMARY_NODE_TIER_SUBQUERY} as primary_node_tier, ${NODE_COUNT_SUBQUERY} as node_count, ${UPSELL_COMPLETED_SUBQUERY} as upsell_completed_at
         FROM accounts ${where}
         ORDER BY (waitlist_joined_at IS NOT NULL) ${sortDir}, created_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset);
  } else if (sortByParam === "node") {
    // Alphabetical sort on the primary Node's tier display name
    // ("Nova Node" / "Standard Node" / "Super Node"). Accounts with NO
    // owned Node (subquery returns NULL) sort last regardless of
    // direction -- the same "consistent placement" treatment already
    // used for waitlist/never-logged-in accounts elsewhere in this
    // route -- via the same `(x IS NULL) ASC` trick used for
    // lastLogin's NULL handling, expressed explicitly here since SQLite
    // ORDER BY doesn't apply its default NULL-position rule per
    // direction the same way for a computed subquery column reliably
    // across SQLite versions.
    accountRows = db
      .prepare(
        `SELECT ${ACCOUNT_SELECT_COLUMNS}, ${PRIMARY_NODE_TIER_SUBQUERY} as primary_node_tier, ${NODE_COUNT_SUBQUERY} as node_count, ${UPSELL_COMPLETED_SUBQUERY} as upsell_completed_at
         FROM accounts ${where}
         ORDER BY (primary_node_tier IS NULL) ASC, primary_node_tier ${sortDir}
         LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset);
  } else if (sortByParam === "upsell") {
    // Same "No"/"Yes" boolean-sort pattern as "waitlist" above: only two
    // possible values (module 3 completed_at is NULL or not), so
    // ordering by `(upsell_completed_at IS NOT NULL)` directly via a
    // correlated subquery in ORDER BY reproduces alphabetical No/Yes
    // ordering without a second JS pass.
    accountRows = db
      .prepare(
        `SELECT ${ACCOUNT_SELECT_COLUMNS}, ${PRIMARY_NODE_TIER_SUBQUERY} as primary_node_tier, ${NODE_COUNT_SUBQUERY} as node_count, ${UPSELL_COMPLETED_SUBQUERY} as upsell_completed_at
         FROM accounts ${where}
         ORDER BY (${UPSELL_COMPLETED_SUBQUERY} IS NOT NULL) ${sortDir}, created_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset);
  } else {
    const column = SQL_SORT_COLUMNS[sortByParam] || SQL_SORT_COLUMNS.joined;
    // NULLS handling: SQLite sorts NULL first in ASC and last in DESC by
    // default, which is the natural, correct behavior for last_login_at
    // (accounts that have "Never" logged in sort to the end in a
    // newest-first view and to the beginning in an oldest-first view) --
    // no special-casing needed. This also correctly handles city/state
    // sorting the same way (accounts with no location on file sort to
    // the natural end/beginning, consistent with every other nullable
    // sort column in this route).
    accountRows = db
      .prepare(
        `SELECT ${ACCOUNT_SELECT_COLUMNS}, ${PRIMARY_NODE_TIER_SUBQUERY} as primary_node_tier, ${NODE_COUNT_SUBQUERY} as node_count, ${UPSELL_COMPLETED_SUBQUERY} as upsell_completed_at
         FROM accounts ${where}
         ORDER BY ${column} ${sortDir}
         LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset);
  }

  const outbox = db
    .prepare(
      `SELECT id, to_email, subject, sent_via, created_at FROM outbox ORDER BY created_at DESC LIMIT 20`
    )
    .all();

  return NextResponse.json({
    accounts: accountRows.map((a) => {
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
        ispCity: a.isp_city,
        ispState: a.isp_state,
        primaryNodeTier: a.primary_node_tier || null,
        primaryNodeTierKey: a.primary_node_tier ? displayNameToTierKey(a.primary_node_tier) : null,
        nodeCount: a.node_count || 0,
        currentBalanceCents: a.current_balance_cents,
        lifetimeEarningsCents: a.lifetime_earnings_cents,
        modulesUnlocked: Boolean(a.modules_unlocked),
        upsellCompleted: Boolean(a.upsell_completed_at),
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
