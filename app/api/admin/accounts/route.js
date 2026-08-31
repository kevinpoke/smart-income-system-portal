import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { getPayoutTargetAt, computeEarningsSummary } from "@/lib/earningsEngine";
import { displayNameToTierKey } from "@/lib/nodeTiers";
import { computeModule10SupportStatus, MODULE_10_SUPPORT_STATUS } from "@/lib/moduleEngine";
import { WITHDRAWALS_MODULE_10_GATE_ID, MODULE_UNLOCK_HOURS } from "@/lib/mockData";

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

// User Management: "Upsell" column. Reads the dedicated, admin-only
// manual upsell_purchased flag (see lib/db.js ACCOUNT_COLUMNS for why
// this is a plain column rather than a subquery derived from module
// completion -- Module 3 completion means "watched the upsell pitch,"
// which is a DIFFERENT fact from "actually purchased the upsell,"
// confirmed via explicit product clarification during the admin/module/
// withdrawal/dashboard fix batch). Writes only ever happen through the
// dedicated admin route POST /api/admin/accounts/[id]/upsell.
const UPSELL_COLUMN = "upsell_purchased";

const ACCOUNT_SELECT_COLUMNS = `id, email, name, first_name, last_name, must_change_password, role, account_status, created_at,
              first_login_at, last_login_at, waitlist_joined_at,
              isp_status, isp_submitted_at, isp_approved_at, user_authorized_at, node_connected_at,
              isp_city, isp_state,
              current_balance_cents, lifetime_earnings_cents, modules_unlocked, wifi_enabled, auth_mode`;

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

// MODULE-10-SUPPORT-STATUS batch: the real, persisted Module 10
// completion timestamp, pulled via a single correlated subquery per row
// (SQLite plans this as an indexed lookup against
// account_module_progress's composite PK (account_id, module_key) --
// see lib/db.js -- so this scales the same way PRIMARY_NODE_TIER_SUBQUERY
// above already does, with NO N+1 per-row API calls). NULL means "never
// completed" -- the same authoritative signal
// lib/moduleEngine.js#isModuleCompleted() reads.
const MODULE10_COMPLETED_AT_SUBQUERY = `(SELECT completed_at FROM account_module_progress WHERE account_module_progress.account_id = accounts.id AND account_module_progress.module_key = ${WITHDRAWALS_MODULE_10_GATE_ID})`;

