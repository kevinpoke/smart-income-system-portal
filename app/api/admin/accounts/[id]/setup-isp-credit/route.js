import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { generateId } from "@/lib/auth-crypto";
import {
  adminInitializeIspSetup,
  transitionIspToApproved,
  completeIspAuthorization,
} from "@/lib/ispEngine";
import { recomputeAndGetBalance } from "@/lib/adminLedger";

// ADMIN-ONE-CLICK-ISP-CREDIT batch (spec sections M-U): one-click admin
// action ("Setup ISP + $71.28") that drives a customer's ISP all the way
// to `active` (reusing the SAME authoritative ISP state-machine helpers
// every other ISP code path in this app uses -- lib/ispEngine.js
// adminInitializeIspSetup/transitionIspToApproved/
// completeIspAuthorization, never a direct/duplicate field UPDATE) and
// credits their account exactly $71.28 (7128 cents) using the SAME
// ledger_entries + audit_log write shape as the existing admin Add
// Balance route (app/api/admin/accounts/[id]/balance) -- never a direct
// current_balance_cents/lifetime_earnings_cents write.
//
// EXACT $71.28 CREDIT AMOUNT (spec section P) -- fixed, never derived
// from request input (there is no amount field in the request body at
// all, unlike the general Add Balance route).
const CREDIT_AMOUNT_CENTS = 7128;

// IDEMPOTENCY (spec sections Q/U#5/U#6): the credit for THIS exact
// action must be applied at most ONCE per customer, EVER, even under a
// double-click, a network retry, or a duplicate concurrent request.
// Reuses ledger_entries' EXISTING UNIQUE(account_id, source_reference)
// constraint (see lib/db.js) as the real, unbypassable durable guard --
// exactly the same idempotency mechanism lib/supportAutomation.js's
// scheduleMessage() uses for event_key, just against a different table.
// `source_reference` is a FIXED, deterministic string per account (not
// per-request/per-attempt), so a second attempt's INSERT collides on the
// UNIQUE constraint and is caught below rather than ever creating a
// second ledger row.
function setupIspCreditSourceReference(accountId) {
  return `admin_setup_isp_credit:${accountId}`;
}

// Returns true if the $71.28 credit for this action has ALREADY been
// applied to this account (checked before attempting to insert again --
// this is a fast-path check; the UNIQUE constraint below is the actual
// unbypassable guard against a race between this check and the insert).
function creditAlreadyApplied(db, accountId) {
  const row = db
    .prepare(`SELECT id FROM ledger_entries WHERE account_id = ? AND source_reference = ?`)
    .get(accountId, setupIspCreditSourceReference(accountId));
  return Boolean(row);
}

