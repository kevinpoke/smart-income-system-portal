import { recomputeBalances } from "./earningsEngine";

// Thin wrapper so admin routes that write ledger_entries (balance
// adjustments) reconcile accounts.current_balance_cents /
// lifetime_earnings_cents through the exact same logic the earnings
// catch-up engine uses -- there is only ever one reconciliation
// implementation for the whole app.
export function recomputeAndGetBalance(db, accountId) {
  recomputeBalances(db, accountId);
  const row = db.prepare(`SELECT current_balance_cents FROM accounts WHERE id = ?`).get(accountId);
  return row.current_balance_cents;
}
