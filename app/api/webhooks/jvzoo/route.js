import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { hashPassword, generateId } from "@/lib/auth-crypto";
import { generateSecureTempPassword } from "@/lib/tempPassword";
import { sendWelcomeEmail } from "@/lib/onboardingMailer";
import {
  JVZOO_FIELDS,
  JVZOO_TRANSACTION_TYPES,
  APPROVED_PRODUCT_IDS,
  verifyCverify,
} from "@/lib/jvzoo";

// Phase 7: dedicated, authenticated JVZoo server-to-server onboarding
// webhook (JVZIPN v2). Completely separate from the admin-only
// /api/webhooks/purchase route (which remains the manual "Simulate JVZoo
// Purchase" test action gated behind requireAdmin() -- untouched by this
// file). This route has NO session-based auth (JVZoo cannot send a
// browser cookie); instead every request is authenticated by
// recomputing JVZoo's own cverify signature against JVZOO_IPN_SECRET
// (see lib/jvzoo.js) BEFORE any database read/write happens.
//
// proxy.js already whitelists the /api/webhooks prefix as a public path
// (required, since this is a server-to-server call with no session), so
// authentication is enforced entirely inside this handler.
//
// IDEMPOTENCY: the JVZoo transaction id is the ONLY dedup key (never
// customer email). Enforced at TWO levels so a duplicate/retried
// notification can never be processed twice even under a concurrent
// race, not merely via an application-level "SELECT then act" check:
//   1. A fast pre-check SELECT (below) short-circuits the common case
//      (JVZoo's normal sequential retry) without attempting any write.
//   2. A real database UNIQUE constraint is the actual source of truth:
//      - accounts.external_order_id has a partial UNIQUE index (see
//        lib/db.js migration) covering the "new SALE creates an
//        account" path.
//      - ledger_entries already has UNIQUE(account_id, source_reference)
//        (pre-existing schema, used elsewhere in this app) covering the
//        "existing customer repeat purchase" and "refund" paths, keyed
//        on source_reference = `jvzoo:<transactionId>`.
//      Both write paths below catch a UNIQUE constraint violation and
//      treat it as "already processed" rather than raising a 500 -- so
//      two truly concurrent duplicate requests both resolve safely, and
//      only one ever wins the write.
export async function POST(request) {
  const secret = process.env.JVZOO_IPN_SECRET;
  if (!secret) {
    // Fail closed: if the secret isn't configured, we cannot verify
    // anything JVZoo sends, so reject everything rather than silently
    // trusting unverified input. Never happens in a correctly configured
    // production environment (see /opt/smart-income-system/config/production.env).
    return NextResponse.json({ error: "Not configured." }, { status: 503 });
  }

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return NextResponse.json({ error: "Unsupported content type." }, { status: 400 });
  }

  let params;
  try {
    const raw = await request.text();
    params = new URLSearchParams(raw);
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const suppliedCverify = params.get(JVZOO_FIELDS.VERIFY);
  const paykey = params.get(JVZOO_FIELDS.PAYKEY);
  const customerEmailRaw = params.get(JVZOO_FIELDS.EMAIL);
  const productName = params.get(JVZOO_FIELDS.PRODUCT_NAME);
  const productId = params.get(JVZOO_FIELDS.PRODUCT_ID);
  const transactionType = params.get(JVZOO_FIELDS.TRANSACTION_TYPE);
  const date = params.get(JVZOO_FIELDS.DATE);
  const transactionId = params.get(JVZOO_FIELDS.TRANSACTION_ID);
  const firstName = (params.get(JVZOO_FIELDS.FIRST_NAME) || "").trim();
  const lastName = (params.get(JVZOO_FIELDS.LAST_NAME) || "").trim();

  // All fields the verification formula itself depends on, plus the
  // fields needed to safely process the transaction, must be present.
  // Reject BEFORE touching the database on any missing required field --
  // an incomplete payload can never be partially processed.
  if (
    !suppliedCverify ||
    !paykey ||
    !customerEmailRaw ||
    !productName ||
    !productId ||
    !transactionType ||
    !date ||
    !transactionId
  ) {
    return NextResponse.json({ error: "Missing required fields." }, { status: 400 });
  }

  const verified = verifyCverify(
    secret,
    {
      paykey,
      customerEmail: customerEmailRaw,
      productName,
      transactionType,
      date,
    },
    suppliedCverify
  );

  if (!verified) {
    // Reject BEFORE any database modification. Never reveal which part
    // of the check failed.
    return NextResponse.json({ error: "Verification failed." }, { status: 403 });
  }

  // Only the approved Smart Income System front-end product provisions
  // base access. Any other product ID is verified-but-irrelevant to us
  // (e.g. an unrelated JVZoo product using the same seller account) --
  // acknowledge receipt without provisioning anything.
  if (!APPROVED_PRODUCT_IDS.has(String(productId))) {
    return NextResponse.json({ ok: true, processed: false, reason: "Product not approved for provisioning." });
  }

  const email = customerEmailRaw.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "Invalid customer email." }, { status: 400 });
  }

  const db = getDb();
  const sourceReference = `jvzoo:${transactionId}`;

  // Fast pre-check (not the sole idempotency guarantee -- see UNIQUE
  // constraints used below on the actual write paths).
  const existingByOrderId = db
    .prepare(`SELECT id FROM accounts WHERE external_order_id = ?`)
    .get(transactionId);
  const existingLedgerRecord = db
    .prepare(`SELECT id FROM ledger_entries WHERE source_reference = ?`)
    .get(sourceReference);
  if (existingByOrderId || existingLedgerRecord) {
    return NextResponse.json({ ok: true, processed: false, reason: "Transaction already processed." });
  }

  if (transactionType === JVZOO_TRANSACTION_TYPES.RFND) {
    return handleRefund({ db, email, transactionId, sourceReference, productId, date });
  }

  if (
    transactionType !== JVZOO_TRANSACTION_TYPES.SALE &&
    transactionType !== JVZOO_TRANSACTION_TYPES.BILL
  ) {
    // Unrecognized transaction type -- verified authentic, but we don't
    // know how to safely act on it. Acknowledge without provisioning.
    return NextResponse.json({ ok: true, processed: false, reason: "Unhandled transaction type." });
  }

  const existingAccount = db.prepare(`SELECT id FROM accounts WHERE email = ?`).get(email);

  if (existingAccount) {
    // Existing Smart Income System customer buying again (SALE) or a
    // BILL rebill event for an already-provisioned account. Per spec:
    // never reset password, progress, first_login_at, Bridges, earnings,
    // or modules. Safely record this new transaction as an audit-trail
    // ledger row (zero-amount 'correction' entry -- never touches
    // current_balance_cents) rather than overwriting the account's
    // single external_order_id/purchased_at slot, which remains the
    // record of the customer's ORIGINAL qualifying purchase.
    return recordRepeatPurchase({ db, account: existingAccount, sourceReference, transactionType, productId, transactionId });
  }

  if (transactionType === JVZOO_TRANSACTION_TYPES.BILL) {
    // A BILL (rebill) notification for an email with no existing Smart
    // Income System account. We do not have enough context to safely
    // originate a brand-new account from a rebill event alone (rebills
    // are follow-on billing for an ALREADY-provisioned purchase) --
    // acknowledge without provisioning rather than guessing.
    return NextResponse.json({ ok: true, processed: false, reason: "BILL for unknown account -- no action taken." });
  }

  // New qualifying SALE buyer: provision a base account exactly like the
  // existing manual/admin creation flow (same hashing implementation,
  // same default role/status), then attempt the welcome email.
  return createNewCustomer({ db, email, firstName, lastName, transactionId, productId, date });
}

