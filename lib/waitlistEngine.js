// Server-only waitlist workflow helpers. Source of truth is entirely
// SQLite (accounts.waitlist_joined_at) -- there is no Zustand/localStorage
// involvement anywhere in this file or its callers.
//
// BRIDGES-REDESIGN batch: the countdown/deadline concept (previously
// WAITLIST_DURATION_MS/waitlistDeadlineMs, a fixed 4.8-day window from
// first_login_at) is REMOVED per spec -- anyone can join the waitlist at
// any time, with no eligibility window/gating. State collapses to just
// "open" (not yet joined) or "joined".
export function computeWaitlistStatus(account) {
  const joined = Boolean(account.waitlist_joined_at);
  return {
    state: joined ? "joined" : "open",
    joinedAt: account.waitlist_joined_at || null,
  };
}
