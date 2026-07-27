import { cookies } from "next/headers";
import { getDb } from "./db";
import { generateToken } from "./auth-crypto";
import { getAccountByToken, toPublicAccount, COOKIE_NAME } from "./authz";

const SESSION_DAYS = 30;

export async function createSession(accountId) {
  const db = getDb();
  const token = generateToken();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400000);

  db.prepare(
    `INSERT INTO sessions (token, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)`
  ).run(token, accountId, now.toISOString(), expires.toISOString());

  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires,
  });

  return token;
}

export async function destroySession() {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (token) {
    const db = getDb();
    db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
  }
  cookieStore.delete(COOKIE_NAME);
}

// Returns the full raw account row (including internal fields) for the
// current request, or null if unauthenticated / session invalid / account
// disabled. Route handlers that need internal fields (e.g. to check
// must_change_password or re-hash a password) should use this; anything
// destined for a client response must go through toPublicAccount() first.
export async function getCurrentAccountRaw() {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  return getAccountByToken(token);
}

// Back-compat helper used by existing code: returns the same "safe" shape
// the original /api/auth/me route exposed (id, email, name,
// mustChangePassword, role), now sourced from the shared authz helper so
// disabled-account/expired-session handling is centralized.
export async function getCurrentAccount() {
  const account = await getCurrentAccountRaw();
  if (!account) return null;
  return {
    id: account.id,
    email: account.email,
    name: account.name,
    must_change_password: account.must_change_password,
    role: account.role,
    created_at: account.created_at,
  };
}

// ---- Route-handler guards -------------------------------------------------
// Use these at the top of every server-side API route that requires auth.
// They return { account } on success, or { error: NextResponse } that the
// caller should `return` immediately.

export async function requireAccount() {
  const account = await getCurrentAccountRaw();
  if (!account) {
    return { account: null, errorStatus: 401, errorMessage: "Not signed in." };
  }
  return { account };
}

export async function requireAdmin() {
  const account = await getCurrentAccountRaw();
  if (!account) {
    return { account: null, errorStatus: 401, errorMessage: "Not signed in." };
  }
  if (account.role !== "admin") {
    return { account: null, errorStatus: 403, errorMessage: "Forbidden." };
  }
  return { account };
}

export { toPublicAccount, COOKIE_NAME };
