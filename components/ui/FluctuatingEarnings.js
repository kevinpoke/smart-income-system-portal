"use client";

import { formatCurrency, centsToDollars } from "@/lib/mockData";

// DISPLAY-ONLY currency figure for "Est. Monthly Earnings" (Data
// Bridges marketplace + Dashboard "Your Bridges"). This component NEVER
// reads or writes anything server-side, never touches
// owned_nodes.earning_rate_cents/est_monthly_cents, never touches
// ledger_entries, and never feeds into any payout/accrual calculation
// anywhere in the app -- lib/earningsEngine.js and lib/ownedNodes.js are
// the ONLY places real money math happens, and neither of them imports
// this file.
//
// 4-hour dashboard-freeze pass (now removed, see HERMES_PROGRESS.md):
// this component PREVIOUSLY re-rolled a +/-5% cosmetic "wobble" around
// `coreCents` every 5-10 seconds (Math.random()-driven, continuous,
// never-settling motion). That wobble was removed for consistency at
// the same time the 4-hour earnings-display freeze was introduced. The
// freeze itself has since been reverted (Dashboard/Bridge earnings are
// continuous/live again, driven by real server-side accrual), but this
// cosmetic random wobble was a separate, unrelated decorative effect --
// not a real earnings value -- and restoring the freeze-era earnings
// live-updates does not require bringing back a random cosmetic jitter.
// This still always renders the exact stable `coreCents` figure with no
// client-side jitter, so it can never visibly change on its own between
// server-driven data refreshes. The component/prop signature is kept
// identical (still takes `coreCents`/`className`) so every existing
// call site (Dashboard "Your Bridges" table, Data Bridges marketplace)
// needs no changes beyond this file.
export default function FluctuatingEarnings({ coreCents, className = "" }) {
  return (
    <span className={className}>{formatCurrency(centsToDollars(coreCents))}</span>
  );
}
