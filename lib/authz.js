import { getDb } from "./db";

// Shared, framework-agnostic helpers used by BOTH proxy.js (edge-adjacent,
// no next/headers cookie jar) and server route handlers / server components
// (which use next/headers cookies()). Keeping the actual "is this session
// valid, is this account allowed to be logged in" logic in one place means
// proxy.js and every API route enforce identical rules.

const COOKIE_NAME = "sa_session";

// Resolves a raw session token to a full account row, enforcing:
// - session exists and is not expired (expired sessions are deleted)
// - the account exists
// - the account is not disabled (disabled accounts have all sessions
//   revoked defensively, so a stale cookie can never authenticate)
// Returns null for any failure. Never throws on bad/missing input.
export function getAccountByToken(token) {
  if (!token) return null;
  const db = getDb();

  const session = db.prepare(`SELECT * FROM sessions WHERE token = ?`).get(token);
  if (!session) return null;

  if (new Date(session.expires_at).getTime() < Date.now()) {
    db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
    return null;
  }

  const account = db
    .prepare(`SELECT * FROM accounts WHERE id = ?`)
    .get(session.account_id);

  if (!account) return null;

  if (account.account_status === "disabled") {
    // Belt-and-suspenders: a disable action should already revoke sessions,
    // but if a session somehow survives, never honor it.
    db.prepare(`DELETE FROM sessions WHERE account_id = ?`).run(account.id);
    return null;
  }

  return account;
}

// Strips password hash/salt and any other internal-only fields before an
// account row is ever sent to the client. Everything returned here is safe
// to serialize into an API response.
export function toPublicAccount(account) {
  if (!account) return null;
  return {
    id: account.id,
    email: account.email,
    name: account.name,
    firstName: account.first_name,
    lastName: account.last_name,
    role: account.role,
    accountStatus: account.account_status,
    mustChangePassword: !!account.must_change_password,
    packageTier: account.package_tier,
    currentBalanceCents: account.current_balance_cents,
    lifetimeEarningsCents: account.lifetime_earnings_cents,
    ispStatus: account.isp_status,
    ispSubmittedAt: account.isp_submitted_at,
    ispApprovedAt: account.isp_approved_at,
    userAuthorizedAt: account.user_authorized_at,
    nodeConnectedAt: account.node_connected_at,
    ispStreet: account.isp_street,
    ispCity: account.isp_city,
    ispState: account.isp_state,
    ispZip: account.isp_zip,
    ispProvider: account.isp_provider,
    waitlistStartedAt: account.waitlist_started_at,
    waitlistJoinedAt: account.waitlist_joined_at,
    firstLoginAt: account.first_login_at,
    lastLoginAt: account.last_login_at,
    createdAt: account.created_at,
    // Phase 5: WiFi on/off toggle + admin "unlock all modules" override.
    wifiEnabled: Boolean(account.wifi_enabled),
    wifiStateSince: account.wifi_state_since,
    modulesUnlocked: Boolean(account.modules_unlocked),
    // Dashboard adjustment pass: OFF->ON reconnection in-progress marker.
    // Non-null only while a 20-second reconnection is underway; the
    // client uses this to resume rendering the correct remaining
    // progress after a refresh/re-mount instead of restarting the visual
    // timer from 0% (see lib/wifiEngine.js getWifiReconnectStatus).
    wifiReconnectStartedAt: account.wifi_reconnect_started_at,
    // Deliberately omitted from every customer-facing payload:
    // password_hash, password_salt, earnings_multiplier (admin-only per
    // spec), purchase_network/external_order_id/product_id/purchased_at
    // (admin/internal only).
  };
}

export { COOKIE_NAME };
