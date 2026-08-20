import crypto from "node:crypto";

// Dedicated, isolated module for the JVZoo JVZIPN v2 server-to-server
// onboarding webhook (Phase 7). Kept separate from lib/auth-crypto.js
// (generic password hashing) and lib/session.js (customer/admin session
// auth) because this verification model is completely different: JVZoo
// never sends a session cookie, it authenticates itself via a shared
// secret + SHA-1 digest carried in the POST body.
//
// Official JVZIPN v2 verification method (confirmed against JVZoo's own
// current documentation as of Phase 7 -- see the article linked from
// https://blog.jvzoo.com/jvzipn-v2-better-order-data-full-payout-visibility/,
// "Same Rock-Solid Verification... signature verification model remains
// unchanged [from v1]"):
//
//   1. Build the string:  paykey|customer_email|product_name|transaction_type|date|
//   2. Append the seller's JVZIPN Secret Key (JVZOO_IPN_SECRET) to that string.
//   3. SHA-1 hash the result.
//   4. Take the first 8 hex characters, uppercase them.
//   5. Compare (constant-time) against the `cverify` field JVZoo sent.
//
// FIELD NAME NOTE: paykey, customer_email, product_name, transaction_type,
// date, and cverify are all confirmed field names (they appear directly in
// the verification formula the user supplied from JVZoo's own current
// docs). product_id, customer_first_name, and customer_last_name are
// confirmed from JVZoo's public v2 announcement blog post's field list.
// The exact field name JVZoo uses for the unique transaction/order id
// (used here as the idempotency key) was NOT explicitly confirmed in any
// source available during this implementation -- see
// JVZOO_TRANSACTION_ID_FIELD below, which is intentionally isolated in one
// place so it can be corrected in one line once confirmed against a real
// JVZoo test payload, without touching any other verification logic.
export const JVZOO_FIELDS = {
  VERIFY: "cverify",
  PAYKEY: "paykey",
  EMAIL: "customer_email",
  FIRST_NAME: "customer_first_name",
  LAST_NAME: "customer_last_name",
  PRODUCT_NAME: "product_name",
  PRODUCT_ID: "product_id",
  TRANSACTION_TYPE: "transaction_type",
  DATE: "date",
  // ASSUMPTION -- confirm against a real JVZoo IPN test payload before
  // relying on this for production idempotency. If JVZoo's actual field
  // name differs, update ONLY this one line.
  TRANSACTION_ID: "transaction_id",
};

export const JVZOO_TRANSACTION_TYPES = {
  SALE: "SALE", // new qualifying purchase
  BILL: "BILL", // rebill (subscription/installment)
  RFND: "RFND", // refund/chargeback
};

// Only this exact product currently provisions Smart Income System base
// access. Confirmed directly by the user from their JVZoo seller
// dashboard -- never guessed. Upsells/other products are intentionally
// NOT mapped yet (per spec, "map upsells separately later").
export const APPROVED_PRODUCT_IDS = new Set(["448013"]);

// Recomputes the expected cverify value from the raw form fields + the
// server-side secret. Never throws on missing fields (callers must
// validate required fields separately before calling this); returns a
// deterministic 8-char uppercase hex string either way.
export function computeCverify(secret, { paykey, customerEmail, productName, transactionType, date }) {
  const base = `${paykey || ""}|${customerEmail || ""}|${productName || ""}|${transactionType || ""}|${date || ""}|${secret || ""}`;
  const digest = crypto.createHash("sha1").update(base, "utf8").digest("hex");
  return digest.slice(0, 8).toUpperCase();
}

// Constant-time comparison of the JVZoo-supplied cverify against our own
// recomputed value. Never leaks timing information about *where* a
// mismatch occurs. A length mismatch is checked first (this only reveals
// that the lengths differ, not any information about the secret or the
// correct content) and short-circuits to false without ever calling
// crypto.timingSafeEqual on unequal-length buffers (which would throw).
export function verifyCverify(secret, fields, suppliedCverify) {
  const expected = computeCverify(secret, fields);
  const expectedBuf = Buffer.from(expected, "utf8");
  const suppliedBuf = Buffer.from(String(suppliedCverify || ""), "utf8");
  if (expectedBuf.length !== suppliedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, suppliedBuf);
}
