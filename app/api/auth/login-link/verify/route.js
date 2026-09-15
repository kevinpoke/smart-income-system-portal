import { NextResponse } from "next/server";
import { resolveAccountForLoginLinkToken } from "@/lib/loginLinkAccess";
import { getDb } from "@/lib/db";
import { generateId } from "@/lib/auth-crypto";
import { createSession } from "@/lib/session";
import { toPublicAccount } from "@/lib/authz";

// PASSWORDLESS-CUSTOMER-LOGIN batch: verifies a unique login-link
// token + the customer-submitted email, and on success creates a
// session via the EXISTING shared lib/session.js#createSession()
// helper -- the same one the password-based /api/auth/login route
// uses, so cookies/session expiry/role enforcement are byte-for-byte
// identical between the two login methods (spec Part 6: "reuse
// existing session creation logic").
//
// Small in-memory rate limiter mirrors the existing password login
// route's pattern (see app/api/auth/login/route.js) -- same shape,
// separate Map so a flood of email-guessing attempts against one
// login link can't also lock out the password login route or vice
// versa.
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function rateLimitKey(request, token) {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  return `${ip}:${token}`;
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

// Canonical email normalization -- deliberately the SAME trim+lowercase
// rule already applied at every other email comparison point in this
// codebase (see app/api/auth/login/route.js line `body.email.trim().
// toLowerCase()`, and app/api/webhooks/jvzoo/route.js's
// `customerEmailRaw.trim().toLowerCase()`). Not extracted into a
// shared helper module by this batch since the existing codebase
// itself has never centralized it into one -- reusing the exact same
// inline expression keeps this new path bit-for-bit consistent with
// every existing comparison rather than introducing a second,
// independent implementation that could silently drift.
function normalizeEmail(raw) {
  return (raw || "").trim().toLowerCase();
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const token = (body.token || "").trim();
  const email = normalizeEmail(body.email);

  if (!token || !email) {
    return NextResponse.json({ error: "Invalid login link or email." }, { status: 400 });
  }

  const key = rateLimitKey(request, token);
  if (isRateLimited(key)) {
    return NextResponse.json(
      { error: "Too many attempts. Please try again later." },
      { status: 429 }
    );
  }

  // Generic failure message for EVERY rejection path below -- never
  // reveal which specific check failed (malformed link, reset/old
  // link, disabled account, or wrong email all look identical to the
  // caller). Spec Part 3 + Part 5.
  const GENERIC_ERROR = "Invalid login link or email.";

  const account = resolveAccountForLoginLinkToken(token);
  if (!account) {
    recordAttempt(key);
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 404 });
  }

  if (normalizeEmail(account.email) !== email) {
    recordAttempt(key);
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
  }

  clearAttempts(key);

  const db = getDb();
  const now = new Date().toISOString();

  // Exactly the same first_login_at/last_login_at/login_count
  // bookkeeping as the password login route -- COALESCE guarantees
  // first_login_at is never reset on a repeat login (spec Part 6),
  // and module-unlock timing / Support automation (already tied to
  // first_login_at elsewhere) is unaffected by which login METHOD the
  // customer used.
  db.prepare(
    `UPDATE accounts
     SET first_login_at = COALESCE(first_login_at, ?),
         last_login_at = ?,
         login_count = login_count + 1
     WHERE id = ?`
  ).run(now, now, account.id);

  // ANALYTICS/SUPPORT/BRIDGE batch: durable per-event login record (see
  // lib/db.js login_events table comment). This is the passwordless
  // CUSTOMER login-link path -- login links are only ever minted/emailed
  // for auth_mode='login_link' customer accounts (see
  // lib/loginLinkAccess.js), never for admin accounts, so this route is
  // customer-only by construction and never records an admin login.
  // Recorded with auth_method='login_link'. No BEGIN/COMMIT wrapper is
  // added, matching this route's existing bare-statement style (no
  // pre-existing transaction to join for this one extra insert).
  db.prepare(
    `INSERT INTO login_events (id, account_id, logged_in_at, auth_method) VALUES (?, ?, ?, ?)`
  ).run(generateId("loginevt"), account.id, now, "login_link");

  await createSession(account.id);

  const refreshed = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(account.id);

  return NextResponse.json({ account: toPublicAccount(refreshed) });
}
