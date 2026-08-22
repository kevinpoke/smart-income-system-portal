import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import {
  computeResponseTimeSamples,
  summarizeResponseTimes,
  resolvePeriodRange,
} from "@/lib/supportAnalytics";

// Admin-only, server-side aggregate Analytics for the Support "Analytics"
// tab (Part 1 of the admin-analytics/support-inbox spec). Every metric is
// computed via a single indexed aggregate SQL query (or, for response
// time, one full pass over support_messages reduced server-side) --
// never by shipping raw account/message rows to the browser for
// client-side math, per the spec's "ANALYTICS PERFORMANCE" requirement.
//
// AUTHORITATIVE FIELD MAPPING (see this route's accompanying audit notes
// in the batch report for full reasoning):
//   A. Total Members          -> COUNT(accounts) WHERE role = 'customer'
//   B. Logged In At Least Once-> COUNT(...) WHERE first_login_at IS NOT NULL
//        (first_login_at is set once, on the FIRST successful login only
//        -- see app/api/auth/login/route.js -- never guessed from
//        created_at/account-creation, which would count accounts that
//        never actually logged in)
//   C. ISP Applications Submitted -> COUNT(DISTINCT) WHERE isp_submitted_at
//        IS NOT NULL (set only by POST /api/isp/submit on a genuine
//        customer submission -- never by merely opening the ISP page)
//   D. ISP Approved/Activated -> COUNT(DISTINCT) WHERE isp_status = 'active'.
//        isp_status only ever transitions to 'active' inside
//        lib/ispEngine.js#completeIspAuthorization, which is only ever
//        invoked from POST /api/isp/authorize/complete -- an
//        authenticated CUSTOMER-session-only route (getCurrentAccountRaw(),
//        never requireAdmin()) that itself requires the server-verified
//        20-second post-admin-approval verification window to have
//        elapsed. This is NOT admin approval alone (that only reaches
//        'approved_awaiting_user'), NOT submission (pending_review), and
//        NOT the 3-day auto-approval alone (auto-approval also only
//        reaches 'approved_awaiting_user' -- see
//        lib/ispEngine.js#checkAndAutoApproveIsp /
//        transitionIspToApproved). Reaching 'active' strictly requires
//        the customer's own final click-through. No new column was
//        needed; this is a fully reliable EXISTING signal, verified by
//        reading the exact code path above.
//   E. Bridge Waitlist -> COUNT(DISTINCT) WHERE waitlist_joined_at IS NOT
//        NULL (set exactly once, guarded by COALESCE, in POST
//        /api/waitlist/join -- never incremented per-click)
//   F. Average Support Response Time -> see lib/supportAnalytics.js
//   G. Disabled Users -> COUNT(DISTINCT) WHERE account_status = 'disabled'
//        AND role = 'customer'
//   H. Module Timer Removed -> COUNT(DISTINCT) WHERE modules_unlocked = 1
//        AND role = 'customer' (the existing admin-only "Unlock All
//        Modules" override column -- see
//        app/api/admin/accounts/[id]/unlock-all -- flips this from 0 to 1
//        ONLY via an explicit admin action; it is never set by the
//        natural time-based module unlock system in
//        lib/moduleEngine.js/account_module_progress, so it cannot
//        double-count users whose modules unlocked naturally)
//   I. Balance Increased -> COUNT(DISTINCT account_id) FROM ledger_entries
//        WHERE event_type = 'admin_credit'. Verified authoritative: EVERY
//        write of event_type='admin_credit' in this codebase originates
//        from an admin-only action -- app/api/admin/accounts/[id]/balance
//        (positive amountCents) or app/api/admin/accounts/create (initial
//        starting balance set by an admin at account creation). Ordinary
//        earnings use event_type='earning' (lib/earningsEngine.js),
//        payouts use 'payout', corrections use 'correction' -- none of
//        those are counted. DISTINCT account_id means a member who
//        received 5 separate manual credits is counted once.
export async function GET(request) {
  const guard = await requireAdmin();
  if (!guard.account) {
    return NextResponse.json({ error: guard.errorMessage }, { status: guard.errorStatus });
  }

  const { searchParams } = new URL(request.url);
  const period = searchParams.get("period") || "lastweek";
  const customStart = searchParams.get("start") || undefined;
  const customEnd = searchParams.get("end") || undefined;

  const db = getDb();

  const totalMembers = db
    .prepare(`SELECT COUNT(*) AS c FROM accounts WHERE role = 'customer'`)
    .get().c;

  const loggedInAtLeastOnce = db
    .prepare(
      `SELECT COUNT(*) AS c FROM accounts WHERE role = 'customer' AND first_login_at IS NOT NULL`
    )
    .get().c;

  const ispSubmitted = db
    .prepare(
      `SELECT COUNT(*) AS c FROM accounts WHERE role = 'customer' AND isp_submitted_at IS NOT NULL`
    )
    .get().c;

  const ispApprovedActivated = db
    .prepare(
      `SELECT COUNT(*) AS c FROM accounts WHERE role = 'customer' AND isp_status = 'active'`
    )
    .get().c;

  const bridgeWaitlist = db
    .prepare(
      `SELECT COUNT(*) AS c FROM accounts WHERE role = 'customer' AND waitlist_joined_at IS NOT NULL`
    )
    .get().c;

  const disabledUsers = db
    .prepare(
      `SELECT COUNT(*) AS c FROM accounts WHERE role = 'customer' AND account_status = 'disabled'`
    )
    .get().c;

  const moduleTimerRemoved = db
    .prepare(
      `SELECT COUNT(*) AS c FROM accounts WHERE role = 'customer' AND modules_unlocked = 1`
    )
    .get().c;

  const balanceIncreased = db
    .prepare(
      `SELECT COUNT(DISTINCT le.account_id) AS c
       FROM ledger_entries le
       JOIN accounts a ON a.id = le.account_id
       WHERE le.event_type = 'admin_credit' AND a.role = 'customer'`
    )
    .get().c;

  // ---- Average Support Response Time (with period filter) ----
  const range = resolvePeriodRange(period, { customStart, customEnd });
  let responseTime = { avgMs: null, count: 0, formatted: null, error: null };
  if (!range) {
    responseTime.error = "Invalid period or custom date range.";
  } else {
    const samples = computeResponseTimeSamples(db);
    const { avgMs, count } = summarizeResponseTimes(samples, range.startMs, range.endMs);
    responseTime = {
      avgMs,
      count,
      formatted: avgMs == null ? null : null, // formatted client-side via shared helper too; keep raw ms authoritative
    };
  }

  function pct(numerator, denominator) {
    if (!denominator) return 0;
    return Math.round((numerator / denominator) * 1000) / 10; // one decimal
  }

  return NextResponse.json({
    totalMembers,
    loggedInAtLeastOnce,
    loggedInPct: pct(loggedInAtLeastOnce, totalMembers),
    ispSubmitted,
    ispSubmittedPct: pct(ispSubmitted, loggedInAtLeastOnce),
    ispApprovedActivated,
    ispApprovedActivatedPct: pct(ispApprovedActivated, loggedInAtLeastOnce),
    bridgeWaitlist,
    bridgeWaitlistPctOfTotal: pct(bridgeWaitlist, totalMembers),
    bridgeWaitlistPctOfLoggedIn: pct(bridgeWaitlist, loggedInAtLeastOnce),
    disabledUsers,
    moduleTimerRemoved,
    balanceIncreased,
    responseTime: {
      avgMs: responseTime.avgMs,
      count: responseTime.count,
      period,
      rangeStartMs: range?.startMs ?? null,
      rangeEndMs: range?.endMs ?? null,
      error: responseTime.error || null,
    },
  });
}
