import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { verifyPassword } from "@/lib/auth-crypto";
import { createSession } from "@/lib/session";
import { toPublicAccount } from "@/lib/authz";
import {
  scheduleMessage,
  selectLoginCheckinMessage,
  FIRST_LOGIN_WELCOME_MESSAGE,
  LOGIN_CHECKIN_MESSAGES,
} from "@/lib/supportAutomation";

// Very small in-memory rate limiter for login attempts, keyed by
// email+IP. This is intentionally simple (no external store) since the app
// runs as a single Node process; it resets on restart, which is acceptable
// for a basic brute-force throttle rather than a hard security boundary.
const attempts = new Map(); // key -> { count, firstAttemptAt }
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 10;

function rateLimitKey(request, email) {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  return `${ip}:${email}`;
}

function isRateLimited(key) {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry) return false;
  if (now - entry.firstAttemptAt > WINDOW_MS) {
    attempts.delete(key);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function recordAttempt(key) {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now - entry.firstAttemptAt > WINDOW_MS) {
    attempts.set(key, { count: 1, firstAttemptAt: now });
  } else {
    entry.count += 1;
  }
}

function clearAttempts(key) {
  attempts.delete(key);
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";

  if (!email || !password) {
    return NextResponse.json(
      { error: "Email and password are required." },
      { status: 400 }
    );
  }

  const key = rateLimitKey(request, email);
  if (isRateLimited(key)) {
    return NextResponse.json(
      { error: "Too many login attempts. Please try again later." },
      { status: 429 }
    );
  }

  const db = getDb();
  const account = db.prepare(`SELECT * FROM accounts WHERE email = ?`).get(email);

  if (!account || !verifyPassword(password, account.password_hash, account.password_salt)) {
    recordAttempt(key);
    return NextResponse.json(
      { error: "Invalid email or password." },
      { status: 401 }
    );
  }

  // Generic, non-revealing message for disabled accounts -- do not disclose
  // internal reasons for the disablement.
  if (account.account_status === "disabled") {
    recordAttempt(key);
    return NextResponse.json(
      { error: "This account is not available. Please contact support." },
      { status: 403 }
    );
  }

  clearAttempts(key);

  const now = new Date().toISOString();
  const isFirstLogin = !account.first_login_at;

  // Production feature/fix batch: increment login_count atomically in
  // the SAME update that records the login, so two concurrent login
  // requests for this account (e.g. two browser tabs) each observe a
  // DIFFERENT resulting count and therefore derive different, unique
  // support:login:<accountId>:<n> event keys below -- only one of them
  // can ever win the scheduleMessage() UNIQUE-constraint race per count
  // value, which is exactly what prevents a double-login-check-in.
  // Set first_login_at only if null; always update last_login_at.
  db.prepare(
    `UPDATE accounts
     SET first_login_at = COALESCE(first_login_at, ?),
         last_login_at = ?,
         login_count = login_count + 1
     WHERE id = ?`
  ).run(now, now, account.id);

  await createSession(account.id);

  const refreshed = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(account.id);

  // Production feature/fix batch: schedule automated Support messages
  // for THIS genuine login event only -- never on refresh, never on an
  // unrelated API call, since this code path only runs on a successful
  // password verification above. Per spec:
  //   - FIRST login ever: schedule the welcome message at +20s, and
  //     explicitly do NOT also schedule the generic +15s check-in on
  //     that same first login (avoids two automated messages arriving
  //     within 5 seconds of each other).
  //   - every login from the SECOND onward: schedule a rotated generic
  //     check-in at +15s instead.
  // Both are idempotent via scheduleMessage()'s UNIQUE(event_key) guard:
  // event_key is keyed to first-login (once ever, per account) or to
  // this exact login_count value (once per genuine login), so refreshing
  // this response, retrying the request, or a container restart between
  // scheduling and delivery can never produce a duplicate message.
  if (isFirstLogin) {
    scheduleMessage(db, {
      accountId: refreshed.id,
      eventKey: `support:first-login:${refreshed.id}`,
      body: FIRST_LOGIN_WELCOME_MESSAGE,
      deliverAt: new Date(Date.now() + 20000),
    });
  } else {
    const loginCount = refreshed.login_count;
    const lastCheckinRow = db
      .prepare(
        `SELECT body FROM scheduled_support_messages
         WHERE account_id = ? AND body IN (${LOGIN_CHECKIN_MESSAGES.map(() => "?").join(",")})
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(refreshed.id, ...LOGIN_CHECKIN_MESSAGES);
    const body = selectLoginCheckinMessage(loginCount, lastCheckinRow?.body || null);
    scheduleMessage(db, {
      accountId: refreshed.id,
      eventKey: `support:login:${refreshed.id}:${loginCount}`,
      body,
      deliverAt: new Date(Date.now() + 15000),
    });
  }

  return NextResponse.json({ account: toPublicAccount(refreshed) });
}
