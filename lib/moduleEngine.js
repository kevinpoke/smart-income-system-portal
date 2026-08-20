import { MODULES_META, MODULE_UNLOCK_HOURS } from "./mockData";

// Server-only, SQLite-backed training-module progression engine.
//
// Rollout timing pass (Smart Income System launch): module unlock timing
// is no longer a sequential "12h after completing the previous module"
// chain -- it is now a FIXED schedule of hours-after-first-login, defined
// once in lib/mockData.js MODULE_UNLOCK_HOURS and applied uniformly here:
//   Modules 1-3: unlocked immediately (0h)
//   Module 4:    first_login_at + 16h
//   Module 5:    first_login_at + 32h
//   Module 6:    first_login_at + 48h
//   Module 7:    first_login_at + 64h
//   Module 8:    first_login_at + 80h
//   Module 9:    first_login_at + 96h
//   Module 10:   first_login_at + 112h
//   Module 11:   first_login_at + 128h
// The timer's ONLY input is accounts.first_login_at (set once, on the
// customer's first successful login -- see app/api/auth/login/route.js
// `SET first_login_at = COALESCE(first_login_at, ?)`, never overwritten
// on subsequent logins/logout/refresh/device change/clock change). This
// module never reads or writes first_login_at itself; it only consumes
// the value already on the account row passed in by the caller.
//
// This REPLACES the old client-side/Zustand `modules` state (lib/store.js
// `viewModule`/`adminUnlockModule`) as the sole source of truth for
// lock/unlock. The Modules page reads everything from GET /api/modules;
// "Mark as Watched" only ever writes through POST
// /api/modules/[key]/complete, which re-derives and re-checks eligibility
// itself -- a customer calling that route directly out of order cannot
// mark/unlock ahead of the schedule, because the route rejects any
// module that isn't ALREADY unlocked according to server state (this
// account's first_login_at + that module's configured delay, or the
// admin override).
//
// Design (see lib/db.js account_module_progress for the schema): this
// table now stores ONLY completion state (completed_at) per module --
// unlock timing is no longer persisted per-row at all, since it is fully
// determined at read-time from account.first_login_at +
// MODULE_UNLOCK_HOURS[moduleKey]. A row is created lazily the first time
// a module is completed; a module with no row simply has completed_at =
// null.
//
// Admin override (accounts.modules_unlocked = 1) makes every module
// immediately unlocked/watchable regardless of any of the above --
// checked by the caller (see app/api/modules/route.js), not baked into
// this module's own status computation, so the override's effect is
// easy to audit in one place per the shared-authorization-helper pattern
// used elsewhere in this codebase (lib/moduleAccess.js). Per spec, admin
// override takes precedence over the first-login timer.

const HOUR_MS = 60 * 60 * 1000;

function getProgressMap(db, accountId) {
  const rows = db
    .prepare(`SELECT module_key, completed_at FROM account_module_progress WHERE account_id = ?`)
    .all(accountId);
  const map = {};
  for (const row of rows) {
    map[row.module_key] = row;
  }
  return map;
}

// Computes the authoritative unlock timestamp (in ms since epoch) for a
// given module id, or null when it can't yet be determined (module id
// not in the schedule, or -- for a >0h module -- first_login_at hasn't
// been recorded yet, which should not happen for an authenticated
// customer post-login but is guarded against defensively). Modules with
// a 0h delay (1-3) always resolve to a definite past timestamp (their
// account's created_at, or epoch 0 as an ultimate fallback) so they are
// always immediately unlocked, independent of first_login_at.
export function computeModuleUnlockAtMs(account, moduleKey) {
  const hours = MODULE_UNLOCK_HOURS[moduleKey];
  if (hours == null) return null;

  if (hours === 0) {
    // Immediate: unlocked the moment the account exists, regardless of
    // whether first_login_at has been recorded yet.
    const createdMs = account.created_at ? new Date(account.created_at).getTime() : 0;
    return Number.isFinite(createdMs) ? createdMs : 0;
  }

  const firstLoginAt = account.first_login_at;
  if (!firstLoginAt) return null; // timer hasn't started yet
  const firstLoginMs = new Date(firstLoginAt).getTime();
  if (!Number.isFinite(firstLoginMs)) return null;
  return firstLoginMs + hours * HOUR_MS;
}

