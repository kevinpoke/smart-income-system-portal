import { cookies } from "next/headers";
import { getDb } from "./db";
import { generateToken } from "./auth-crypto";

const COOKIE_NAME = "sa_session";
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

export async function getCurrentAccount() {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token) return null;

  const db = getDb();
  const session = db
    .prepare(`SELECT * FROM sessions WHERE token = ?`)
    .get(token);
  if (!session) return null;

  if (new Date(session.expires_at).getTime() < Date.now()) {
    db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
    return null;
  }

  const account = db
    .prepare(
      `SELECT id, email, name, must_change_password, role, created_at FROM accounts WHERE id = ?`
    )
    .get(session.account_id);

  return account || null;
}

export { COOKIE_NAME };
