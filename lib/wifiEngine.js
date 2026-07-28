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
