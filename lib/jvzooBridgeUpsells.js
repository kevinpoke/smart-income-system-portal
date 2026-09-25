import { generateId } from "./auth-crypto";
import { addOwnedNodeWithTier, removeOwnedNode } from "./ownedNodes";
import { JVZOO_UPSELL_PRODUCT_TIER_KEY } from "./jvzoo";

// JVZOO-BRIDGE-UPSELL batch: durable entitlement lifecycle for the two
// JVZoo upsell products (452855 Standard Bridge Oto1, 452859 IX Bridge
// Oto2). See lib/db.js's jvzoo_bridge_entitlements table comment for
// the full schema rationale. This module is imported by:
//   - app/api/webhooks/jvzoo/route.js (BUY creates/records the
//     entitlement + attempts immediate grant; RFND cancels/removes)
//   - lib/ispEngine.js#completeIspAuthorization (final ISP activation
//     processes every pending entitlement for that account)
//   - lib/backgroundScheduler.js (periodic reconciliation safety net)
//
// GRANT CONDITION -- CANONICAL FINAL ACTIVE STATE: an account is only
// eligible for an upsell Bridge grant once isp_status === 'active' (the
// exact same state completeIspAuthorization() itself sets -- see
// lib/ispEngine.js). 'approved_awaiting_user' is explicitly NOT
// treated as final activation anywhere in this file.
function isIspFinalActive(account) {
  return Boolean(account && account.isp_status === "active");
}