function createNewCustomer({ db, email, firstName, lastName, transactionId, productId, date }) {
  const tempPassword = generateSecureTempPassword();
  const { hash, salt } = hashPassword(tempPassword);
  const id = generateId("acct");
  const now = new Date().toISOString();
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim() || null;

  try {
    db.prepare(
      `INSERT INTO accounts
         (id, email, name, first_name, last_name, password_hash, password_salt,
          must_change_password, role, account_status, created_at,
          purchase_network, external_order_id, product_id, purchased_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'customer', 'active', ?, 'jvzoo', ?, ?, ?)`
    ).run(
      id,
      email,
      fullName,
      firstName || null,
      lastName || null,
      hash,
      salt,
      now,
      transactionId,
      String(productId),
      date
    );
  } catch (err) {
    if (String(err?.message || "").includes("UNIQUE")) {
      // Lost a race against a concurrent duplicate delivery of the exact
      // same transaction (external_order_id) or the exact same email
      // (accounts.email UNIQUE) -- either way, treat as already handled
      // rather than creating a second account or erroring.
      return NextResponse.json({ ok: true, processed: false, reason: "Transaction already processed." });
    }
    throw err;
  }

  // first_login_at is intentionally left NULL here -- it is only ever
  // set by the real login route on the customer's actual first
  // successful login (unchanged, pre-existing behavior).

  // tempPassword exists only in this function's local scope: hashed
  // immediately above, then handed to the mailer below, then goes out of
  // scope when this function returns. It is never stored, logged, or
  // returned to JVZoo -- see lib/onboardingMailer.js and
  // lib/tempPassword.js.
  return sendWelcomeEmail({ to: email, tempPassword }).then((mailResult) =>
    NextResponse.json({
      ok: true,
      processed: true,
      created: true,
      emailDelivered: mailResult.delivered,
    })
  );
}

