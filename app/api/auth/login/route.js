import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { verifyPassword } from "@/lib/auth-crypto";
import { createSession } from "@/lib/session";
import { toPublicAccount } from "@/lib/authz";

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

  // login_count is still incremented for general account bookkeeping
  // (e.g. potential future features) even though the automated
  // Support check-in that used to read it has been removed -- see the
  // STOP-AUTOMATED-SUPPORT-MESSAGES comment below.
  db.prepare(
    `UPDATE accounts
     SET first_login_at = COALESCE(first_login_at, ?),
         last_login_at = ?,
         login_count = login_count + 1
     WHERE id = ?`
  ).run(now, now, account.id);

  await createSession(account.id);

  const refreshed = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(account.id);

  // STOP-AUTOMATED-SUPPORT-MESSAGES batch: this login route used to
  // schedule an automated Support welcome/check-in message here (see
  // git history) -- per spec, NO new automated Support Chat messages
  // may be created going forward, whether it's the customer's first
  // login or any later one. isFirstLogin/login_count above are still
  // used solely for the account bookkeeping unrelated to this removed
  // automation (first_login_at/last_login_at/login_count tracking is
  // still correct and untouched); nothing here posts or schedules a
  // Support message anymore. Manual customer/admin Support messages
  // (a completely separate code path, lib/supportEngine.js#postMessage)
  // are entirely unaffected.

  return NextResponse.json({ account: toPublicAccount(refreshed) });
}
