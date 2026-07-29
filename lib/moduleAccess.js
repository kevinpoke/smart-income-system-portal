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
