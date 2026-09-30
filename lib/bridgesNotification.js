// BRIDGES-NOTIFICATION batch: durable, session-aware badge logic for the
// Bridges (formerly Waitlist) nav tab. Reuses the existing sessions table
// (see lib/db.js sessions.bridges_dismissed_at) rather than a new table --
// the spec's 4 states map directly onto session lifecycle:
//   - fresh login -> NEW session row, bridges_dismissed_at NULL -> ON
//   - opening Bridges -> stamp bridges_dismissed_at = now on THIS session -> OFF
//   - 6h after that stamp (while still logged in, same session) -> ON again
//   - logout/login -> old session row is deleted (see destroySession),
//     the new session's bridges_dismissed_at is NULL -> ON immediately
//   - waitlist_joined_at set -> permanently OFF regardless of session state
const REDISPLAY_MS = 6 * 60 * 60 * 1000; // 6 hours

export function computeBridgesNotification(account, session) {
  if (account.waitlist_joined_at) {
    return { show: false };
  }
  if (!session || !session.bridges_dismissed_at) {
    return { show: true };
  }
  const dismissedMs = new Date(session.bridges_dismissed_at).getTime();
  if (!Number.isFinite(dismissedMs)) return { show: true };
  return { show: Date.now() - dismissedMs >= REDISPLAY_MS };
}

export { REDISPLAY_MS as BRIDGES_REDISPLAY_MS };
