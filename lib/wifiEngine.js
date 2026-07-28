// Server-only WiFi on/off toggle engine. This is deliberately independent
// from isp_status: isp_status tracks the one-way ISP Setup/Node-activation
// workflow (not_started -> ... -> active) while wifi_enabled/wifi_state_since
// track the customer's own reversible on/off control over their already
// -activated Node. Turning WiFi off must never touch isp_status, ISP setup
// data, or owned Node records.
//
// wifi_events is the durable, timestamped audit trail of every transition
// (see lib/db.js for why this is a dedicated table rather than audit_log).

import { generateId } from "./auth-crypto";

// Returns { enabled, since } for the given fresh account row.
export function getWifiState(account) {
  return {
    enabled: Boolean(account.wifi_enabled),
    since: account.wifi_state_since || account.node_connected_at || null,
  };
}

// Flips the WiFi state for an account. No-ops (returns { changed: false })
// if the requested state already matches the current state, so repeated
// identical toggle calls are safe/idempotent. Wrapped in a transaction so
// the accounts row update and the wifi_events insert can never diverge.
export function setWifiEnabled(db, accountId, enabled) {
  db.exec("BEGIN");
  try {
    const fresh = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(accountId);
    if (!fresh) {
      db.exec("ROLLBACK");
      return { changed: false, notFound: true };
    }
    const currentlyEnabled = Boolean(fresh.wifi_enabled);
    if (currentlyEnabled === enabled) {
      db.exec("ROLLBACK");
      return { changed: false, account: fresh };
    }

    const now = new Date().toISOString();
    db.prepare(
      `UPDATE accounts SET wifi_enabled = ?, wifi_state_since = ? WHERE id = ?`
    ).run(enabled ? 1 : 0, now, accountId);

    db.prepare(
      `INSERT INTO wifi_events (id, account_id, action, created_at) VALUES (?, ?, ?, ?)`
    ).run(generateId("wifiev"), accountId, enabled ? "on" : "off", now);

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  const updated = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(accountId);
  return { changed: true, account: updated };
}

// ---- OFF -> ON reconnection flow (Dashboard adjustment pass) -------------
//
// Turning WiFi back ON is no longer instantaneous: the customer sees a
// 20-second "Establishing a Secure Connection..." progress modal, and the
// backend does NOT mark wifi_enabled = 1 (nor start a new accrual
// interval) until that 20 seconds has genuinely elapsed -- validated
// SERVER-SIDE via wifi_reconnect_started_at, never trusting a client-timed
// "I'm done" signal alone. This is what makes the flow safe against a
// customer refreshing, closing the tab, or logging out mid-reconnection:
// wifi_enabled stays 0 (still off, no earnings) until completeWifiReconnect
// below is called AND enough real wall-clock time has passed since the
// persisted start timestamp.
export const RECONNECT_DURATION_MS = 20000; // exactly 20 seconds, per spec

// Begins (or resumes) a reconnection attempt. Idempotent/concurrency-safe:
// if a reconnection is already in progress, returns the EXISTING start
// timestamp unchanged (never resets the clock), so a double-click, a
// duplicate request, or a page refresh that re-fires the "start" call
// can't extend or restart the 20-second window. Rejects if WiFi is
// already ON (nothing to reconnect) or if the account isn't eligible
// (Node not yet activated).
export function startWifiReconnect(db, accountId) {
  db.exec("BEGIN");
  try {
    const fresh = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(accountId);
    if (!fresh) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "not_found" };
    }
    if (fresh.isp_status !== "active" || !fresh.node_connected_at) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "not_eligible" };
    }
    if (Boolean(fresh.wifi_enabled)) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "already_on" };
    }

    let startedAt = fresh.wifi_reconnect_started_at;
    if (!startedAt) {
      startedAt = new Date().toISOString();
      db.prepare(`UPDATE accounts SET wifi_reconnect_started_at = ? WHERE id = ?`).run(
        startedAt,
        accountId
      );
    }
    db.exec("COMMIT");
    return {
      ok: true,
      startedAt,
      durationMs: RECONNECT_DURATION_MS,
      readyAt: new Date(new Date(startedAt).getTime() + RECONNECT_DURATION_MS).toISOString(),
    };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// Completes a reconnection attempt. Only actually marks the account
