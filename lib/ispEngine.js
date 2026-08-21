import { generateId } from "./auth-crypto";
import { addOwnedNode } from "./ownedNodes";
import { scheduleMessage, ISP_APPROVED_MESSAGE } from "./supportAutomation";

// Production feature/fix batch: how long an ISP setup is allowed to sit
// in 'pending_review' before the SERVER (never a client timer) treats it
// as automatically approved. Matches the customer-facing "3 business
// days" copy on the ISP Setup page.
export const AUTO_APPROVE_AFTER_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

// Server-only ISP "I Approve" -> Node-activation authorization engine.
// Mirrors lib/wifiEngine.js's OFF->ON reconnection flow exactly, for the
// exact same reason: the customer sees a 20-second "Establishing a
// Secure Connection..." progress modal, and the backend does NOT flip
// isp_status to 'active' (nor create the owned Node / start WiFi/
// earnings) until that 20 seconds has genuinely elapsed -- validated
// SERVER-SIDE via isp_authorize_started_at, never trusting a
// client-timed "I'm done" signal alone. This is what makes the flow
// resumable across a refresh and immune to a client racing ahead of
// real elapsed time: isp_status stays 'approved_awaiting_user' (not yet
// active) until completeIspAuthorization below is called AND enough
// real wall-clock time has passed since the persisted start timestamp.
export const AUTHORIZE_DURATION_MS = 20000; // exactly 20 seconds, per spec

// Begins (or resumes) the authorization window. Idempotent/concurrency-
// safe: if authorization is already in progress, returns the EXISTING
// start timestamp unchanged (never resets the clock), so a double-click,
// a duplicate request, or a page refresh that re-fires the "start" call
// can't extend or restart the 20-second window. Rejects if isp_status
// isn't currently 'approved_awaiting_user' (nothing to authorize, or
// already active/duplicate authorization).
export function startIspAuthorization(db, accountId) {
  db.exec("BEGIN");
  try {
    const fresh = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(accountId);
    if (!fresh) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "not_found" };
    }
    if (fresh.isp_status !== "approved_awaiting_user") {
      db.exec("ROLLBACK");
      return { ok: false, reason: "not_awaiting_authorization" };
    }

    let startedAt = fresh.isp_authorize_started_at;
    if (!startedAt) {
      startedAt = new Date().toISOString();
      db.prepare(`UPDATE accounts SET isp_authorize_started_at = ? WHERE id = ?`).run(
        startedAt,
        accountId
      );
    }
    db.exec("COMMIT");
    return {
      ok: true,
      startedAt,
      durationMs: AUTHORIZE_DURATION_MS,
      readyAt: new Date(new Date(startedAt).getTime() + AUTHORIZE_DURATION_MS).toISOString(),
    };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// Completes the authorization window. Only actually activates the
// account (isp_status = 'active', node_connected_at/user_authorized_at
// set, WiFi initialized ON, first owned Node granted) once the server
// independently confirms at least AUTHORIZE_DURATION_MS has elapsed
// since the persisted isp_authorize_started_at -- the client's own
// 20-second visual timer is never trusted as the sole authority.
// isp_authorize_started_at is cleared on success so a stale row can
// never linger. Idempotent: a duplicate/racing completion call after
// the account is already active returns success with alreadyActive:true
// rather than an error.
export function completeIspAuthorization(db, accountId) {
  let result;
  db.exec("BEGIN");
  try {
    const fresh = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(accountId);
    if (!fresh) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "not_found" };
    }
    if (fresh.isp_status === "active") {
      db.exec("ROLLBACK");
      return { ok: true, alreadyActive: true, account: fresh };
    }
    if (fresh.isp_status !== "approved_awaiting_user" || !fresh.isp_authorize_started_at) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "not_authorizing" };
    }

    const startedMs = new Date(fresh.isp_authorize_started_at).getTime();
    const elapsedMs = Date.now() - startedMs;
    if (elapsedMs < AUTHORIZE_DURATION_MS) {
      db.exec("ROLLBACK");
      return {
        ok: false,
        reason: "too_early",
        remainingMs: AUTHORIZE_DURATION_MS - elapsedMs,
      };
    }

    const now = new Date().toISOString();
    db.prepare(
      `UPDATE accounts
       SET user_authorized_at = COALESCE(user_authorized_at, ?),
           node_connected_at = COALESCE(node_connected_at, ?),
           wifi_enabled = 1,
           wifi_state_since = COALESCE(wifi_state_since, ?),
           isp_status = 'active',
           isp_authorize_started_at = NULL
       WHERE id = ?`
    ).run(now, now, now, accountId);

    db.prepare(
      `INSERT INTO wifi_events (id, account_id, action, created_at) VALUES (?, ?, 'on', ?)`
    ).run(generateId("wifiev"), accountId, now);

    addOwnedNode(db, accountId);

    db.exec("COMMIT");
    result = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(accountId);
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return { ok: true, account: result };
}