function recordRepeatPurchase({ db, account, sourceReference, transactionType, productId, transactionId }) {
  try {
    db.prepare(
      `INSERT INTO ledger_entries
         (id, account_id, event_type, base_amount_cents, multiplier, final_amount_cents, effective_date, created_at, source_reference, metadata_json)
       VALUES (?, ?, 'correction', 0, 1.0, 0, ?, ?, ?, ?)`
    ).run(
      generateId("ledger"),
      account.id,
      new Date().toISOString().slice(0, 10),
      new Date().toISOString(),
      sourceReference,
      JSON.stringify({
        reason: "JVZoo repeat purchase/rebill recorded for existing account (no account changes made).",
        transactionType,
        productId,
        jvzooTransactionId: transactionId,
      })
    );
  } catch (err) {
    if (String(err?.message || "").includes("UNIQUE")) {
      return NextResponse.json({ ok: true, processed: false, reason: "Transaction already processed." });
    }
    throw err;
  }
  // Per spec: do NOT send a new temporary-password email to an existing
  // customer.
  return NextResponse.json({ ok: true, processed: true, created: false });
}

function handleRefund({ db, email, transactionId, sourceReference, productId, date }) {
  // Verified refund/chargeback: disable access and revoke sessions, but
  // NEVER delete the account or any historical record (earnings,
  // ledger, module progress, etc. all remain intact for audit).
  const account = db.prepare(`SELECT id, account_status FROM accounts WHERE email = ?`).get(email);

  if (!account) {
    // Refund notification for an email with no matching account (e.g. a
    // typo'd email at purchase time, or a product we never provisioned
    // for). Nothing to disable; acknowledge without action.
    return NextResponse.json({ ok: true, processed: false, reason: "No matching account for refund." });
  }

  try {
    db.exec("BEGIN");
    db.prepare(`UPDATE accounts SET account_status = 'disabled' WHERE id = ?`).run(account.id);
    db.prepare(`DELETE FROM sessions WHERE account_id = ?`).run(account.id);
    db.prepare(
      `INSERT INTO ledger_entries
         (id, account_id, event_type, base_amount_cents, multiplier, final_amount_cents, effective_date, created_at, source_reference, metadata_json)
       VALUES (?, ?, 'correction', 0, 1.0, 0, ?, ?, ?, ?)`
    ).run(
      generateId("ledger"),
      account.id,
      new Date().toISOString().slice(0, 10),
      new Date().toISOString(),
      sourceReference,
      JSON.stringify({
        reason: "Account disabled due to verified JVZoo refund/chargeback.",
        productId,
        jvzooTransactionId: transactionId,
        refundDate: date,
      })
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    if (String(err?.message || "").includes("UNIQUE")) {
      return NextResponse.json({ ok: true, processed: false, reason: "Transaction already processed." });
    }
    throw err;
  }

  return NextResponse.json({ ok: true, processed: true, disabled: true });
}
