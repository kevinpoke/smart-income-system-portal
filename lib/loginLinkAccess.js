import { getDb } from "./db";
import { parseLoginLinkToken } from "./loginLink";

// PASSWORDLESS-CUSTOMER-LOGIN batch: single shared "is this login link
// currently valid" resolver, used by BOTH the public /l/[token] page
// (to decide whether to render the email-entry form or 404) and
// POST /api/auth/login-link/verify (to decide whether to actually
// create a session). Keeping this in exactly one place means the two
// call sites can never drift out of sync on what counts as "valid".
//
// Returns the full account row when the link is currently valid:
//   - well-formed token, signature verifies (see parseLoginLinkToken)
//   - the embedded version matches accounts.login_link_version EXACTLY
//   - accounts.auth_mode === 'login_link' (a legacy_password account
//     can NEVER authenticate via a link even if one were somehow
//     minted for it, or a token manually constructed for it -- this
//     is the durable legacy/new gate required by spec Part 2/3,
//     deliberately checked here in the single shared resolver rather
//     than only in the admin UI, so a legacy account is
//     unconditionally rejected regardless of how a token for it was
//     constructed)
//   - accounts.account_status === 'active' (covers manually disabled
//     AND jvzoo_refund-disabled accounts identically -- both set
//     account_status = 'disabled' via the same shared
//     lib/accountDisable.js#disableAccount() helper, so there is only
//     ONE status check needed here, not a separate refund-specific
//     branch)
// Returns null for every other case. Never throws on malformed input.
export function resolveAccountForLoginLinkToken(token) {
  const parsed = parseLoginLinkToken(token);
  if (!parsed) return null;

  const db = getDb();
  const account = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(parsed.accountId);
  if (!account) return null;
  if (account.auth_mode !== "login_link") return null;
  if (account.account_status !== "active") return null;
  if (account.login_link_version !== parsed.version) return null;

  return account;
}
