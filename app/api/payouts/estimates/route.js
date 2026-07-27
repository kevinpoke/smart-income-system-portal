import { NextResponse } from "next/server";
import { getCurrentAccountRaw } from "@/lib/session";
import { computePayoutEstimates } from "@/lib/payoutsEngine";

// Authenticated customer's payout estimate rows. Purely derived from the
// account id (for the seed) -- these are demo/marketing figures only and
// are never written to ledger_entries or reflected in
// current_balance_cents / lifetime_earnings_cents. Location is returned
// separately here (sourced from the account's own isp_city/isp_state) so
// the page can render "Complete ISP Setup" when it's missing, without
// ever touching another customer's data (there is no accountId parameter
// anywhere in this route -- it always operates on the session's own
// account).
export async function GET() {
  const account = await getCurrentAccountRaw();
  if (!account) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const rows = computePayoutEstimates(account.id, 12).map((r) => ({
    id: r.id,
    monthLabel: r.monthLabel,
    amountCents: r.amountCents,
  }));

  const location =
    account.isp_city && account.isp_state
      ? `${account.isp_city}, ${account.isp_state}`
      : null;

  return NextResponse.json({
    mode: "demo",
    location,
    rows,
  });
}
