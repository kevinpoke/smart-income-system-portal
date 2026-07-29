import { MODULES_META, HOURS_BETWEEN_MODULES } from "./mockData";

// Server-only, SQLite-backed training-module progression engine.
// Refinement pass: this REPLACES the old client-side/Zustand `modules`
// state (lib/store.js `viewModule`/`adminUnlockModule`) as the sole
// source of truth for lock/unlock/completion. The Modules page reads
// everything from GET /api/modules; "Mark as Watched" only ever writes
// through POST /api/modules/[key]/complete, which re-derives and
// re-checks eligibility itself -- a customer calling that route directly
// out of order cannot skip ahead, because the route rejects any module
// that isn't ALREADY unlocked according to server state.
//
// Design (see lib/db.js account_module_progress for the schema):
// - Module 1 is unlocked immediately for every account (unlock_at = the
//   moment its row is first created, i.e. always in the past by the time
//   it's read).
// - Completing module N (POST .../N/complete) sets module N's
//   completed_at (once, never rewritten) and lazily creates module N+1's
//   row with unlock_at = now + 12 hours.
// - A module with no row yet, and whose PRECEDING module is not yet
//   completed, has no countdown to show at all -- the client renders
//   "Complete previous modules to Unlock this video" for these (per
//   spec) rather than a countdown, since there's nothing persisted yet
//   to count down to.
// - Admin override (accounts.modules_unlocked = 1) makes every module
//   immediately unlocked/watchable regardless of any of the above --
//   checked by the caller (see app/api/modules/route.js), not baked into
//   this module's own status computation, so the override's effect is
//   easy to audit in one place per the shared-authorization-helper
//   pattern used elsewhere in this codebase (lib/moduleAccess.js).

const HOUR_MS = 60 * 60 * 1000;

// Ensures module 1's row exists (idempotent: INSERT OR IGNORE), then
// returns the full current progress-row map { [moduleKey]: row } for the
// account. Called on every GET so a first-time visitor always sees
// module 1 already unlocked without requiring a separate "initialize"
// step.
export function ensureModuleProgressInitialized(db, accountId) {
  const existing = db
    .prepare(`SELECT 1 FROM account_module_progress WHERE account_id = ? AND module_key = 1`)
    .get(accountId);
  if (!existing) {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT OR IGNORE INTO account_module_progress (account_id, module_key, unlock_at, completed_at, created_at)
       VALUES (?, 1, ?, NULL, ?)`
    ).run(accountId, now, now);
  }
  return getProgressMap(db, accountId);
}

function getProgressMap(db, accountId) {
  const rows = db
    .prepare(`SELECT module_key, unlock_at, completed_at FROM account_module_progress WHERE account_id = ?`)
    .all(accountId);
  const map = {};
  for (const row of rows) {
    map[row.module_key] = row;
  }
  return map;
}

// Computes the full per-module status list for the Modules page. Every
// timestamp comparison uses the SERVER's own Date.now() (`nowMs`) as the
// single source of truth -- the client never gets to assert "my timer
// says it's unlocked."
//
// Returns an array aligned with MODULES_META, each entry:
//   { id, unlocked, completed, unlockAt, countdownMs, awaitingPrevious }
// - unlocked: true if unlock_at <= now (or admin override applies)
// - completed: true if completed_at is set
// - unlockAt: the persisted ISO timestamp (null if no row yet)
// - countdownMs: ms remaining until unlock_at, only when a row exists
//   and hasn't unlocked yet; null otherwise
// - awaitingPrevious: true when this module has NO row yet because an
//   earlier module in the sequence isn't completed yet (per spec, these
//   show fixed copy instead of a countdown)
export function computeModuleStatuses(db, account, nowMs = Date.now()) {
  const adminOverride = Boolean(account.modules_unlocked);
  const progress = ensureModuleProgressInitialized(db, account.id);

  const statuses = [];
  let previousCompleted = true; // module 1 has no "previous" to wait on

  for (const meta of MODULES_META) {
    const row = progress[meta.id];
    let unlocked = adminOverride;
    let completed = false;
    let unlockAt = null;
    let countdownMs = null;
    let awaitingPrevious = false;

    if (row) {
      unlockAt = row.unlock_at;
      completed = Boolean(row.completed_at);
      if (!unlocked) {
        const unlockMs = new Date(row.unlock_at).getTime();
        unlocked = nowMs >= unlockMs;
        if (!unlocked) {
          countdownMs = Math.max(0, unlockMs - nowMs);
        }
      }
    } else if (!adminOverride) {
      // No row yet: this module hasn't started its countdown because the
      // preceding module isn't completed. Nothing to count down to.
      awaitingPrevious = !previousCompleted;
    }

    statuses.push({
      id: meta.id,
      unlocked,
      completed,
      unlockAt,
      countdownMs,
      awaitingPrevious,
    });

    previousCompleted = completed || adminOverride;
  }

  return statuses;
}

// Marks a module complete for the account. Re-derives eligibility from
// SERVER state (never trusts a client-sent "it's unlocked" claim):
// - the admin override always allows completion (module was already
//   effectively unlocked)
// - otherwise the module's own persisted row must exist AND its
//   unlock_at must already be <= now
// - a module already marked complete is a no-op success (idempotent --
//   a duplicate/retried "Mark as Watched" click can't do anything twice)
// On a genuine first-time completion, lazily creates the NEXT module's
// row with unlock_at = now + 12h (only if it doesn't already exist --
// guards a theoretical double-write race without needing a transaction,
// since this is a single-row INSERT OR IGNORE).
export function completeModule(db, account, moduleKey) {
  const meta = MODULES_META.find((m) => m.id === moduleKey);
  if (!meta) {
    return { ok: false, reason: "not_found" };
  }

  const adminOverride = Boolean(account.modules_unlocked);
  const progress = ensureModuleProgressInitialized(db, account.id);
  const row = progress[moduleKey];

  if (row?.completed_at) {
    return { ok: true, alreadyCompleted: true };
  }

  if (!adminOverride) {
    if (!row) {
      return { ok: false, reason: "locked" };
    }
    const unlockMs = new Date(row.unlock_at).getTime();
    if (Date.now() < unlockMs) {
      return { ok: false, reason: "locked", remainingMs: unlockMs - Date.now() };
    }
  } else if (!row) {
    // Admin override with no row yet (module was skipped straight to
    // "available" by the override, never had its own row created) --
    // create one now, already unlocked, so completion has something to
    // stamp completed_at onto.
    const now = new Date().toISOString();
    db.prepare(
      `INSERT OR IGNORE INTO account_module_progress (account_id, module_key, unlock_at, completed_at, created_at)
       VALUES (?, ?, ?, NULL, ?)`
    ).run(account.id, moduleKey, now, now);
  }

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE account_module_progress SET completed_at = COALESCE(completed_at, ?)
     WHERE account_id = ? AND module_key = ?`
  ).run(now, account.id, moduleKey);

  const nextKey = moduleKey + 1;
  const hasNext = MODULES_META.some((m) => m.id === nextKey);
  if (hasNext) {
    const nextUnlockAt = new Date(Date.now() + HOURS_BETWEEN_MODULES * HOUR_MS).toISOString();
    db.prepare(
      `INSERT OR IGNORE INTO account_module_progress (account_id, module_key, unlock_at, completed_at, created_at)
       VALUES (?, ?, ?, NULL, ?)`
    ).run(account.id, nextKey, nextUnlockAt, now);
  }

  return { ok: true, completedAt: now };
}
