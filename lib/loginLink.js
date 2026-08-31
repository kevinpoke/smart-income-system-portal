import crypto from "node:crypto";

// PASSWORDLESS-CUSTOMER-LOGIN batch: unique per-customer login link
// architecture.
//
// Link shape: /l/<accountId>.<version>.<signatureBase64Url>
//
// The signature is HMAC-SHA256(secret, `${accountId}.${version}`),
// base64url-encoded. Nothing about the link is a plaintext bearer
// token that grants access on its own -- possessing a VALID link only
// proves "this link was minted by our server for this accountId at
// this login_link_version"; the customer must ALSO submit their
// registered email (see /api/auth/login-link/verify) before a session
// is created (spec Part 5: "a valid unique link alone must NOT
// immediately create a session").
//
// Revocation: accounts.login_link_version (see lib/db.js) is a plain
// integer, defaulting to 1, incremented every time a customer's link
// must be invalidated (explicit admin "Reset Login Link", and
// automatically on every enabled->disabled transition, including the
// JVZoo refund auto-disable path -- see lib/accountDisable.js). A
// previously-signed link's version is baked into its signature, so
// once the DB's login_link_version no longer matches, the signature
// verification step below can never succeed again for that old
// version -- there is nothing to "delete", the old link is
// permanently and unconditionally dead the moment the counter moves
// past it. Re-enabling a disabled account does NOT roll the version
// back down, so an old emailed link can never come back to life.
//
// Secret: LOGIN_LINK_SECRET, a server-side-only signing secret from
// the environment (never sent to the client, never derived from
// anything guessable like the email or account id). Falls back to a
// clearly-marked local development secret ONLY when NODE_ENV !==
// "production" and the env var is absent, so `next dev`/local testing
// works out of the box without requiring every contributor to set up
// a secret first -- production deployments MUST set LOGIN_LINK_SECRET
// (see /opt/smart-income-system/config/production.env convention used
// elsewhere in this repo for real secrets) or every login link
// request fails closed (see getSigningSecret()'s production guard).
const DEV_FALLBACK_SECRET = "dev-only-insecure-login-link-secret-do-not-use-in-prod";

function getSigningSecret() {
  const secret = process.env.LOGIN_LINK_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    // Fail closed in production rather than silently signing with a
    // guessable fallback secret.
    return null;
  }
  return DEV_FALLBACK_SECRET;
}

function base64UrlEncode(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBuffer(str) {
  const normalized = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  return Buffer.from(padded, "base64");
}

function sign(accountId, version) {
  const secret = getSigningSecret();
  if (!secret) return null;
  const payload = `${accountId}.${version}`;
  const mac = crypto.createHmac("sha256", secret).update(payload).digest();
  return base64UrlEncode(mac);
}

// Builds the opaque path segment (NOT a full URL) for a customer's
// CURRENT login link, e.g. "acct_abc123.3.kQ7f...". Returns null if no
// signing secret is configured (fail closed -- see getSigningSecret()).
export function buildLoginLinkToken(accountId, loginLinkVersion) {
  const signature = sign(accountId, loginLinkVersion);
  if (!signature) return null;
  return `${accountId}.${loginLinkVersion}.${signature}`;
}

// Builds the full, absolute login link URL for a customer, using
// APP_URL (the same env var already used by the existing onboarding/
// purchase mailers for the plain /login URL) as the base.
export function buildLoginLinkUrl(accountId, loginLinkVersion) {
  const token = buildLoginLinkToken(accountId, loginLinkVersion);
  if (!token) return null;
  const base = process.env.APP_URL || "https://app.smart-income-system.com";
  return `${base.replace(/\/$/, "")}/l/${token}`;
}

// Parses and verifies a login-link token (the path segment after
// "/l/"). Returns { accountId, version } on success, or null for ANY
// failure -- malformed shape, non-numeric version, modified
// accountId/version, modified/wrong signature, or missing signing
// secret. Deliberately returns a single opaque null in every failure
// case (never a reason code) so callers can never accidentally leak
// *why* a link failed via a different error path -- the route calling
// this must render the exact same 404 regardless (spec Part 3).
export function parseLoginLinkToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [accountId, versionStr, signature] = parts;
  if (!accountId || !versionStr || !signature) return null;
  if (!/^[0-9]+$/.test(versionStr)) return null;
  const version = Number.parseInt(versionStr, 10);
  if (!Number.isFinite(version) || version < 1) return null;

  const expectedSignature = sign(accountId, version);
  if (!expectedSignature) return null;

  // Constant-time comparison. Different-length buffers never match
  // (and would throw in timingSafeEqual), so guard length first --
  // this length check leaks only the fact that the signature format
  // is wrong, not which byte differs, and is unavoidable when
  // comparing base64url strings of potentially attacker-controlled
  // length.
  const a = base64UrlToBuffer(signature);
  const b = base64UrlToBuffer(expectedSignature);
  if (a.length !== b.length || a.length === 0) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;

  return { accountId, version };
}