// Applies the exactly-once $71.28 credit. Returns { applied: true } on a
// genuinely new credit, or { applied: false, reason: "already_applied" }
// if the UNIQUE constraint caught a duplicate (belt-and-suspenders with
// the pre-check above -- covers a race between two concurrent requests
// that both passed the pre-check before either had inserted).
function applyIspCreditOnce(db, { accountId, adminAccountId }) {
  if (creditAlreadyApplied(db, accountId)) {
    return { applied: false, reason: "already_applied" };
  }

  const now = new Date().toISOString();
  const ledgerId = generateId("ledger");

  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO ledger_entries
         (id, account_id, event_type, base_amount_cents, multiplier, final_amount_cents, effective_date, created_at, source_reference, metadata_json)
       VALUES (?, ?, 'admin_credit', ?, 1.0, ?, ?, ?, ?, ?)`
    ).run(
      ledgerId,
      accountId,
      CREDIT_AMOUNT_CENTS,
      CREDIT_AMOUNT_CENTS,
      now.slice(0, 10),
      now,
      setupIspCreditSourceReference(accountId),
      JSON.stringify({ reason: "Admin one-click Setup ISP + $71.28", adminAccountId })
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    if (String(err?.message || "").includes("UNIQUE")) {
      // Lost a race against a concurrent duplicate request -- the other
      // request's insert won; this one is a safe, expected no-op.
      return { applied: false, reason: "already_applied" };
    }
    throw err;
  }

  return { applied: true, ledgerId };
}

// Drives the account's ISP state all the way to `active`, reusing the
// existing canonical helpers for whichever stage it is currently at
// (spec section O). Returns the fresh account row once active (or
// throws if activation genuinely could not be completed, which should
// not happen for any of the four documented starting stages).
function driveIspToActive(db, accountId, { adminAccountId } = {}) {
  let account = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(accountId);

  if (account.isp_status === "not_started") {
    adminInitializeIspSetup(db, accountId);
    account = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(accountId);
  }

  if (account.isp_status === "pending_review") {
    const result = transitionIspToApproved(db, accountId, { approvedBy: adminAccountId || "system" });
    account = result.transitioned ? result.account : db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(accountId);
  }

  if (account.isp_status === "approved_awaiting_user") {
    // Same backdating trick app/api/admin/isp/[id]/confirm already uses
    // to satisfy completeIspAuthorization()'s server-verified-elapsed-
    // time precondition without reproducing its logic -- see that
    // route's own comment for the full rationale.
    if (!account.isp_authorize_started_at) {
      const backdated = new Date(Date.now() - 60_000).toISOString();
      db.prepare(`UPDATE accounts SET isp_authorize_started_at = ? WHERE id = ?`).run(backdated, accountId);
    }
    const result = completeIspAuthorization(db, accountId, { source: "admin" });
    if (result.ok) {
      account = result.account || db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(accountId);
    } else {
      account = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(accountId);
    }
  }

  return account;
}

export async function POST(request, { params }) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const guard = await requireAdmin();
  if (!guard.account) {
    return NextResponse.json({ error: guard.errorMessage }, { status: guard.errorStatus });
  }

  const { id: targetId } = await params;
  const db = getDb();
  const before = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(targetId);
  if (!before) {
    return NextResponse.json({ error: "Account not found." }, { status: 404 });
  }
  if (before.role !== "customer") {
    return NextResponse.json(
      { error: "This action only applies to customer accounts." },
      { status: 400 }
    );
  }

  const beforeIspStatus = before.isp_status;

  // TRANSACTION-SAFETY NOTE (spec section S -- see also final report item
  // 49): this deliberately does NOT wrap the ISP state-machine helpers
  // (adminInitializeIspSetup/transitionIspToApproved/
  // completeIspAuthorization) and the ledger credit in ONE outer SQL
  // transaction. Each of those existing canonical helpers already opens
  // and commits its OWN db.exec("BEGIN")/COMMIT internally (see
  // lib/ispEngine.js), and this app's `node:sqlite` DatabaseSync has no
  // nested-transaction/savepoint support -- calling db.exec("BEGIN")
  // while one of those is already open throws "cannot start a
  // transaction within a transaction" (documented precedent: see
  // lib/supportEngine.js's postMessageInner()/postMessage() split for
  // the exact same constraint). Wrapping all of this in one true atomic
  // transaction would require refactoring every one of those shared,
  // production ISP helpers to stop managing their own transactions --
  // exactly the "dangerous refactor of a shared engine" this batch's
  // ambiguity-handling rule says to avoid. Instead, safety is achieved
  // via INDEPENDENT IDEMPOTENCY of every step: each ISP transition is
  // itself idempotent/no-op-safe (see each helper's own comments), and
  // the $71.28 credit is idempotent via ledger_entries'
  // UNIQUE(account_id, source_reference) constraint (see
  // applyIspCreditOnce above). If the process crashes between the ISP
  // activation and the credit, the account is left ISP-active with no
  // credit yet applied -- NOT corrupted or half-written -- and the next
  // click (or a retry) safely completes exactly the missing piece with
  // zero risk of double-crediting or re-running a transition that
  // already happened. This is flagged explicitly in the final report
  // rather than silently claimed as fully atomic.
  const account = driveIspToActive(db, targetId, { adminAccountId: guard.account.id });

  if (account.isp_status !== "active") {
    return NextResponse.json(
      { error: "Unable to activate this customer's ISP setup from its current state." },
      { status: 409 }
    );
  }

  const creditResult = applyIspCreditOnce(db, { accountId: targetId, adminAccountId: guard.account.id });
  const newBalanceCents = recomputeAndGetBalance(db, targetId);

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO audit_log (id, admin_account_id, target_account_id, action, before_json, after_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    generateId("audit"),
    guard.account.id,
    targetId,
    "admin_setup_isp_credit",
    JSON.stringify({ ispStatus: beforeIspStatus }),
    JSON.stringify({
      ispStatus: account.isp_status,
      creditAmountCents: CREDIT_AMOUNT_CENTS,
      creditNewlyApplied: creditResult.applied,
      currentBalanceCents: newBalanceCents,
    }),
    now
  );

  const updated = db
    .prepare(`SELECT id, email, name, isp_status, current_balance_cents, lifetime_earnings_cents FROM accounts WHERE id = ?`)
    .get(targetId);

  return NextResponse.json({
    ok: true,
    account: {
      id: updated.id,
      email: updated.email,
      name: updated.name,
      ispStatus: updated.isp_status,
      currentBalanceCents: updated.current_balance_cents,
      lifetimeEarningsCents: updated.lifetime_earnings_cents,
    },
    creditNewlyApplied: creditResult.applied,
  });
}
