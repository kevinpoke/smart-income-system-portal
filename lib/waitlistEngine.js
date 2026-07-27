// Server-only waitlist workflow helpers. Source of truth is entirely
// SQLite (accounts.first_login_at / waitlist_joined_at) -- there is no
// Zustand/localStorage involvement anywhere in this file or its callers.

const WAITLIST_DURATION_MS =
  4 * 24 * 60 * 60 * 1000 + // 4 days
  19 * 60 * 60 * 1000 + // 19 hours
  12 * 60 * 1000; // 12 minutes
// = 4.8 days exactly (4*24 + 19 + 12/60 = 115.2 hours = 4.8 days).

export function waitlistDeadlineMs(firstLoginAtIso) {
  if (!firstLoginAtIso) return null;
  return new Date(firstLoginAtIso).getTime() + WAITLIST_DURATION_MS;
}

// Computes the full waitlist status for the customer-facing waitlist
// widget/button. Never mutates anything -- pure read derived from the
// account row's first_login_at and waitlist_joined_at columns.
export function computeWaitlistStatus(account, now = Date.now()) {
  const deadlineMs = waitlistDeadlineMs(account.first_login_at);
  const joined = Boolean(account.waitlist_joined_at);
  const expired = deadlineMs != null && now >= deadlineMs && !joined;
  const remainingMs = deadlineMs != null ? Math.max(0, deadlineMs - now) : null;

  let state; // "not_started" | "open" | "joined" | "closed"
  if (!deadlineMs) {
    state = "not_started"; // first_login_at not set yet (shouldn't happen post-login, but guard anyway)
  } else if (joined) {
    state = "joined";
  } else if (expired) {
    state = "closed";
  } else {
    state = "open";
  }

  return {
    state,
    deadlineAt: deadlineMs != null ? new Date(deadlineMs).toISOString() : null,
    remainingMs,
    joinedAt: account.waitlist_joined_at || null,
  };
}

export { WAITLIST_DURATION_MS };