// Returns the current authorization status for an account -- used both
// by the start route's response AND by a page load/refresh mid-flow so
// the client can safely resume rendering the correct remaining progress
// from persisted state instead of restarting the visual timer from 0%.
export function getIspAuthorizeStatus(account) {
  if (!account?.isp_authorize_started_at) {
    return { authorizing: false };
  }
  const startedMs = new Date(account.isp_authorize_started_at).getTime();
  const elapsedMs = Math.max(0, Date.now() - startedMs);
  const remainingMs = Math.max(0, AUTHORIZE_DURATION_MS - elapsedMs);
  return {
    authorizing: true,
    startedAt: account.isp_authorize_started_at,
    elapsedMs,
    remainingMs,
    readyToComplete: remainingMs <= 0,
  };
}

// Production feature/fix batch: the ONE shared state-transition helper
// for moving an account from 'pending_review' to
// 'approved_awaiting_user' -- used by BOTH the admin manual-approval
// route (app/api/admin/isp/[id]/approve) and the fully automatic,
// server-authoritative 3-day timeout below (checkAndAutoApproveIsp).
// Centralizing this here (rather than duplicating the UPDATE in two
// places) is what guarantees manual and automatic approval always do
// exactly the same three things: flip isp_status, stamp isp_approved_at
// (once), and raise the new isp_unread flag + schedule exactly one
// ISP_APPROVED_MESSAGE -- per spec, "send EXACTLY ONCE per approval
// transition" regardless of which path triggered it.
//
// Idempotent by construction: only ever transitions an account that is
// CURRENTLY 'pending_review' (checked and updated in the same atomic
// UPDATE...WHERE, so two concurrent callers -- e.g. an admin clicking
// Approve at the exact moment the auto-approve check also fires for the
// same account -- can never both "win" the transition; the loser's
// UPDATE affects zero rows and it returns { transitioned: false }
// rather than double-scheduling the message or double-writing
// isp_approved_at).
export function transitionIspToApproved(db, accountId, { approvedBy = "system" } = {}) {
  const now = new Date().toISOString();

  const claim = db
    .prepare(
      `UPDATE accounts
       SET isp_status = 'approved_awaiting_user',
           isp_approved_at = COALESCE(isp_approved_at, ?),
           isp_unread = 1
       WHERE id = ? AND isp_status = 'pending_review'`
    )
    .run(now, accountId);

  if (claim.changes === 0) {
    return { transitioned: false };
  }

  // Deliver the "your ISP is ready" message right away (not delayed
  // like the login check-ins) -- the customer needs to know NOW that
  // they can go activate their Bridge. eventKey is scoped to this one
  // account so a re-approval attempt (which can't happen anyway, since
  // the UPDATE above only fires once per account) could never double-
  // schedule it; scheduleMessage()'s own UNIQUE(event_key) guard is a
  // second, belt-and-suspenders layer of the same "exactly once"
  // guarantee.
  scheduleMessage(db, {
    accountId,
    eventKey: `support:isp-approved:${accountId}`,
    body: ISP_APPROVED_MESSAGE,
    deliverAt: new Date(),
  });

  const account = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(accountId);
  return { transitioned: true, account, approvedBy };
}

// Production feature/fix batch: server-authoritative auto-approval.
// Deliberately NOT a setTimeout/cron -- called inline from every
// customer-facing read of account/ISP status (GET /api/auth/me at
// minimum) so an account that has been sitting in 'pending_review' past
// its 3-day deadline gets promoted to 'approved_awaiting_user' on the
// very next request that reads it, with zero background process. Also
// correctly handles an account that was ALREADY overdue at the moment
// this code is deployed -- the very first request that reads it
// afterward approves it, per spec.
//
// Returns the account row (freshly re-fetched if a transition just
// happened, otherwise the same row passed in unchanged) so callers can
// use the up-to-date isp_status/isp_unread immediately without a second
// query.
export function checkAndAutoApproveIsp(db, account) {
  if (!account || account.isp_status !== "pending_review" || !account.isp_submitted_at) {
    return account;
  }

  const submittedMs = new Date(account.isp_submitted_at).getTime();
  if (Date.now() < submittedMs + AUTO_APPROVE_AFTER_MS) {
    return account;
  }

  const result = transitionIspToApproved(db, account.id, { approvedBy: "system" });
  return result.transitioned ? result.account : account;
}
