import { NextResponse } from "next/server";
import { getCurrentAccountRaw } from "@/lib/session";
import { computePayoutEstimates } from "@/lib/payoutsEngine";
import { getPayoutTargetAt } from "@/lib/earningsEngine";
import { hasModuleAccess } from "@/lib/moduleAccess";

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
// Portal reliability pass: this route previously locked purely on
// whether an ISP address was on file (isp_city/isp_state), which meant
// the admin's per-customer "Unlock All Modules" override had NO effect
// here at all -- a customer who never submitted ISP Setup stayed locked
// out of Payouts even after being individually unlocked. Now the page is
// unlocked whenever EITHER the customer has a location on file OR the
// shared hasModuleAccess() override applies (isp_status === 'active' or
// modules_unlocked) -- the same helper used by /api/nodes and the
// Modules page, so the admin's override behaves identically everywhere.
// Estimate rows are always safe to compute regardless of location (see
// lib/payoutsEngine.js -- seeded by accountId + calendar month only), so
// an unlocked-but-no-address account still gets real rows, just with a
// generic "your area" label instead of a specific city/state.
export async function GET() {
  const account = await getCurrentAccountRaw();
  if (!account) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const location =
    account.isp_city && account.isp_state
      ? `${account.isp_city}, ${account.isp_state}`
      : null;

  const unlocked = Boolean(location) || hasModuleAccess(account);

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

