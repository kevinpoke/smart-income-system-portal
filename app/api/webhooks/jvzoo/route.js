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
// IDEMPOTENCY -- SALE / BILL: the JVZoo transaction id is the ONLY dedup
// key (never customer email). Enforced at TWO levels so a duplicate/
// retried notification can never be processed twice even under a
// concurrent race, not merely via an application-level "SELECT then
// act" check:
//   1. A fast pre-check SELECT (below) short-circuits the common case
//      (JVZoo's normal sequential retry) without attempting any write.
//   2. A real database UNIQUE constraint is the actual source of truth:
//      - accounts.external_order_id has a partial UNIQUE index (see
//        lib/db.js migration) covering the "new SALE creates an
//        account" path.
//      - ledger_entries already has UNIQUE(account_id, source_reference)
//        (pre-existing schema, used elsewhere in this app) covering the
//        "existing customer repeat purchase" path, keyed on
//        source_reference = `jvzoo:<transactionId>`.
//
// IDEMPOTENCY -- REFUND (RFND): deliberately handled OUTSIDE that same
// SALE/BILL pre-check (see the branch below). A verified refund's own
// transaction_id is EXPECTED to already be on file -- for an
// original-SALE refund it is the exact same transaction_id that
// currently sits in accounts.external_order_id (JVZoo's refund
// notification for a purchase reuses that purchase's own transaction
// id -- it does not mint a new one), and for a rebill refund it is the
// same transaction_id already recorded via recordRepeatPurchase()'s
// ledger row. Running the SALE/BILL pre-check against a refund's
// transaction_id would therefore ALWAYS find a pre-existing match and
// incorrectly short-circuit every refund as "already processed" before
// it could ever disable anything -- so refunds get their own dedicated
// idempotency key/namespace (source_reference =
// `jvzoo:refund:<transactionId>`, still backed by the same
// UNIQUE(account_id, source_reference) constraint) instead of reusing
// the SALE/BILL one. See handleRefund() below for the full match +
// dedup logic.
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
  // acknowledge receipt without provisioning anything. This also covers
  // "wrong product refund must never disable a base account", since a
  // refund for an unapproved product id never reaches handleRefund().
  if (!APPROVED_PRODUCT_IDS.has(String(productId))) {
    return NextResponse.json({ ok: true, processed: false, reason: "Product not approved for provisioning." });
  }

  const email = customerEmailRaw.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "Invalid customer email." }, { status: 400 });
  }

  const db = getDb();

  // REFUND: dedicated branch, dedicated idempotency namespace (see the
  // long comment above this function) -- deliberately NOT run through
  // the SALE/BILL pre-check below, since a refund's transaction_id is
  // EXPECTED to already exist on file (that's exactly how it is
  // matched to the original purchase).
  if (transactionType === JVZOO_TRANSACTION_TYPES.RFND) {
    return handleRefund({ db, email, transactionId, productId, date });
  }

  const sourceReference = `jvzoo:${transactionId}`;

  // Fast pre-check (not the sole idempotency guarantee -- see UNIQUE
  // constraints used below on the actual write paths). Only meaningful
  // for SALE/BILL, never for RFND (handled above).
  const existingByOrderId = db
    .prepare(`SELECT id FROM accounts WHERE external_order_id = ?`)
    .get(transactionId);
  const existingLedgerRecord = db
    .prepare(`SELECT id FROM ledger_entries WHERE source_reference = ?`)
    .get(sourceReference);
  if (existingByOrderId || existingLedgerRecord) {
    return NextResponse.json({ ok: true, processed: false, reason: "Transaction already processed." });
  }

  if (
    transactionType !== JVZOO_TRANSACTION_TYPES.SALE &&
    transactionType !== JVZOO_TRANSACTION_TYPES.BILL
  ) {
    // Unrecognized transaction type -- verified authentic, but we don't
    // know how to safely act on it. Acknowledge without provisioning.
    return NextResponse.json({ ok: true, processed: false, reason: "Unhandled transaction type." });
  }

  const existingAccount = db.prepare(`SELECT id, account_status FROM accounts WHERE email = ?`).get(email);

  if (existingAccount) {
    // Existing Smart Income System customer buying again (SALE) or a
    // BILL rebill event for an already-provisioned account. Per spec:
    // never reset password, progress, first_login_at, Bridges, earnings,
    // or modules. Safely record this new transaction as an audit-trail
    // ledger row (zero-amount 'correction' entry -- never touches
    // current_balance_cents) rather than overwriting the account's
    // single external_order_id/purchased_at slot, which remains the
    // record of the customer's ORIGINAL qualifying purchase.
    //
    // SALE REPLAY SAFETY: a stale/replayed SALE (or a genuinely new
    // repurchase) for an email whose account is currently
    // refund-disabled must NEVER silently re-enable it -- account_status
    // is never touched by this path, only ledger_entries gets a new
    // audit-trail row. Reactivating a refund-disabled account is
    // deliberately NOT something any webhook event can do automatically
    // (a real "customer repurchased after a refund" business rule, if
    // ever wanted, would need its own explicit, separately-approved
    // decision -- out of scope here per spec: "do not infer
    // reactivation from an old/replayed sale event").
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

// ---- Refund handling -------------------------------------------------
//
// AUTHORITATIVE MATCHING RULE (confirmed by the user; do not change
// without a fresh explicit confirmation):
//
//   A verified refund disables the customer's account ONLY when its
//   transaction_id matches the account's ORIGINAL qualifying SALE, i.e.
//   accounts.external_order_id === refund transaction_id. That column is
//   populated exactly once, at account creation, directly from the
//   original SALE's own transaction_id (see createNewCustomer() above) --
//   it is never overwritten by a later BILL/repeat purchase (see
//   recordRepeatPurchase(), which only ever inserts a ledger row and
//   never touches accounts.external_order_id). So
//   "refund transaction_id == accounts.external_order_id" is exactly and
//   only true for a refund of the original access-granting purchase.
//
//   A refund whose transaction_id instead matches a PRIOR
//   ledger_entries row written by recordRepeatPurchase() (source_reference
//   = `jvzoo:<transactionId>`, i.e. a BILL/rebill/repeat-purchase
//   transaction that is NOT the original SALE) is a refund of that later
//   transaction, not of the base access-granting purchase -- per the
//   user's explicit confirmation, this is recorded/audited but must NOT
//   disable the account (we cannot safely infer that refunding one
//   installment/rebill means the customer's base access should be
//   revoked).
//
//   A refund transaction_id matching neither is "unknown transaction" --
//   acknowledged without touching any account. Email is NEVER used to
//   decide disablement; it is not even read in this function.
//
// This is the fix for the previously email-only-matching handleRefund()
// (see git history) -- that version disabled an account purely from
// `WHERE email = ?`, which could disable the wrong account, disable on
// an unrelated/upsell transaction sharing the same email, and could not
// distinguish an original-sale refund from a rebill refund at all.
function handleRefund({ db, email, transactionId, productId, date }) {
  const refundSourceReference = `jvzoo:refund:${transactionId}`;

  // 1. Strongest possible linkage: does this transaction_id match an
  // account's ORIGINAL qualifying SALE?
  const originalSaleAccount = db
    .prepare(`SELECT id, account_status FROM accounts WHERE external_order_id = ?`)
    .get(transactionId);

  if (originalSaleAccount) {
    return disableForOriginalSaleRefund({
      db,
      account: originalSaleAccount,
      transactionId,
      productId,
      date,
      refundSourceReference,
    });
  }

  // 2. Does this transaction_id match a previously recorded BILL/repeat
  // purchase ledger row for some account? (Written only by
  // recordRepeatPurchase() above, keyed by the exact same
  // `jvzoo:<transactionId>` source_reference used at repeat-purchase
  // time.) If so, this is a refund of a later transaction, not the
  // original access-granting purchase -- record only, never disable.
  const repeatPurchaseLedgerRow = db
    .prepare(`SELECT account_id FROM ledger_entries WHERE source_reference = ?`)
    .get(`jvzoo:${transactionId}`);

  if (repeatPurchaseLedgerRow) {
    return recordNonDisablingRefund({
      db,
      accountId: repeatPurchaseLedgerRow.account_id,
      transactionId,
      productId,
      date,
      refundSourceReference,
      reason:
        "Verified refund matched a prior BILL/rebill/repeat-purchase transaction, not the account's original qualifying SALE. Per policy, only a refund of the original SALE disables account access -- base access preserved.",
    });
  }

  // 3. Unknown transaction (never seen before as either a SALE or a
  // BILL) -- verified authentic, but there is nothing on file to link
  // it to any account. Never fall back to matching by email here.
  return NextResponse.json({
    ok: true,
    processed: false,
    reason: "No account matches this refund transaction.",
  });
}

function disableForOriginalSaleRefund({ db, account, transactionId, productId, date, refundSourceReference }) {
  // Idempotency (this exact refund notification, replayed): a real
  // UNIQUE(account_id, source_reference) constraint on ledger_entries is
  // the source of truth -- the pre-check below is just the fast common
  // path, exactly mirroring the SALE/BILL pattern elsewhere in this
  // file. If the account is already disabled with this refund's ledger
  // row present, return a safe success without mutating anything again.
  const alreadyProcessed = db
    .prepare(`SELECT id FROM ledger_entries WHERE account_id = ? AND source_reference = ?`)
    .get(account.id, refundSourceReference);
  if (alreadyProcessed) {
    return NextResponse.json({ ok: true, processed: false, reason: "Transaction already processed." });
  }

  const previousStatus = account.account_status;
  const now = new Date().toISOString();

  // Already disabled by some other path (e.g. a manual admin disable) --
  // still record the refund event (so the audit trail is complete and a
  // duplicate refund replay is caught above), but there is no
  // status transition to make and no additional session revocation
  // needed (disabled accounts already have zero sessions -- see
  // lib/authz.js getAccountByToken()).
  const nextStatus = "disabled";

  try {
    db.exec("BEGIN");
    if (previousStatus !== "disabled") {
      db.prepare(`UPDATE accounts SET account_status = 'disabled' WHERE id = ?`).run(account.id);
      // Reuse the EXACT canonical disabled-account behavior manual admin
      // disable uses (see app/api/admin/accounts/[id]/disable/route.js):
      // revoke every existing session immediately. lib/authz.js
      // getAccountByToken() is the same belt-and-suspenders backstop
      // both paths share, so a stale session can never be honored
      // either way.
      db.prepare(`DELETE FROM sessions WHERE account_id = ?`).run(account.id);
    }
    db.prepare(
      `INSERT INTO ledger_entries
         (id, account_id, event_type, base_amount_cents, multiplier, final_amount_cents, effective_date, created_at, source_reference, metadata_json)
       VALUES (?, ?, 'correction', 0, 1.0, 0, ?, ?, ?, ?)`
    ).run(
      generateId("ledger"),
      account.id,
      now.slice(0, 10),
      now,
      refundSourceReference,
      JSON.stringify({
        reason: "Account disabled due to verified JVZoo refund of the original qualifying SALE.",
        productId,
        jvzooTransactionId: transactionId,
        refundDate: date,
      })
    );
    db.prepare(
      `INSERT INTO audit_log (id, admin_account_id, target_account_id, action, before_json, after_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      generateId("audit"),
      "system",
      account.id,
      "jvzoo_refund_account_disabled",
      JSON.stringify({ accountStatus: previousStatus }),
      JSON.stringify({
        accountStatus: nextStatus,
        accountId: account.id,
        productId: String(productId),
        jvzooTransactionId: transactionId,
        processedAt: now,
      }),
      now
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

function recordNonDisablingRefund({ db, accountId, transactionId, productId, date, refundSourceReference, reason }) {
  const alreadyProcessed = db
    .prepare(`SELECT id FROM ledger_entries WHERE account_id = ? AND source_reference = ?`)
    .get(accountId, refundSourceReference);
  if (alreadyProcessed) {
    return NextResponse.json({ ok: true, processed: false, reason: "Transaction already processed." });
  }

  const now = new Date().toISOString();
  try {
    db.exec("BEGIN");
    db.prepare(
      `INSERT INTO ledger_entries
         (id, account_id, event_type, base_amount_cents, multiplier, final_amount_cents, effective_date, created_at, source_reference, metadata_json)
       VALUES (?, ?, 'correction', 0, 1.0, 0, ?, ?, ?, ?)`
    ).run(
      generateId("ledger"),
      accountId,
      now.slice(0, 10),
      now,
      refundSourceReference,
      JSON.stringify({
        reason,
        productId,
        jvzooTransactionId: transactionId,
        refundDate: date,
      })
    );
    db.prepare(
      `INSERT INTO audit_log (id, admin_account_id, target_account_id, action, before_json, after_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      generateId("audit"),
      "system",
      accountId,
      "jvzoo_refund_recorded",
      JSON.stringify({}),
      JSON.stringify({
        accountId,
        productId: String(productId),
        jvzooTransactionId: transactionId,
        processedAt: now,
        disabled: false,
        reason,
      }),
      now
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    if (String(err?.message || "").includes("UNIQUE")) {
      return NextResponse.json({ ok: true, processed: false, reason: "Transaction already processed." });
    }
    throw err;
  }

  return NextResponse.json({ ok: true, processed: true, disabled: false });
}