// Returns true only when the given module has been genuinely completed
// by this account, i.e. account_module_progress.completed_at is set for
// that module_key. This checks REAL completion state only -- it does
// NOT consider the admin's per-customer "Unlock All Modules" timing
// override (accounts.modules_unlocked), which only bypasses the
// first-login unlock TIMER and never implies a module was actually
// watched/marked complete. Used by lib/moduleAccess.js hasPayoutAccess()
// to gate the Payouts section behind real Module 10 completion.
export function isModuleCompleted(db, accountId, moduleKey) {
  const row = db
    .prepare(
      `SELECT completed_at FROM account_module_progress WHERE account_id = ? AND module_key = ?`
    )
    .get(accountId, moduleKey);
  return Boolean(row?.completed_at);
}

// Computes the full per-module status list for the Modules page. Every
// timestamp comparison uses the SERVER's own Date.now() (`nowMs`) as the
// single source of truth -- the client never gets to assert "my timer
// says it's unlocked."
//
// Returns an array aligned with MODULES_META, each entry:
//   { id, unlocked, completed, unlockAt, countdownMs }
// - unlocked: true if unlockAt <= now (or admin override applies)
// - completed: true if completed_at is set
// - unlockAt: the derived ISO timestamp (null only in the defensive
//   edge case where first_login_at is somehow still missing)
// - countdownMs: ms remaining until unlockAt, only when unlockAt is
//   known and hasn't passed yet; null otherwise
export function computeModuleStatuses(db, account, nowMs = Date.now()) {
  const adminOverride = Boolean(account.modules_unlocked);
  const progress = getProgressMap(db, account.id);

  const statuses = [];

  for (const meta of MODULES_META) {
    const row = progress[meta.id];
    const completed = Boolean(row?.completed_at);
    const unlockAtMs = computeModuleUnlockAtMs(account, meta.id);
    let unlocked = adminOverride;
    let countdownMs = null;

    if (!unlocked) {
      if (unlockAtMs != null) {
        unlocked = nowMs >= unlockAtMs;
        if (!unlocked) {
          countdownMs = Math.max(0, unlockAtMs - nowMs);
        }
      }
      // unlockAtMs == null (first_login_at not yet recorded for a >0h
      // module) leaves unlocked=false, countdownMs=null -- the client
      // shows no countdown since there's nothing persisted yet to count
      // down to. This should not occur for an authenticated customer
      // (first_login_at is set at login, before this is ever read).
    }

    statuses.push({
      id: meta.id,
      unlocked,
      completed,
      unlockAt: unlockAtMs != null ? new Date(unlockAtMs).toISOString() : null,
      countdownMs,
    });
  }

  return statuses;
}

// Marks a module complete for the account. Re-derives eligibility from
// SERVER state (never trusts a client-sent "it's unlocked" claim):
// - the admin override always allows completion
// - otherwise the module's derived unlock timestamp
//   (account.first_login_at + MODULE_UNLOCK_HOURS[moduleKey]) must
//   already be <= now
// - a module already marked complete is a no-op success (idempotent --
//   a duplicate/retried "Mark as Watched" click can't do anything twice)
// Completion no longer needs to lazily create the NEXT module's row --
// every module's unlock timing is derived on the fly from the fixed
// schedule, not chained off the previous module's completion.
export function completeModule(db, account, moduleKey) {
  const meta = MODULES_META.find((m) => m.id === moduleKey);
  if (!meta) {
    return { ok: false, reason: "not_found" };
  }

  const adminOverride = Boolean(account.modules_unlocked);
  const progress = getProgressMap(db, account.id);
  const row = progress[moduleKey];

  if (row?.completed_at) {
    return { ok: true, alreadyCompleted: true };
  }

  if (!adminOverride) {
    const unlockAtMs = computeModuleUnlockAtMs(account, moduleKey);
    if (unlockAtMs == null || Date.now() < unlockAtMs) {
      return {
        ok: false,
        reason: "locked",
        remainingMs: unlockAtMs != null ? unlockAtMs - Date.now() : null,
      };
    }
  }

  const now = new Date().toISOString();
  // account_module_progress.unlock_at remains a NOT NULL column in the
  // existing schema (lib/db.js) purely for backward compatibility with
  // rows written before this rollout-timing pass; it is no longer read
  // by anything (unlock timing is now derived entirely from
  // computeModuleUnlockAtMs above), so we just stamp it with `now` as a
  // harmless placeholder to satisfy the NOT NULL constraint without an
  // ALTER TABLE / schema migration.
  db.prepare(
    `INSERT INTO account_module_progress (account_id, module_key, unlock_at, completed_at, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(account_id, module_key)
       DO UPDATE SET completed_at = COALESCE(account_module_progress.completed_at, excluded.completed_at)`
  ).run(account.id, moduleKey, now, now, now);

  return { ok: true, completedAt: now };
}
