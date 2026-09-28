import { generateId } from "./auth-crypto";
import {
  getBunbunListId,
  get3DayNoLoginListId,
  findSubscriberByEmail,
  unsubscribeFromList,
  ensureSubscribedToList,
} from "./aweberClient";

// AWEBER-3DAY-NO-LOGIN-SYNC batch: automates spec Part C in full.
//
// BUSINESS RULE: once a customer has been registered at least 72 hours
// AND has never logged in, remove them from BUNBUN MEDIA CO and add
// them to 3DAY NO LOGIN (a one-way quarantine/blacklist -- this app
// never automatically moves someone back to BUNBUN MEDIA CO even if
// they later log in, per spec section "NEW BUSINESS RULE").
//
// ELIGIBILITY REUSES THE EXISTING AUTHORITATIVE DEFINITION: rather than
// re-deriving a second 72h-no-login query, this module's scheduler scan
// (runAweberThreeDayNoLoginScan below) selects candidates directly from
// admin_never_logged_in_3day -- the SAME permanent table Admin Portal ->
// Never Logged In already reads (lib/neverLoggedIn.js), populated by the
// SAME canonical query. This is exactly what spec section 14 requires:
// "Admin and AWeber cannot disagree" -- there is only ONE eligibility
// computation in this codebase, never two.
//
// LOGIN RACE SAFETY (spec section 20): admin_never_logged_in_3day is a
// permanent historical snapshot that is NEVER updated after a customer
// later logs in (see that table's own header comment) -- so it alone is
// NOT sufficient to prove first_login_at is STILL NULL at the exact
// moment of the AWeber action. This module re-reads accounts.
// first_login_at live, immediately before acting, and skips (does not
// mark complete, does not error) any candidate that logged in between
// candidate selection and execution -- see the live recheck inside
// syncThreeDayNoLoginToAweber() below.

const MAX_ATTEMPTS_PER_TICK_LOG = 3; // bounded retry visibility, not a hard cap on lifetime attempts

function nowIso() {
  return new Date().toISOString();
}

// Reads (or lazily creates) this account's durable sync row. Lazy
// creation on first touch means the table only ever contains rows for
// accounts that have actually been processed at least once -- never a
// bulk pre-seed of every historical Never-Logged-In row, which keeps
// this table's growth proportional to real scheduler activity.
function getOrCreateSyncRow(db, account) {
  const existing = db
    .prepare(`SELECT * FROM aweber_3day_no_login_sync WHERE account_id = ?`)
    .get(account.id);
  if (existing) return existing;

  const id = generateId("aweb3dsync");
  const ts = nowIso();
  db.prepare(
    `INSERT INTO aweber_3day_no_login_sync
       (id, account_id, email, qualified_at, status, attempt_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`
  ).run(id, account.id, account.email, ts, ts, ts);
  return db.prepare(`SELECT * FROM aweber_3day_no_login_sync WHERE account_id = ?`).get(account.id);
}

function markRow(db, accountId, fields) {
  const sets = [];
  const params = [];
  for (const [key, value] of Object.entries(fields)) {
    sets.push(`${key} = ?`);
    params.push(value);
  }
  sets.push(`updated_at = ?`);
  params.push(nowIso());
  params.push(accountId);
  db.prepare(`UPDATE aweber_3day_no_login_sync SET ${sets.join(", ")} WHERE account_id = ?`).run(
    ...params
  );
}

// Canonical per-account move function (spec section 16:
// "syncThreeDayNoLoginToAweber(account)"). Idempotent: safe to call
// repeatedly for the same account in any state (pending, partial,
// error, or already complete) without duplicating a subscriber,
// re-triggering removal/re-add side effects beyond what's still
// needed, or erroring on an already-finished account.
//
// Returns { status, skipped?, reason? } describing what happened this
// call. NEVER THROWS: any unexpected exception from the underlying
// AWeber client (e.g. refreshAccessToken() failing outright with a
// network error or misconfigured credentials -- a genuine thrown
// exception, not one of the client's normal `{ ok: false, error }`
// results) is caught here, durably recorded on the account's own sync
// row (status: 'error', last_error), and returned as a normal
// `{ status: "error", error }` result instead of propagating -- this
// guarantees BOTH callers (the background scheduler's batch loop AND
// the admin manual "Retry AWeber Sync" route) always see a consistent,
// safe result and the durable row is always kept in sync with reality,
// regardless of which caller invoked this function or whether it
// itself remembers to wrap the call in a try/catch.
export async function syncThreeDayNoLoginToAweber(db, account) {
  const row = getOrCreateSyncRow(db, account);

  if (row.status === "complete") {
    // Already fully moved -- a safe no-op per spec section 16 ("Running
    // it repeatedly must NOT ... repeatedly unsubscribe ... repeatedly
    // re-add").
    return { status: "complete", skipped: true, reason: "already_complete" };
  }

  try {
    return await performSync(db, account, row);
  } catch (err) {
    const message = err?.message || String(err);
    markRow(db, account.id, { status: "error", last_error: `unexpected: ${message}` });
    return { status: "error", error: { message } };
  }
}

