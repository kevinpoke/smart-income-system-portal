import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getCurrentAccountRaw } from "@/lib/session";
import { computePayoutEstimates } from "@/lib/payoutsEngine";
import { getPayoutTargetAt } from "@/lib/earningsEngine";
import { hasPayoutsNodesAccess, hasPayoutAccess } from "@/lib/moduleAccess";

// Authenticated customer's payout estimate rows. Purely derived from the
// account id (for the seed) -- these are demo/marketing figures only and
// are never written to ledger_entries or reflected in
// current_balance_cents / lifetime_earnings_cents. Location is returned
// separately here (sourced from the account's own isp_city/isp_state) so
// the page can render "Complete ISP Setup" when it's missing, without
// ever touching another customer's data (there is no accountId parameter
// anywhere in this route -- it always operates on the session's own
// account).
//
// Phase 5: payoutTargetAt/payoutAvailable are read from the SAME shared
// helper (lib/earningsEngine.js getPayoutTargetAt) the Dashboard uses via
// /api/earnings/summary, so the "Next withdrawal available in..."
// countdown here can never disagree with the Dashboard's "Next Payout"
// countdown -- there is exactly one calculation, read from two routes.
// This route's own payoutTargetAt/payoutAvailable fields are UNCHANGED by
// the new Module 10 gate below -- they still describe the existing
// 4-month WITHDRAWAL eligibility timer only (see
// app/(portal)/withdrawals/page.js), never reset or influenced by module
// completion.
//
// GATES (both independent, both server-enforced, both must pass to see
// real payout content):
//   1. hasPayoutsNodesAccess() -- pre-existing: ISP setup fully completed
//      (isp_status === "active") AND city+state both stored. Deliberately
//      independent of the admin's per-customer "Unlock All Modules"
//      override, which affects training videos only.
//   2. hasPayoutAccess() -- NEW: the authenticated customer has actually
//      COMPLETED Module 10 ("How Payouts Work"), per
//      account_module_progress.completed_at for module_key = 10 (see
//      lib/moduleEngine.js isModuleCompleted() / lib/moduleAccess.js
//      hasPayoutAccess()). This is a PAGE-ACCESS gate only -- it does
//      NOT touch payoutTargetAt/payoutAvailable (the existing 4-month
//      WITHDRAWAL timer), which remains entirely unchanged and is
//      computed identically whether or not this gate passes.
//
// A customer failing gate 2 gets a dedicated `moduleLocked: true`
// response with the exact required copy, distinct from the pre-existing
// `locked: true` (ISP-setup-incomplete) response, so the page can render
// the correct one of the two distinct locked states.
export async function GET() {
  const account = await getCurrentAccountRaw();
  if (!account) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const db = getDb();

  // Module 10 completion gate takes priority: per spec, the Payouts
  // section itself must show the Module 10 locked message until this
  // passes, independent of ISP-setup completion state.
  if (!hasPayoutAccess(db, account)) {
    return NextResponse.json({
      mode: "demo",
      locked: true,
      moduleLocked: true,
      location: null,
      rows: [],
    });
  }

  const location =
    account.isp_city && account.isp_state
      ? `${account.isp_city}, ${account.isp_state}`
      : null;

  const unlocked = hasPayoutsNodesAccess(account);

  if (!unlocked) {
    return NextResponse.json({ mode: "demo", locked: true, moduleLocked: false, location: null, rows: [] });
  }

  const rows = computePayoutEstimates(account.id, 12).map((r) => ({
    id: r.id,
    monthLabel: r.monthLabel,
    amountCents: r.amountCents,
  }));

  const { payoutTargetAt, payoutAvailable } = getPayoutTargetAt(account);

  return NextResponse.json({
    mode: "demo",
    locked: false,
    moduleLocked: false,
    location,
    rows,
    payoutTargetAt,
    payoutAvailable,
  });
}