// connected (wifi_enabled = 1, wifi_state_since = the completion instant)
// once the server independently confirms at least RECONNECT_DURATION_MS
// has elapsed since the persisted wifi_reconnect_started_at -- the
// client's own 20-second visual timer is never trusted as the sole
// authority, so a manipulated/racing client request can't shorten the
// real waiting period. wifi_reconnect_started_at is cleared on success so
// a stale row can never linger and confuse a later reconnection attempt.
export function completeWifiReconnect(db, accountId) {
  db.exec("BEGIN");
  try {
    const fresh = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(accountId);
    if (!fresh) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "not_found" };
    }
    if (Boolean(fresh.wifi_enabled)) {
      // Already connected (e.g. a duplicate/racing completion request) --
      // idempotent no-op success rather than an error.
      db.exec("ROLLBACK");
      return { ok: true, alreadyConnected: true, account: fresh };
    }
    if (!fresh.wifi_reconnect_started_at) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "not_reconnecting" };
    }

    const startedMs = new Date(fresh.wifi_reconnect_started_at).getTime();
    const elapsedMs = Date.now() - startedMs;
    if (elapsedMs < RECONNECT_DURATION_MS) {
      db.exec("ROLLBACK");
      return {
        ok: false,
        reason: "too_early",
        remainingMs: RECONNECT_DURATION_MS - elapsedMs,
      };
    }

    const now = new Date().toISOString();
    db.prepare(
      `UPDATE accounts SET wifi_enabled = 1, wifi_state_since = ?, wifi_reconnect_started_at = NULL WHERE id = ?`
    ).run(now, accountId);
    db.prepare(
      `INSERT INTO wifi_events (id, account_id, action, created_at) VALUES (?, ?, 'on', ?)`
    ).run(generateId("wifiev"), accountId, now);

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  const updated = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(accountId);
  return { ok: true, account: updated };
}

// Returns the current reconnection status for an account -- used both by
// the toggle-start route's response AND by a page load/refresh mid-flow
// (e.g. the Dashboard re-mounting) so the client can safely resume
// rendering the correct remaining progress from persisted state instead
// of restarting the visual timer from 0%.
export function getWifiReconnectStatus(account) {
  if (!account?.wifi_reconnect_started_at) {
    return { reconnecting: false };
  }
  const startedMs = new Date(account.wifi_reconnect_started_at).getTime();
  const elapsedMs = Math.max(0, Date.now() - startedMs);
  const remainingMs = Math.max(0, RECONNECT_DURATION_MS - elapsedMs);
  return {
    reconnecting: true,
    startedAt: account.wifi_reconnect_started_at,
    elapsedMs,
    remainingMs,
    readyToComplete: remainingMs <= 0,
  };
}

// Computes how many milliseconds the account's WiFi was ON within
// [rangeStartMs, rangeEndMs), by replaying wifi_events chronologically
// starting from an assumed "on" state at `connectedAtMs` (Node activation
// always starts connected -- see app/api/isp/authorize). This is what
// makes freeze-on-off / resume-on-on / no-retroactive-earnings all fall
// out of one general-purpose function instead of special-cased branches:
// if the account is CURRENTLY off, the trailing segment's `on` flag is
// false, so extending the range to "now" never adds more on-time no
// matter how much wall-clock time passes -- earnings are frozen for free.
export function computeOnMsInRange(db, accountId, connectedAtMs, rangeStartMs, rangeEndMs) {
  if (!connectedAtMs || rangeEndMs <= rangeStartMs) return 0;

  const events = db
    .prepare(`SELECT action, created_at FROM wifi_events WHERE account_id = ? ORDER BY created_at ASC`)
    .all(accountId);

  const segments = [];
  let cursorMs = connectedAtMs;
  let cursorOn = true; // Node activation implies WiFi starts ON.

  for (const ev of events) {
    const t = new Date(ev.created_at).getTime();
    if (Number.isNaN(t) || t <= cursorMs) {
      // Out-of-order or pre-connection event (shouldn't normally happen);
      // just adopt its state without creating a zero/negative-length
      // segment.
      cursorOn = ev.action === "on";
      continue;
    }
    segments.push({ start: cursorMs, end: t, on: cursorOn });
    cursorMs = t;
    cursorOn = ev.action === "on";
  }
  // Extend the final segment out to (at least) rangeEndMs so a currently-
  // on account keeps accruing right up to "now", and a currently-off
  // account contributes zero for the remainder of the range.
  segments.push({ start: cursorMs, end: Math.max(cursorMs, rangeEndMs), on: cursorOn });

  let onMs = 0;
  for (const seg of segments) {
    const s = Math.max(seg.start, rangeStartMs);
    const e = Math.min(seg.end, rangeEndMs);
    if (e > s && seg.on) onMs += e - s;
  }
  return onMs;
}
