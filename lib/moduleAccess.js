// Shared, single-source-of-truth helper for "does this account currently
// have access to modules/sections that are normally gated behind a
// completed + active ISP setup" (Nodes marketplace, training Modules
// page, and any future gated section). Both the frontend (via the
// account fields returned by /api/auth/me) and every backend API route
// that enforces this gate must call the SAME boolean expression here --
// this is what the spec means by "the UI and backend must use the same
// shared authorization helper" for the admin "Unlock All Modules"
// override to actually work everywhere consistently.
//
// Accepts either a raw DB account row (isp_status/modules_unlocked) or
// the public/camelCase shape returned by toPublicAccount()
// (ispStatus/modulesUnlocked), so callers on both the server (raw row)
// and the client (public shape) can share this exact function.
//
// SCOPE: this helper governs TRAINING MODULES only (and Withdrawals,
// which predates this refinement pass and was never asked to change).
// It intentionally does NOT gate Payouts or Nodes -- see
// hasPayoutsNodesAccess() below for that separate, stricter rule. The
// admin's per-customer "Unlock All Modules" override
// (accounts.modules_unlocked) must NEVER unlock Payouts/Nodes, only
// training videos, so it deliberately does not participate in
// hasPayoutsNodesAccess() at all.
import { isModuleCompleted } from "./moduleEngine";
import { PAYOUT_GATE_MODULE_ID } from "./mockData";

export function hasModuleAccess(account) {
  if (!account) return false;
  const ispStatus = account.isp_status ?? account.ispStatus;
  const modulesUnlocked = Boolean(account.modules_unlocked ?? account.modulesUnlocked);
  return ispStatus === "active" || modulesUnlocked;
}

// Returns true only when the account has a real city AND state on file
// (both non-empty after trimming). Accepts either raw DB row
// (isp_city/isp_state) or public shape (ispCity/ispState).
export function hasLocationOnFile(account) {
  if (!account) return false;
  const city = account.isp_city ?? account.ispCity;
  const state = account.isp_state ?? account.ispState;
  return Boolean(city && String(city).trim() && state && String(state).trim());
}

// Refinement pass: PAYOUTS and NODES must remain locked until BOTH of
// the following are true:
//   1. ISP setup is fully completed (isp_status === "active" -- the
//      customer clicked "I Approve" and the 20s authorization window
//      genuinely elapsed; see lib/ispEngine.js completeIspAuthorization)
//   2. city AND state are both stored on the account (isp_city/isp_state)
//
// This is DELIBERATELY a separate, stricter helper from
// hasModuleAccess() above: the admin's per-customer "Unlock All Modules"
// override must affect training videos ONLY and must never unlock
// Payouts or Nodes, so `modules_unlocked` never appears in this
// function's logic at all, by design, in either direction.
//
// In the normal flow, isp_status only reaches "active" via ISP Setup
// submission (which requires city+state as required fields -- see
// app/api/isp/submit/route.js REQUIRED_FIELDS) followed by admin
// approval and the customer's own authorization, so both conditions are
// ordinarily satisfied together. This helper still checks both
// explicitly (rather than assuming one implies the other) so a
// hypothetical future data-repair script, partial migration, or admin
// direct-DB edit that produces isp_status = "active" without a
// city/state on file (or vice versa) can never accidentally unlock
// Payouts/Nodes early.
export function hasPayoutsNodesAccess(account) {
  if (!account) return false;
  const ispStatus = account.isp_status ?? account.ispStatus;
  return ispStatus === "active" && hasLocationOnFile(account);
}

// NEW gate: the Payouts SECTION (the /payouts page -- estimates/history
// view, NOT the Withdrawals page and NOT the existing 4-month withdrawal
// eligibility timer) must remain locked until the customer has actually
// COMPLETED Module 10 ("How Payouts Work"), i.e.
// account_module_progress.completed_at is set for module_key = 10 (see
// lib/moduleEngine.js isModuleCompleted() -- the single shared
// completion-storage system; this deliberately does NOT create or read
// any second/duplicate completion flag).
//
// This is a PAGE-ACCESS gate only. It is INDEPENDENT of:
//   - hasPayoutsNodesAccess() above (the pre-existing ISP-setup gate for
//     the same page's location-dependent estimate rows) -- both must
//     pass for the full Payouts content to render; this function alone
//     answers "is the customer even allowed past the Module 10 wall".
//   - the existing 4-month withdrawal eligibility timer
//     (lib/earningsEngine.js getPayoutTargetAt(), used by the
//     Withdrawals page) -- completing Module 10 must NEVER reset, start,
//     shorten, or otherwise influence that timer. This function never
//     reads or writes anything related to node_connected_at/payout
//     timing.
//   - the admin's per-customer "Unlock All Modules" TIMING override
//     (accounts.modules_unlocked) -- that override only bypasses the
//     first-login unlock timer so a module becomes WATCHABLE early; it
//     never marks a module as completed, so it has zero effect on this
//     function. A customer must still click "Mark as Watched" on Module
//     10 (which persists completed_at via the existing
//     POST /api/modules/10/complete route) before Payouts unlocks, even
//     under the admin override.
export function hasPayoutAccess(db, account) {
  if (!db || !account) return false;
  return isModuleCompleted(db, account.id, PAYOUT_GATE_MODULE_ID);
}
