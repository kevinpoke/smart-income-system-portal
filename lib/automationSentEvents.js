// Shared normalization of "actual automation sends" across BOTH delivery
// tables, so analytics (lib/supportAnalytics.js) and source-message
// triggers (MESSAGE_READ / DID_NOT_REPLY in lib/automationEvaluator.js)
// read ONE definition of "a send happened":
//   - scheduled_support_messages (legacy-managed automations, event_key
//     prefix per automation; delivered_at set, cancelled_at NULL)
//   - automation_sends (generic/admin-created automations, keyed by
//     automation_key; sent_at)
// Normalized shape: { automationKey, accountId, sentAt (ISO), supportMessageId|null }.
// No hardcoded automation list beyond the legacy event_key prefix map
// (prefixes are the only way legacy rows identify their automation).
import {
  WAITLIST_SELECTION_EVENT_PREFIX,
  ISP_CONFIRMATION_REMINDER_EVENT_PREFIX,
  GOLDEN_BRIDGE_FOLLOWUP_EVENT_PREFIX,
  NON_WAITLIST_4DAY_EVENT_PREFIX,
} from "./supportAutomation";

export const LEGACY_EVENT_PREFIX_BY_KEY = {
  waitlist_selection: WAITLIST_SELECTION_EVENT_PREFIX,
  isp_confirmation_reminder: ISP_CONFIRMATION_REMINDER_EVENT_PREFIX,
  golden_bridge_followup: GOLDEN_BRIDGE_FOLLOWUP_EVENT_PREFIX,
  non_waitlist_4day: NON_WAITLIST_4DAY_EVENT_PREFIX,
};

const LEGACY_PREFIX_ENTRIES = Object.entries(LEGACY_EVENT_PREFIX_BY_KEY);

// Returns every actual send (deduplicated), optionally limited to one
// automationKey. Dedupe: by supportMessageId when present (one posted
// message == one send even if recorded in both tables), else by
// key|account|sentAt.
export function listSentEvents(db, { automationKey = null } = {}) {
  const events = [];

  const legacyEntries = automationKey
    ? LEGACY_PREFIX_ENTRIES.filter(([k]) => k === automationKey)
    : LEGACY_PREFIX_ENTRIES;
  for (const [key, prefix] of legacyEntries) {
    const rows = db
      .prepare(
        `SELECT account_id AS accountId, delivered_at AS sentAt, support_message_id AS supportMessageId
         FROM scheduled_support_messages
         WHERE event_key LIKE ? AND delivered_at IS NOT NULL AND cancelled_at IS NULL`
      )
      .all(`${prefix}%`);
    for (const r of rows) events.push({ automationKey: key, ...r });
  }

  const genericRows = automationKey
    ? db
        .prepare(
          `SELECT automation_key AS automationKey, account_id AS accountId, sent_at AS sentAt, support_message_id AS supportMessageId
           FROM automation_sends WHERE automation_key = ?`
        )
        .all(automationKey)
    : db
        .prepare(
          `SELECT automation_key AS automationKey, account_id AS accountId, sent_at AS sentAt, support_message_id AS supportMessageId
           FROM automation_sends`
        )
        .all();
  events.push(...genericRows);

  const seen = new Set();
  const out = [];
  for (const e of events) {
    if (!e.sentAt) continue;
    const dk = e.supportMessageId ? `m:${e.supportMessageId}` : `k:${e.automationKey}|${e.accountId}|${e.sentAt}`;
    if (seen.has(dk)) continue;
    seen.add(dk);
    out.push(e);
  }
  return out;
}

// True when `accountId`'s conversation has a customer message strictly
// after `afterIso`. Fresh DB read -- used for DID_NOT_REPLY pre-send recheck.
export function hasCustomerReplyAfter(db, accountId, afterIso) {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM support_messages
         WHERE conversation_id = (SELECT id FROM conversations WHERE account_id = ?)
           AND sender_role = 'customer' AND created_at > ?
         LIMIT 1`
      )
      .get(accountId, afterIso)
  );
}
