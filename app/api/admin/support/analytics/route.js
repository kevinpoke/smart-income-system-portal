import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import {
  computeResponseTimeSamples,
  summarizeResponseTimes,
  resolvePeriodRange,
  computeDisabledFunnel,
  computeIspApprovalConversion,
  computeModule10RefundAnalytics,
  computeIspRetention,
  computeAutomatedMessageAnalytics,
  computeOtherStateAnalytics,
} from "@/lib/supportAnalytics";

// Admin-only, server-side aggregate Analytics for the Support "Analytics"
// tab (Part 1 of the admin-analytics/support-inbox spec). Every metric is
// computed via a single indexed aggregate SQL query (or, for response
// time, one full pass over support_messages reduced server-side) --
// never by shipping raw account/message rows to the browser for
// client-side math, per the spec's "ANALYTICS PERFORMANCE" requirement.
//
// DATE-RANGE ARCHITECTURE (ANALYTICS/SUPPORT/BRIDGE batch): the selected
// `range` now applies to EVERY dataset below via each metric's OWN
// canonical anchor timestamp -- never a blanket created_at filter for
// everything. Mapping (see lib/supportAnalytics.js for the actual SQL):
//   A. Total Members          -> accounts.created_at within range
//   B. Logged In At Least Once-> cohort = accounts.created_at within
//        range (same cohort as Total Members, so this stays a coherent
//        ratio of "this period's new members"), first_login_at IS NOT
//        NULL evaluated WITHOUT its own date filter (a member who
//        joined in-range may legitimately log in for the first time
//        after the range ends -- that first login itself is not a
//        separate "cohort start event," it is a follow-up fact about an
//        already-in-range member, per the cohort-membership philosophy
//        documented in lib/supportAnalytics.js's TASK 4 COHORT RULE
//        comment. This was a deliberate judgment call -- the spec left
//        this metric's exact semantics open to engineering judgment).
//   C. ISP Submitted   -> isp_submitted_at within range (own cohort
//        anchor, independent of when the member joined)
//   D. ISP Approved/Activated -> isp_approved_at within range (the
//        canonical "became approved" transition timestamp --
//        isp_status='active'/user_authorized_at/node_connected_at mark
//        a LATER, separate transition -- go-LIVE, not approval -- see
//        lib/supportAnalytics.js isLive()/computeIspApprovalConversion
//        for that distinct concept. This stat is literally named
//        "ISP Approved/Activated" so it uses the APPROVAL timestamp,
//        matching the metric's own primary word "Approved")
//   E. Bridge Waitlist -> waitlist_joined_at within range
//   F. Average Support Response Time -> unchanged, still filtered by
//        the initiating customer message's own timestamp (see
//        lib/supportAnalytics.js computeResponseTimeSamples)
//   G. Disabled Users  -> disabled_at within range (numerator); its
//        top-level percentage is disabledUsers / totalMembers (TASK 3
//        fix, see disabledFunnel.disabledPctOfTotalMembers below) --
//        NEVER totalDisabled, which would answer a different question.
//   H. Module Timer Removed -> accounts.modules_unlocked=1 has NO
//        timestamp column at all (a point-in-time admin override flag,
//        not an event with a "when" -- adding one would require a new
//        migration solely to backfill an unknowable historical instant
//        for every pre-existing override, which risks silently
//        misdating real historical toggles). Per spec ("no hidden
//        all-time cards"), this stays ALL-TIME but is now explicitly
//        labeled `allTime: true` in the payload so the (future) UI
//        layer can render "(All Time)" next to it rather than silently
//        implying it respects the selected range.
//   I. Balance Increased -> ledger_entries.created_at within range
//        (event_type = 'admin_credit', unchanged eligibility rule)
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

  const range = resolvePeriodRange(period, { customStart, customEnd });
  if (!range) {
    return NextResponse.json({ error: "Invalid period or custom date range." }, { status: 400 });
  }
  const startIso = new Date(range.startMs).toISOString();
  const endIso = new Date(range.endMs).toISOString();

  const totalMembers = db
    .prepare(
      `SELECT COUNT(*) AS c FROM accounts
       WHERE role = 'customer' AND created_at >= ? AND created_at < ?`
    )
    .get(startIso, endIso).c;

  // Cohort = same "joined within range" population as Total Members;
  // first_login_at itself is NOT date-filtered (see header comment --
  // this is the documented cohort-membership judgment call for this
  // ratio metric).
  const loggedInAtLeastOnce = db
    .prepare(
      `SELECT COUNT(*) AS c FROM accounts
       WHERE role = 'customer' AND created_at >= ? AND created_at < ?
         AND first_login_at IS NOT NULL`
    )
    .get(startIso, endIso).c;

  const ispSubmitted = db
    .prepare(
      `SELECT COUNT(*) AS c FROM accounts
       WHERE role = 'customer' AND isp_submitted_at >= ? AND isp_submitted_at < ?`
    )
    .get(startIso, endIso).c;

  const ispApprovedActivated = db
    .prepare(
      `SELECT COUNT(*) AS c FROM accounts
       WHERE role = 'customer' AND isp_approved_at >= ? AND isp_approved_at < ?`
    )
    .get(startIso, endIso).c;

  const bridgeWaitlist = db
    .prepare(
      `SELECT COUNT(*) AS c FROM accounts
       WHERE role = 'customer' AND waitlist_joined_at >= ? AND waitlist_joined_at < ?`
    )
    .get(startIso, endIso).c;

  const disabledUsers = db
    .prepare(
      `SELECT COUNT(*) AS c FROM accounts
       WHERE role = 'customer' AND account_status = 'disabled'
         AND disabled_at >= ? AND disabled_at < ?`
    )
    .get(startIso, endIso).c;

  // Module Timer Removed: no timestamp column exists for this admin
  // override (see header comment) -- stays all-time, explicitly labeled.
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
       WHERE le.event_type = 'admin_credit' AND a.role = 'customer'
         AND le.created_at >= ? AND le.created_at < ?`
    )
    .get(startIso, endIso).c;

  // ---- Average Support Response Time (with period filter) ----
  let responseTime = { avgMs: null, count: 0, formatted: null, error: null };
  {
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

  // ---- DISABLED-FUNNEL-ANALYTICS + ISP-APPROVAL-CONVERSION batch ----
  // Both computed server-side via a single aggregate query each (see
  // lib/supportAnalytics.js) -- never by shipping raw account rows to
  // the browser. Both now range-filtered by their own canonical anchor
  // (disabled_at / isp_approved_at respectively -- see TASK 2 mapping).
  // computeDisabledFunnel also receives `totalMembers` (the SAME count
  // computed above, for the SAME range) so its disabledPctOfTotalMembers
  // field is guaranteed consistent with the top-level Total Members stat
  // (TASK 3 fix).
  const disabledFunnel = computeDisabledFunnel(db, range, totalMembers);
  const ispApprovalConversion = computeIspApprovalConversion(db, range);

  // ---- MODULE-10-REFUND-ANALYTICS batch ----
  // See lib/supportAnalytics.js#computeModule10RefundAnalytics for the
  // full authoritative-definitions audit (refund source, unlock
  // schedule, real completion signal). Single server-side aggregate
  // pass -- never ships raw account rows to the browser. Now
  // range-filtered by disabled_at (the refund event's own timestamp).
  const module10Refunds = computeModule10RefundAnalytics(db, Date.now(), range);

  // ---- TASK 4: Post-ISP login retention ----
  const ispRetention = computeIspRetention(db, range);

  // ---- TASK 5: Automated Support Messages analytics ----
  const automatedMessages = computeAutomatedMessageAnalytics(db, range);

  // ---- OTHER-STATE-ISP batch: Other State / Region analytics ----
  const otherStateAnalytics = computeOtherStateAnalytics(db, range);

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
    disabledPctOfTotalMembers: disabledFunnel.disabledPctOfTotalMembers, // TASK 3 fix (2-decimal precision)
    moduleTimerRemoved,
    moduleTimerRemovedAllTime: true, // TASK 2: no per-toggle timestamp exists -- see header comment
    balanceIncreased,
    responseTime: {
      avgMs: responseTime.avgMs,
      count: responseTime.count,
      period,
      rangeStartMs: range?.startMs ?? null,
      rangeEndMs: range?.endMs ?? null,
      error: responseTime.error || null,
    },
    disabledFunnel,
    ispApprovalConversion,
    module10Refunds,
    ispRetention,
    automatedMessages,
    otherStateAnalytics,
  });
}
