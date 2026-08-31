// STOP-AUTOMATED-SUPPORT-MESSAGES + DISABLED-FUNNEL-ANALYTICS batch:
// the ONE shared, canonical account-disable helper. Both existing
// disable paths -- manual admin disable
// (app/api/admin/accounts/[id]/disable) and the JVZoo original-SALE
// refund auto-disable (app/api/webhooks/jvzoo/route.js
// disableForOriginalSaleRefund) -- now call disableAccount() below
// instead of writing `account_status = 'disabled'` directly, so every
// future disable event persists the same three things needed for
// accurate Disabled User Funnel analytics:
//   1. accounts.disabled_at        -- canonical disable timestamp
//   2. accounts.disable_reason     -- 'manual_admin' | 'jvzoo_refund'
//   3. accounts.disable_stage_snapshot -- the customer's funnel stage
//      AT THE MOMENT OF DISABLE (computeFunnelStageAtDisable below),
//      captured once and never re-derived later from fields that could
//      keep changing after the disable (e.g. a later re-enable +
//      continued ISP progress must never retroactively change what
//      bucket a PAST disable event belongs to).
//
// IDEMPOTENCY / RE-ENABLE LIFECYCLE (per spec Part 5):
// - Calling disableAccount() on an account that is ALREADY disabled is
//   a safe no-op with respect to disabled_at/disable_reason/
//   disable_stage_snapshot -- COALESCE preserves the ORIGINAL
//   meaningful disable timestamp/reason/snapshot rather than
//   overwriting them with a second, later disable attempt's values.
//   account_status is re-asserted (harmless) and sessions are
//   re-revoked (harmless, idempotent DELETE) but no new "disable
//   event" is recorded.
// - If an account is RE-ENABLED (enableAccount() below) and later
//   disabled AGAIN, that is a genuinely NEW disable lifecycle: this is
//   handled by enableAccount() clearing disabled_at/disable_reason/
//   disable_stage_snapshot back to NULL on re-enable, so the next
//   disableAccount() call correctly captures a FRESH snapshot for this
//   new disable event rather than being blocked by COALESCE from the
//   previous (now-irrelevant) disable.
// - Every audit_log row (account_disable / account_enable /
// jvzoo_refund_account_disabled) continues to be written exactly as
// before -- this helper does not change or duplicate that audit
// trail, it only adds the three new denormalized columns above for
// fast Analytics aggregation without re-walking audit_log at query
// time.

// Computes which Disabled User Funnel bucket a fresh `account` row
// belongs to, evaluated at the moment of disable (the caller must pass
// the account row as it existed immediately before this disable takes
// effect -- i.e. its CURRENT funnel timestamps, since disabling does
// not itself change first_login_at/isp_submitted_at/isp_approved_at/
// user_authorized_at/node_connected_at). Mirrors the mutually-exclusive
// bucket definitions in the spec exactly, evaluated in strict priority
// order (each earlier check implies the later ones don't apply):
//
//   1. before_login                    -- never logged in yet
//   2. before_isp_setup                -- logged in, not yet submitted ISP
//   3. during_isp_verification         -- submitted, not yet approved
//   4. after_isp_approval_never_live   -- approved, never went live
//   5. after_isp_approval_went_live    -- approved AND went live
//
// "Went live" uses the SAME authoritative signal
// completeIspAuthorization() itself sets (user_authorized_at /
// node_connected_at / isp_status === 'active') -- see lib/ispEngine.js.
export function computeFunnelStageAtDisable(account) {
  if (!account) return "unknown";
  if (!account.first_login_at) return "before_login";
  if (!account.isp_submitted_at) return "before_isp_setup";
  if (!account.isp_approved_at) return "during_isp_verification";
  const wentLive = Boolean(
    account.isp_status === "active" || account.user_authorized_at || account.node_connected_at
  );
  return wentLive ? "after_isp_approval_went_live" : "after_isp_approval_never_live";
}

// Canonical disable helper. `reason` must be 'manual_admin' |
// 'jvzoo_refund' (extend this set deliberately, never silently pass an
// unvalidated free-form string here -- Analytics' "Disabled By Reason"
// breakdown depends on this being a small, known enum). Returns
// { changed, account } -- `changed` is false when the account was
// already disabled (idempotent no-op re: status/snapshot, but sessions
// are still defensively re-revoked).
export function disableAccount(db, accountId, { reason }) {
  db.exec("BEGIN");
  try {
    const fresh = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(accountId);
    if (!fresh) {
      db.exec("ROLLBACK");
      return { changed: false, notFound: true };
    }

    const alreadyDisabled = fresh.account_status === "disabled";
    const now = new Date().toISOString();
    // Snapshot is computed from the account's CURRENT funnel fields --
    // correct to do so here specifically because this is the exact
    // moment of disable (before any further funnel progress could
    // occur), and COALESCE below guarantees it is only ever written
    // ONCE per disable lifecycle (never overwritten by a later
    // redundant disable call while still disabled).
    const stageSnapshot = computeFunnelStageAtDisable(fresh);

    // PASSWORDLESS-CUSTOMER-LOGIN batch: every enabled->disabled
    // transition permanently revokes the customer's current login
    // link by incrementing login_link_version (spec Part 4 -- "audit
    // all canonical account-disable paths ... increment/revoke
    // login_link_version"). This runs unconditionally on every call
    // (not just `!alreadyDisabled`), matching the existing "sessions
    // re-revoked defensively, harmless if already disabled" pattern
    // below -- incrementing an already-disabled account's version
    // again is harmless (its link is already dead either way) and
    // errs on the side of safety if this helper is ever invoked from
    // a new call site under slightly different assumptions in the
    // future.
    db.prepare(
      `UPDATE accounts
       SET account_status = 'disabled',
           disabled_at = COALESCE(disabled_at, ?),
           disable_reason = COALESCE(disable_reason, ?),
           disable_stage_snapshot = COALESCE(disable_stage_snapshot, ?),
           login_link_version = login_link_version + 1
       WHERE id = ?`
    ).run(now, reason, stageSnapshot, accountId);

    // Always safe/idempotent to re-run: revokes any session that may
    // have survived (belt-and-suspenders, matches every existing
    // disable call site's behavior).
    db.prepare(`DELETE FROM sessions WHERE account_id = ?`).run(accountId);

    db.exec("COMMIT");
    const updated = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(accountId);
    return { changed: !alreadyDisabled, account: updated };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// Re-enables a previously-disabled account. Per spec Part 5 ("if
// accounts can be re-enabled, audit that lifecycle carefully"): clears
// disabled_at/disable_reason/disable_stage_snapshot back to NULL so
// that if this account is disabled AGAIN in the future, disableAccount
// above's COALESCE guard correctly treats it as a genuinely NEW disable
// event and captures a fresh, accurate snapshot -- rather than being
// permanently stuck showing the FIRST-ever disable's stale funnel
// stage for a customer who has since progressed further and been
// disabled again for an unrelated reason.
export function enableAccount(db, accountId) {
  db.exec("BEGIN");
  try {
    const fresh = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(accountId);
    if (!fresh) {
      db.exec("ROLLBACK");
      return { changed: false, notFound: true };
    }
    const wasDisabled = fresh.account_status === "disabled";
    db.prepare(
      `UPDATE accounts
       SET account_status = 'active',
           disabled_at = NULL,
           disable_reason = NULL,
           disable_stage_snapshot = NULL
       WHERE id = ?`
    ).run(accountId);
    db.exec("COMMIT");
    const updated = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(accountId);
    return { changed: wasDisabled, account: updated };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
