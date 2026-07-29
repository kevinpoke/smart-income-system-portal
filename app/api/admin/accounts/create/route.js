import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { hashPassword, generateId } from "@/lib/auth-crypto";
import { toPublicAccount } from "@/lib/authz";
import { recomputeAndGetBalance } from "@/lib/adminLedger";

// Admin-only "Create User" action for User Management. Creates a NEW
// customer account directly (distinct from the purchase-webhook flow --
// this is an explicit admin action, not a simulated purchase).
//
// Validation (all server-side, never trusting client-side form checks
// alone):
// - firstName/lastName required, reasonable length caps
// - email normalized (trim + lowercase, matching every other email
//   touchpoint in this app -- see app/api/auth/login) and format-checked
// - duplicate email rejected with a clear error (checked via the same
//   UNIQUE(email) constraint the accounts table already enforces, so
//   even a race is still caught at the DB level)
// - password required, minimum length, hashed via the EXACT SAME
//   scrypt-based lib/auth-crypto.js hashPassword() every other account
//   creation path uses (webhook signup, etc.) -- the plaintext password
//   is never stored anywhere and is discarded from memory once hashed
// - startingBalance entered in DOLLARS, converted to integer CENTS,
//   rejected if negative
// - role is always 'customer' -- this route has no way to create an
//   admin account
// - account_status defaults to 'active' (this app's existing
//   account-creation convention -- see the webhook route, which also
//   never sets account_status explicitly and relies on the schema's
//   own DEFAULT 'active')
//
// Audit: writes one audit_log row recording the acting admin, the new
// customer's id, and the starting balance -- never the plaintext
// password.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NAME_LENGTH = 80;
const MIN_PASSWORD_LENGTH = 8;

export async function POST(request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const guard = await requireAdmin();
  if (!guard.account) {
    return NextResponse.json({ error: guard.errorMessage }, { status: guard.errorStatus });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const firstName = typeof body.firstName === "string" ? body.firstName.trim() : "";
  const lastName = typeof body.lastName === "string" ? body.lastName.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const startingBalanceRaw = body.startingBalance;

  if (!firstName) {
    return NextResponse.json({ error: "First name is required." }, { status: 400 });
  }
  if (!lastName) {
    return NextResponse.json({ error: "Last name is required." }, { status: 400 });
  }
  if (firstName.length > MAX_NAME_LENGTH || lastName.length > MAX_NAME_LENGTH) {
    return NextResponse.json({ error: "Name is too long." }, { status: 400 });
  }
  if (!email || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "A valid email address is required." }, { status: 400 });
  }
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` },
      { status: 400 }
    );
  }

  let startingBalanceCents = 0;
  if (startingBalanceRaw !== undefined && startingBalanceRaw !== null && startingBalanceRaw !== "") {
    const dollars = Number(startingBalanceRaw);
    if (!Number.isFinite(dollars)) {
      return NextResponse.json({ error: "Starting balance must be a number." }, { status: 400 });
    }
    if (dollars < 0) {
      return NextResponse.json(
        { error: "Starting balance cannot be negative." },
        { status: 400 }
      );
    }
    startingBalanceCents = Math.round(dollars * 100);
  }

  const db = getDb();
  const existing = db.prepare(`SELECT id FROM accounts WHERE email = ?`).get(email);
  if (existing) {
    return NextResponse.json(
      { error: "An account with this email already exists." },
      { status: 409 }
    );
  }

  const { hash, salt } = hashPassword(password);
  const id = generateId("acct");
  const now = new Date().toISOString();
  const fullName = `${firstName} ${lastName}`.trim();

  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO accounts
         (id, email, name, first_name, last_name, password_hash, password_salt,
          must_change_password, role, account_status, current_balance_cents, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'customer', 'active', 0, ?)`
    ).run(id, email, fullName, firstName, lastName, hash, salt, now);

    if (startingBalanceCents > 0) {
      // Route the starting balance through the ledger (never a silent
      // direct write to current_balance_cents) so it's auditable and
      // reconciles exactly like every other credit in this app -- same
      // event_type used by the existing admin balance-adjustment route.
      // current_balance_cents/lifetime_earnings_cents are then derived
      // from this ledger row via recomputeAndGetBalance() below, the
      // SAME reconciliation function every other balance-affecting route
      // uses -- never a second, independently-maintained running total
      // that could drift from the ledger.
      db.prepare(
        `INSERT INTO ledger_entries
           (id, account_id, event_type, base_amount_cents, multiplier, final_amount_cents, effective_date, created_at, source_reference, metadata_json)
         VALUES (?, ?, 'admin_credit', ?, 1.0, ?, ?, ?, ?, ?)`
      ).run(
        generateId("ledger"),
        id,
        startingBalanceCents,
        startingBalanceCents,
        now.slice(0, 10),
        now,
        `admin:create-user:${id}`,
        JSON.stringify({ reason: "Starting balance set at account creation.", adminAccountId: guard.account.id })
      );
    }

    db.prepare(
      `INSERT INTO audit_log (id, admin_account_id, target_account_id, action, before_json, after_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      generateId("audit"),
      guard.account.id,
      id,
      "create_user",
      JSON.stringify({}),
      JSON.stringify({ email, startingBalanceCents, createdAt: now }),
      now
    );

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    if (String(err?.message || "").includes("UNIQUE")) {
      return NextResponse.json(
        { error: "An account with this email already exists." },
        { status: 409 }
      );
    }
    throw err;
  }

  if (startingBalanceCents > 0) {
    recomputeAndGetBalance(db, id);
  }

  const created = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(id);
  return NextResponse.json({ ok: true, account: toPublicAccount(created) });
}
