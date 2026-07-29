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
export function hasModuleAccess(account) {
  if (!account) return false;
  const ispStatus = account.isp_status ?? account.ispStatus;
  const modulesUnlocked = Boolean(account.modules_unlocked ?? account.modulesUnlocked);
  return ispStatus === "active" || modulesUnlocked;
}