// Admin-portal batch (Mod 10 filter): the EXACT SAME classification rule
// as lib/moduleEngine.js#computeModule10SupportStatus(), expressed as a
// server-side SQL boolean expression so filtering by Mod 10 status never
// requires fetching every account into JS first (no N+1, no client-side
// full-table scan) -- this reuses the SAME two inputs that function
// reads (module10_completed_at, modules_unlocked, first_login_at) and
// the SAME fixed schedule constant (MODULE_UNLOCK_HOURS[10] hours after
// first_login_at), just written as SQL date-arithmetic instead of JS
// millisecond math. `datetime(first_login_at, '+112 hours')` and
// `computeModuleUnlockAtMs()`'s `firstLoginMs + hours * HOUR_MS` are
// mathematically identical for a fixed hour count -- SQLite's datetime()
// modifier arithmetic and JS Date millisecond arithmetic agree exactly
// for a whole-hour offset applied to the same ISO instant. This constant
// is interpolated from the SAME MODULE_UNLOCK_HOURS[10] config value the
// JS classifier reads -- never a second, independently-hardcoded "112".
const MODULE_10_UNLOCK_HOURS = MODULE_UNLOCK_HOURS[WITHDRAWALS_MODULE_10_GATE_ID];
// Mirrors computeModuleUnlockAtMs()'s exact condition for a >0h module:
// "first_login_at is set AND first_login_at + hours has already passed."
// isp_status is deliberately NOT part of this expression -- the JS
// classifier never reads it either.
const MODULE10_UNLOCKED_NOW_SQL = `(modules_unlocked = 1 OR (first_login_at IS NOT NULL AND datetime(first_login_at, '+${MODULE_10_UNLOCK_HOURS} hours') <= datetime('now')))`;
const MODULE10_STATUS_SQL_CLAUSES = {
  watched: `${MODULE10_COMPLETED_AT_SUBQUERY} IS NOT NULL`,
  unlocked: `${MODULE10_COMPLETED_AT_SUBQUERY} IS NULL AND ${MODULE10_UNLOCKED_NOW_SQL}`,
  not_unlocked: `${MODULE10_COMPLETED_AT_SUBQUERY} IS NULL AND NOT ${MODULE10_UNLOCKED_NOW_SQL}`,
};

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
  // ISP Approvals search+pagination: an optional server-side filter to a
  // single isp_status value (e.g. "pending_review"), so the ISP Approvals
  // tab can reuse this SAME authoritative accounts query/endpoint with
  // its own search+pagination instead of fetching every account and
  // filtering client-side. Every other existing caller of this route
  // (User Management) simply never sets this param, so its behavior is
  // completely unchanged.
  // ISP Approvals + Admin ISP Confirmation batch: accepts either a single
  // isp_status value (back-compat, e.g. "pending_review") or a
  // comma-separated list (e.g. "pending_review,approved_awaiting_user")
  // so the ISP Approvals tab can list BOTH "awaiting existing admin
  // approval" and "admin-approved, awaiting final ISP Confirmation" rows
  // in one query, still fully server-side filtered/paginated.
  const ispStatusFilterRaw = (searchParams.get("ispStatus") || "").trim();
  const ispStatusValues = ispStatusFilterRaw
    ? ispStatusFilterRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  // Admin-portal batch: optional Mod 10 status filter for the User
  // Management table ("all" | "not_unlocked" | "unlocked" | "watched").
  // Validated against the exact same MODULE_10_SUPPORT_STATUS constants
  // the classifier itself uses -- an unrecognized/missing value is
  // treated as "no filter" (same as omitting the param entirely).
  const mod10StatusFilterRaw = (searchParams.get("mod10Status") || "").trim().toLowerCase();
  const mod10StatusFilter = Object.values(MODULE_10_SUPPORT_STATUS).includes(mod10StatusFilterRaw)
    ? mod10StatusFilterRaw
    : null;

  const db = getDb();

  const clauses = [];
  const params = [];
  if (q) {
    // Partial, case-insensitive match against name OR email OR account id
    // -- id is included so an admin who has an exact account id (the only
    // other identifying field this admin system exposes/supports, per
    // spec) can also search by it directly.
    clauses.push(`(LOWER(name) LIKE ? OR LOWER(email) LIKE ? OR LOWER(id) LIKE ?)`);
    const likeParam = `%${q.toLowerCase()}%`;
    params.push(likeParam, likeParam, likeParam);
  }
  if (ispStatusValues.length > 0) {
    clauses.push(`isp_status IN (${ispStatusValues.map(() => "?").join(",")})`);
    params.push(...ispStatusValues);
  }
  if (mod10StatusFilter) {
    // Mod 10 is a customer-only concept (admin/staff rows always show
    // "—" client-side) -- scoping the filter to role='customer' here
    // means selecting a Mod 10 filter can never accidentally include or
    // exclude a non-customer row based on this classification, which
    // would be meaningless for them.
    clauses.push(`role = 'customer' AND (${MODULE10_STATUS_SQL_CLAUSES[mod10StatusFilter]})`);
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
          `SELECT ${ACCOUNT_SELECT_COLUMNS}, ${PRIMARY_NODE_TIER_SUBQUERY} as primary_node_tier, ${NODE_COUNT_SUBQUERY} as node_count, ${UPSELL_COLUMN} as upsell_purchased, ${MODULE10_COMPLETED_AT_SUBQUERY} as module10_completed_at
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
        `SELECT ${ACCOUNT_SELECT_COLUMNS}, ${PRIMARY_NODE_TIER_SUBQUERY} as primary_node_tier, ${NODE_COUNT_SUBQUERY} as node_count, ${UPSELL_COLUMN} as upsell_purchased, ${MODULE10_COMPLETED_AT_SUBQUERY} as module10_completed_at
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
        `SELECT ${ACCOUNT_SELECT_COLUMNS}, ${PRIMARY_NODE_TIER_SUBQUERY} as primary_node_tier, ${NODE_COUNT_SUBQUERY} as node_count, ${UPSELL_COLUMN} as upsell_purchased, ${MODULE10_COMPLETED_AT_SUBQUERY} as module10_completed_at
         FROM accounts ${where}
         ORDER BY (primary_node_tier IS NULL) ASC, primary_node_tier ${sortDir}
         LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset);
  } else if (sortByParam === "upsell") {
    // Same "No"/"Yes" boolean-sort pattern as "waitlist" above: only two
    // possible values (upsell_purchased is 0 or 1), so ordering directly
    // by the plain column reproduces alphabetical No/Yes ordering
    // without a second JS pass.
    accountRows = db
      .prepare(
        `SELECT ${ACCOUNT_SELECT_COLUMNS}, ${PRIMARY_NODE_TIER_SUBQUERY} as primary_node_tier, ${NODE_COUNT_SUBQUERY} as node_count, ${UPSELL_COLUMN} as upsell_purchased, ${MODULE10_COMPLETED_AT_SUBQUERY} as module10_completed_at
         FROM accounts ${where}
         ORDER BY ${UPSELL_COLUMN} ${sortDir}, created_at DESC
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
        `SELECT ${ACCOUNT_SELECT_COLUMNS}, ${PRIMARY_NODE_TIER_SUBQUERY} as primary_node_tier, ${NODE_COUNT_SUBQUERY} as node_count, ${UPSELL_COLUMN} as upsell_purchased, ${MODULE10_COMPLETED_AT_SUBQUERY} as module10_completed_at
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

  // Admin Balance column fix: the Balance column must reflect the SAME
  // canonical current earned balance as the customer Dashboard, including
  // any live accrued earnings from the current in-progress cycle -- not
  // just the last-persisted `current_balance_cents` snapshot (which only
  // updates when a completed cycle's catch-up runs, e.g. on the
  // customer's own next Dashboard load). `computeEarningsSummary()`
  // (lib/earningsEngine.js) is the single canonical earnings engine
  // already used by the Dashboard/`/api/earnings/summary`/`/api/nodes/
  // owned` -- reusing it here (rather than re-implementing any of its
  // math) both runs the same completed-cycle catch-up the Dashboard
  // would have run AND adds the current cycle's live accrued cents on
  // top, so admin and customer views can never disagree. This is
  // deliberately NOT the cosmetic +/-10% `dailyFluctuationMultiplier`
  // display wobble -- `todayAccruedCents` is the real, WiFi-gated,
  // per-Node-eligibility-aware accrued amount, the exact same number the
  // Dashboard's "Today (1d)" card and Live Earnings ticker are built
  // from. To keep this cheap, it is only computed for the accounts
  // actually being returned on this one paginated page (never the full
  // account list), and only for `role === "customer"` rows (admin/staff
  // accounts have no owned Nodes/earnings and would just no-op through
  // computeEarningsSummary's `active` gate anyway, so skipping them
  // avoids a wasted query per admin row).
  const canonicalBalanceById = new Map();
  for (const a of accountRows) {
    if (a.role !== "customer") continue;
    const summary = computeEarningsSummary(db, a.id);
    if (summary) {
      canonicalBalanceById.set(a.id, summary.currentBalanceCents + (summary.todayAccruedCents || 0));
    }
  }

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
        // PASSWORDLESS-CUSTOMER-LOGIN batch: durable legacy/new auth
        // state (spec Part 2/3), exposed here ONLY as the plain mode
        // label ('legacy_password' | 'login_link') -- never a login
        // URL/token/signature. The User Management "Login" column and
        // "Copy/Reset Login Link" Actions gate on THIS field, not on
        // role==='customer' alone (every legacy customer is also
        // role==='customer').
        authMode: a.auth_mode,
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
        currentBalanceCents: canonicalBalanceById.has(a.id)
          ? canonicalBalanceById.get(a.id)
          : a.current_balance_cents,
        lifetimeEarningsCents: a.lifetime_earnings_cents,
        modulesUnlocked: Boolean(a.modules_unlocked),
        upsellCompleted: Boolean(a.upsell_purchased),
        createdAt: a.created_at,
        lastLoginAt: a.last_login_at,
        waitlistJoined: Boolean(a.waitlist_joined_at),
        payoutTargetAt,
        payoutAvailable,
        // MODULE-10-SUPPORT-STATUS batch: server-side classified, one of
        // "not_unlocked" | "unlocked" | "watched" -- see
        // lib/moduleEngine.js#computeModule10SupportStatus for the exact
        // priority rule (real completion always wins; Unlock All can
        // produce "unlocked" but never "watched"). Computed here (not a
        // second per-row API call) using the module10_completed_at value
        // already fetched via MODULE10_COMPLETED_AT_SUBQUERY above -- no
        // N+1 queries.
        module10Status: computeModule10SupportStatus(
          {
            first_login_at: a.first_login_at,
            created_at: a.created_at,
            modules_unlocked: a.modules_unlocked,
            module10CompletedAt: a.module10_completed_at,
          },
          WITHDRAWALS_MODULE_10_GATE_ID
        ),
      };
    }),
    recentEmails: outbox,
    total,
    page,
    pageSize,
    totalPages,
  });
}