// Records a new upsell entitlement for a verified JVZoo BUY (SALE/BILL)
// notification of 452855 or 452859. `accountId` may be null if the
// matching Smart Income System account could not yet be found by email
// (event-ordering edge case) -- the row is still durably recorded via
// customer_email so runJvzooUpsellReconciliationScan() can backfill and
// process it once the account exists, per "do not silently lose the
// purchase."
//
// IDEMPOTENCY: transaction_id has a real UNIQUE constraint (source of
// truth); the pre-check SELECT is only the fast common path, mirroring
// every other dedup check in lib/webhooks/jvzoo/route.js. Returns
// { created: false, reason: "duplicate_transaction" } without touching
// anything else on a replay.
export function recordJvzooUpsellPurchase(db, { accountId, email, productId, transactionId, purchasedAt }) {
  const tierKey = JVZOO_UPSELL_PRODUCT_TIER_KEY[String(productId)];
  if (!tierKey) {
    return { created: false, reason: "not_an_upsell_product" };
  }

  const existingByTransaction = db
    .prepare(`SELECT id FROM jvzoo_bridge_entitlements WHERE transaction_id = ?`)
    .get(transactionId);
  if (existingByTransaction) {
    return { created: false, reason: "duplicate_transaction" };
  }

  const id = generateId("jvupsell");
  const now = new Date().toISOString();

  try {
    db.prepare(
      `INSERT INTO jvzoo_bridge_entitlements
         (id, account_id, customer_email, product_id, bridge_tier_key, transaction_id, status, purchased_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    ).run(id, accountId || null, email, String(productId), tierKey, transactionId, purchasedAt || now, now);
  } catch (err) {
    if (String(err?.message || "").includes("UNIQUE")) {
      // Either the same transaction_id raced us (handled above, belt-
      // and-suspenders here), or this account already has an
      // entitlement for this exact product_id (idx_jvzoo_upsell_account_
      // product) -- i.e. "each upsell can only be purchased once per
      // customer." Either way, never create a second row/Bridge.
      return { created: false, reason: "already_purchased_or_duplicate" };
    }
    throw err;
  }

  return { created: true, id, tierKey };
}

// Attempts to grant ONE specific pending entitlement row. Idempotent:
// re-running this on an already-granted/cancelled/refunded row is a
// safe no-op (re-checks status against a FRESH read inside the same
// transaction before writing). Only ever creates a Bridge via the
// EXISTING lib/ownedNodes.js#addOwnedNodeWithTier() generator -- never
// a separate/hardcoded earnings path, and never anything from
// lib/specialBridges.js.
//
// REFUND/GRANT RACE: this function re-reads the entitlement's status
// INSIDE the transaction immediately before granting, so a refund that
// commits first (see cancelOrRefundEntitlement below, which also runs
// inside its own transaction and is the only other writer of `status`)
// is always visible here -- this call then sees status !== 'pending'
// and safely no-ops instead of granting a Bridge for an
// already-refunded entitlement. Symmetrically, if this function's
// transaction commits the grant FIRST, a concurrent refund attempt
// will see status === 'granted' and correctly remove the
// just-granted owned_node_id (see cancelOrRefundEntitlement) -- so the
// final state can never be "refunded entitlement with an active
// linked Bridge" regardless of which side wins the race.
export function processEntitlementGrant(db, entitlementId) {
  let result;
  db.exec("BEGIN");
  try {
    const entitlement = db
      .prepare(`SELECT * FROM jvzoo_bridge_entitlements WHERE id = ?`)
      .get(entitlementId);
    if (!entitlement) {
      db.exec("ROLLBACK");
      return { granted: false, reason: "not_found" };
    }
    if (entitlement.status !== "pending") {
      // Already granted (idempotent no-op), or cancelled/refunded
      // before ever being eligible -- never grant in either case.
      db.exec("ROLLBACK");
      return { granted: false, reason: `not_pending:${entitlement.status}` };
    }
    if (!entitlement.account_id) {
      db.exec("ROLLBACK");
      return { granted: false, reason: "no_account_linked_yet" };
    }

    const account = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(entitlement.account_id);
    if (!account || !isIspFinalActive(account)) {
      db.exec("ROLLBACK");
      return { granted: false, reason: "isp_not_final_active" };
    }

    // Same current Standard/IX(nova) assignment generator used for
    // every other new Bridge assignment -- never a JVZoo-specific
    // earnings roll. Seeded deterministically by (accountId, nodeNumber,
    // tierKey) inside addOwnedNodeWithTier(), same as any other new
    // Bridge.
    const grantResult = addOwnedNodeWithTier(db, entitlement.account_id, entitlement.bridge_tier_key);
    if (!grantResult.added) {
      db.exec("ROLLBACK");
      return { granted: false, reason: grantResult.reason || "grant_failed" };
    }

    const now = new Date().toISOString();
    db.prepare(
      `UPDATE jvzoo_bridge_entitlements
       SET status = 'granted', granted_owned_node_id = ?, granted_at = ?
       WHERE id = ? AND status = 'pending'`
    ).run(grantResult.id, now, entitlementId);

    db.exec("COMMIT");
    result = { granted: true, ownedNodeId: grantResult.id, tierKey: entitlement.bridge_tier_key };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return result;
}

// Processes every pending, account-linked entitlement for ONE account.
// Called from BOTH:
//   - lib/ispEngine.js#completeIspAuthorization (event-driven: fires the
//     instant ISP reaches final active)
//   - a successful upsell BUY when the account is ALREADY final active
//     (event-driven: fires immediately at purchase time)
// Safe to call redundantly / concurrently (each individual grant is its
// own guarded transaction above).
export function processPendingEntitlementsForAccount(db, accountId) {
  const pending = db
    .prepare(
      `SELECT id FROM jvzoo_bridge_entitlements WHERE account_id = ? AND status = 'pending'`
    )
    .all(accountId);
  const results = [];
  for (const row of pending) {
    results.push({ id: row.id, ...processEntitlementGrant(db, row.id) });
  }
  return results;
}

// Reconciliation safety net -- called from the existing background
// scheduler (lib/backgroundScheduler.js), never a standalone cron.
// Covers: temporary DB error, process interruption, webhook race, or a
// restart between entitlement creation and Bridge grant. Also
// backfills account_id for any entitlement recorded before the
// matching account existed/was found (event-ordering edge case), then
// attempts to process every eligible pending entitlement in one pass.
// Fully idempotent -- every grant still goes through
// processEntitlementGrant()'s own guarded transaction.
export function runJvzooUpsellReconciliationScan(db) {
  // Backfill account_id for any entitlement still missing it, now that
  // the matching account may exist.
  const unmatched = db
    .prepare(`SELECT id, customer_email FROM jvzoo_bridge_entitlements WHERE account_id IS NULL AND status = 'pending'`)
    .all();
  let backfilled = 0;
  for (const row of unmatched) {
    const account = db.prepare(`SELECT id FROM accounts WHERE email = ?`).get(row.customer_email);
    if (!account) continue;
    try {
      db.prepare(`UPDATE jvzoo_bridge_entitlements SET account_id = ? WHERE id = ? AND account_id IS NULL`).run(
        account.id,
        row.id
      );
      backfilled += 1;
    } catch (err) {
      // idx_jvzoo_upsell_account_product UNIQUE violation -- this
      // account somehow already has an entitlement for this product
      // (shouldn't normally happen since accountId was null, but never
      // let one bad row crash the whole scan).
      if (!String(err?.message || "").includes("UNIQUE")) throw err;
    }
  }

  const pendingRows = db
    .prepare(`SELECT id FROM jvzoo_bridge_entitlements WHERE status = 'pending' AND account_id IS NOT NULL`)
    .all();
  let granted = 0;
  for (const row of pendingRows) {
    const result = processEntitlementGrant(db, row.id);
    if (result.granted) granted += 1;
  }
  return { scanned: pendingRows.length, backfilled, granted };
}

// Handles a verified JVZoo refund for one of the two upsell products.
// Matched by this refund's own transaction_id against
// jvzoo_bridge_entitlements.transaction_id (never by email/tier/
// "latest Bridge") -- exactly mirrors the FE refund's
// transaction_id-based matching discipline in the main webhook route.
// transaction_id alone is already sufficient for correctness (it has a
// real DB UNIQUE constraint, so it can never resolve to more than one
// entitlement row) -- but `productId` is passed as an ADDITIONAL
// consistency check, not a second lookup key: if the refund payload's
// product_id doesn't match the product_id this entitlement was
// actually created under, something is inconsistent (a malformed/
// corrupted payload, or JVZoo somehow reusing a transaction id across
// products) and the refund is rejected rather than silently acted on
// against the wrong product's entitlement. This can never weaken
// idempotency: a genuine repeat of the SAME refund always carries the
// SAME product_id, so the already-cancelled/refunded short-circuit
// below is reached exactly as before.
//
// IDEMPOTENT: re-running on an already-cancelled/refunded entitlement
// is a safe no-op (status guard on every UPDATE).
export function cancelOrRefundEntitlement(db, { transactionId, productId }) {
  let result;
  db.exec("BEGIN");
  try {
    const entitlement = db
      .prepare(`SELECT * FROM jvzoo_bridge_entitlements WHERE transaction_id = ?`)
      .get(transactionId);
    if (!entitlement) {
      db.exec("ROLLBACK");
      return { matched: false };
    }
    if (productId !== undefined && String(productId) !== String(entitlement.product_id)) {
      // Refund payload's product_id disagrees with the product_id this
      // entitlement was recorded under -- never act on a mismatch.
      db.exec("ROLLBACK");
      return { matched: false, reason: "product_id_mismatch" };
    }
    if (entitlement.status === "cancelled" || entitlement.status === "refunded") {
      db.exec("ROLLBACK");
      return { matched: true, alreadyProcessed: true, status: entitlement.status };
    }

    const now = new Date().toISOString();

    if (entitlement.status === "pending") {
      // Never grant later: mark cancelled. No Bridge was ever created
      // for this entitlement, so there is nothing to remove.
      db.prepare(
        `UPDATE jvzoo_bridge_entitlements SET status = 'cancelled', refunded_at = ? WHERE id = ? AND status = 'pending'`
      ).run(now, entitlement.id);
      db.exec("COMMIT");
      result = { matched: true, action: "cancelled_pending" };
    } else if (entitlement.status === "granted") {
      // Remove/deactivate ONLY the exact linked owned_node_id -- never
      // the starter Bridge, another Standard Bridge, a Special Bridge,
      // or the other upsell's Bridge. Uses the SAME soft-remove
      // mechanism (removeOwnedNode) every other Bridge removal uses;
      // never disables the account.
      if (entitlement.granted_owned_node_id) {
        removeOwnedNode(db, entitlement.account_id, entitlement.granted_owned_node_id);
      }
      db.prepare(
        `UPDATE jvzoo_bridge_entitlements SET status = 'refunded', refunded_at = ? WHERE id = ? AND status = 'granted'`
      ).run(now, entitlement.id);
      db.exec("COMMIT");
      result = { matched: true, action: "refunded_granted", removedOwnedNodeId: entitlement.granted_owned_node_id };
    } else {
      db.exec("ROLLBACK");
      return { matched: true, action: "no_action", status: entitlement.status };
    }
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return result;
}