async function performSync(db, account, row) {

  // LOGIN RACE SAFETY (spec section 20): re-read the account live,
  // immediately before acting, and require first_login_at IS NULL at
  // THIS moment -- not merely at candidate-selection time. A customer
  // who logged in between selection and this call is skipped entirely
  // (no AWeber action taken, row left exactly as it was for this call
  // so a future tick can re-evaluate it against fresh data, though in
  // practice a genuinely-logged-in account will never re-qualify since
  // admin_never_logged_in_3day is permanent/append-only and the
  // scheduler scan below selects from it -- this recheck exists purely
  // to guarantee the ACTION itself never fires against a stale
  // candidate, regardless of how it was selected).
  const fresh = db.prepare(`SELECT id, first_login_at, email, first_name, last_name FROM accounts WHERE id = ?`).get(account.id);
  if (!fresh) {
    return { status: row.status, skipped: true, reason: "account_not_found" };
  }
  if (fresh.first_login_at !== null && fresh.first_login_at !== undefined) {
    return { status: row.status, skipped: true, reason: "logged_in_before_execution" };
  }

  markRow(db, account.id, { last_attempt_at: nowIso(), attempt_count: row.attempt_count + 1 });

  const bunbunListId = getBunbunListId();
  const threeDayListId = get3DayNoLoginListId();

  let removedThisCall = false;
  let addedThisCall = false;

  // Step A/B: find + unsubscribe from BUNBUN MEDIA CO, unless already
  // recorded as done (idempotent -- never re-issues a redundant
  // unsubscribe call once source_list_removed_at is set).
  if (!row.source_list_removed_at) {
    const found = await findSubscriberByEmail(bunbunListId, fresh.email);
    if (found.error) {
      markRow(db, account.id, {
        status: "error",
        last_error: `find-in-bunbun: ${found.error.message}`,
      });
      return { status: "error", error: found.error };
    }
    if (found.found) {
      const removeResult = await unsubscribeFromList(bunbunListId, found.subscriber.id);
      if (!removeResult.ok) {
        markRow(db, account.id, {
          status: "error",
          last_error: `unsubscribe-from-bunbun: ${removeResult.error.message}`,
        });
        return { status: "error", error: removeResult.error };
      }
      removedThisCall = true;
    } else {
      // Not present in BUNBUN MEDIA CO at all (e.g. never actually
      // synced there, or already removed by some other means) -- there
      // is nothing to remove; treat the removal side as satisfied so
      // this doesn't block the add step or loop forever retrying a
      // removal that has nothing to act on.
      removedThisCall = true;
    }
    markRow(db, account.id, { source_list_removed_at: nowIso() });
  }

  // Step C: ensure present (subscribed) in 3DAY NO LOGIN, unless
  // already recorded as done.
  const currentRow = db.prepare(`SELECT * FROM aweber_3day_no_login_sync WHERE account_id = ?`).get(account.id);
  if (!currentRow.target_list_added_at) {
    const addResult = await ensureSubscribedToList(threeDayListId, {
      email: fresh.email,
      firstName: fresh.first_name,
      lastName: fresh.last_name,
    });
    if (!addResult.ok) {
      markRow(db, account.id, {
        status: "partial",
        last_error: `add-to-3day: ${addResult.error.message}`,
      });
      return { status: "partial", error: addResult.error };
    }
    addedThisCall = true;
    markRow(db, account.id, { target_list_added_at: nowIso() });
  }

  const finalRow = db.prepare(`SELECT * FROM aweber_3day_no_login_sync WHERE account_id = ?`).get(account.id);
  if (finalRow.source_list_removed_at && finalRow.target_list_added_at) {
    markRow(db, account.id, { status: "complete", last_success_at: nowIso(), last_error: null });
    return { status: "complete", removedThisCall, addedThisCall };
  }

  // Shouldn't normally be reachable (both steps above either complete
  // or return early on failure), but defensively mark partial rather
  // than silently leaving an ambiguous status.
  markRow(db, account.id, { status: "partial" });
  return { status: "partial", removedThisCall, addedThisCall };
}

// Batch scan for the existing background scheduler (spec sections
// 18-19): finds every candidate that:
//   - is in the permanent admin_never_logged_in_3day cohort (the SAME
//     canonical Never Logged In definition Admin Portal uses -- no
//     second eligibility query)
//   - has NOT yet completed the AWeber move (no sync row at all, or a
//     sync row whose status is pending/partial/error)
// and calls syncThreeDayNoLoginToAweber() for each, up to `batchSize`
// per invocation (spec section 19: "process a reasonable number per
// scheduler pass ... continue on subsequent passes" -- rate-limit
// safety against AWeber, whose exact limits this scan does not assume
// but stays well under by keeping batches small and sequential, never
// firing all candidates concurrently).
const DEFAULT_BATCH_SIZE = 25;

export async function runAweberThreeDayNoLoginScan(db, { batchSize = DEFAULT_BATCH_SIZE } = {}) {
  const candidates = db
    .prepare(
      `SELECT a.id, a.email, a.first_name, a.last_name, a.first_login_at
       FROM admin_never_logged_in_3day n
       JOIN accounts a ON a.id = n.account_id
       LEFT JOIN aweber_3day_no_login_sync s ON s.account_id = a.id
       WHERE a.first_login_at IS NULL
         AND (s.account_id IS NULL OR s.status IN ('pending', 'partial', 'error'))
       ORDER BY n.qualified_at ASC
       LIMIT ?`
    )
    .all(batchSize);

  let processed = 0;
  let completed = 0;
  let skipped = 0;
  let errored = 0;

  for (const candidate of candidates) {
    processed += 1;
    try {
      const result = await syncThreeDayNoLoginToAweber(db, candidate);
      if (result.status === "complete" && !result.skipped) completed += 1;
      else if (result.skipped) skipped += 1;
      else if (result.status === "error") errored += 1;
    } catch (err) {
      errored += 1;
      // Never let one account's unexpected exception abort the whole
      // batch -- record it and continue with the next candidate.
      markRow(db, candidate.id, {
        status: "error",
        last_error: `unexpected: ${err?.message || String(err)}`,
      });
    }
  }

  return { candidatesFound: candidates.length, processed, completed, skipped, errored };
}
