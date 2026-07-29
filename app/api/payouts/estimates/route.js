import { NextResponse } from "next/server";
import { getCurrentAccountRaw } from "@/lib/session";
import { computePayoutEstimates } from "@/lib/payoutsEngine";
import { getPayoutTargetAt } from "@/lib/earningsEngine";
import { hasPayoutsNodesAccess } from "@/lib/moduleAccess";

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
//
// Refinement pass: PAYOUTS must remain locked until BOTH (1) ISP setup
// is fully completed (isp_status === "active") AND (2) city+state are
// both stored -- see lib/moduleAccess.js hasPayoutsNodesAccess(). This
// is DELIBERATELY stricter than (and independent of) hasModuleAccess():
// the admin's per-customer "Unlock All Modules" override affects
// training videos ONLY and must never unlock Payouts, so it is not
// consulted here at all, in either direction.
export async function GET() {
  const account = await getCurrentAccountRaw();
  if (!account) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const location =
    account.isp_city && account.isp_state
      ? `${account.isp_city}, ${account.isp_state}`
      : null;

  const unlocked = hasPayoutsNodesAccess(account);

  if (!unlocked) {
    return NextResponse.json({ mode: "demo", locked: true, location: null, rows: [] });
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
    location,
    rows,
    payoutTargetAt,
    payoutAvailable,
  });
}

