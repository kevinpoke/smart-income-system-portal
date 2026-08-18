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
// 4-hour dashboard-freeze pass: this component PREVIOUSLY re-rolled a
// +/-5% cosmetic "wobble" around `coreCents` every 5-10 seconds
// (Math.random()-driven, continuous, never-settling motion). Per spec
// ("earnings-related stats... the marketplace Est. Monthly Earnings
// wobble should also stop continuously fluctuating for consistency"),
// that continuous re-roll has been removed entirely -- this now always
// renders the exact stable `coreCents` figure with no client-side
// jitter at all, so it can never visibly change on its own between
// server-driven data refreshes. The component/prop signature is kept
// identical (still takes `coreCents`/`className`) so every existing
// call site (Dashboard "Your Bridges" table, Data Bridges marketplace)
// needs no changes beyond this file.
export default function FluctuatingEarnings({ coreCents, className = "" }) {
  return (
    <span className={className}>{formatCurrency(centsToDollars(coreCents))}</span>
  );
}

