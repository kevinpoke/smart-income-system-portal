// Server-only helpers for the bank_accounts table. Full routing/account/
// swift/iban values are written here but must NEVER be serialized in a
// client response in full -- every read-side consumer must go through
// maskBankInfo() (customer-facing) or maskBankInfoForAdmin() (admin-facing)
// below, matching the same allowlist discipline as lib/authz.js
// toPublicAccount(). Neither masking function ever returns a raw value --
// only a last-4 projection and/or a boolean "is this field set" flag.
//
// BANK-INTERNATIONAL batch: extends this SAME existing bank_accounts
// model (schema change lives in lib/db.js -- additive `swift`/`iban`
// TEXT columns, never a second/parallel bank-profile table) to support
// international wire details as an alternative to domestic
// routing/account numbers. See:
//   - validateCustomerBankInfo()  -- customer self-service save: requires
//     fullName+address always, PLUS either the domestic pair
//     (routingNumber+accountNumber) OR the international pair
//     (swift+iban). Never requires all four.
//   - validateAndNormalizeAdminBankFields() -- admin-only save: every
//     field (fullName/address/accountNumber/routingNumber/swift/iban) is
//     independently optional, no pair requirement at all, partial saves
//     and individual-field clears are both valid.

function last4FromDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.slice(-4).padStart(4, "•");
}

// SWIFT/IBAN are alphanumeric, not digit-only -- masking must NOT strip
// letters (that would silently destroy/misrepresent the last-4 preview).
function last4Alphanumeric(value) {
  const raw = String(value || "").trim();
  return raw.slice(-4).padStart(4, "•");
}

// Customer-facing projection -- used by GET /api/withdrawals/bank. Never
// includes a raw account/routing/swift/iban value, only last-4 previews
// and presence flags so the Withdrawals page can decide which section
// (Domestic/International) to show as "currently saved" without ever
// receiving the underlying secret.
export function maskBankInfo(row) {
  if (!row) return null;
  const hasAccountNumber = Boolean(row.account_number && row.account_number.length > 0);
  const hasRoutingNumber = Boolean(row.routing_number && row.routing_number.length > 0);
  const hasSwift = Boolean(row.swift && row.swift.length > 0);
  const hasIban = Boolean(row.iban && row.iban.length > 0);
  return {
    fullName: row.full_name,
    address: row.address,
    hasAccountNumber,
    hasRoutingNumber,
    accountLast4: hasAccountNumber ? last4FromDigits(row.account_number) : null,
    routingLast4: hasRoutingNumber ? last4FromDigits(row.routing_number) : null,
    hasSwift,
    hasIban,
    swiftLast4: hasSwift ? last4Alphanumeric(row.swift) : null,
    ibanLast4: hasIban ? last4Alphanumeric(row.iban) : null,
    updatedAt: row.updated_at,
  };
}

// Admin-facing projection -- used by GET /api/admin/accounts/[id]/bank.
// Deliberately the SAME shape/safety contract as maskBankInfo() (never a
// raw value) -- the Admin UI edits bank fields the same way "Set
// Password" edits a password: blank inputs that OVERWRITE, never
// pre-filled with the real secret. fullName/address ARE included in full
// here (never treated as sensitive -- same as every other admin-visible
// customer profile field, e.g. email/address elsewhere in User
// Management) -- only account/routing/swift/iban are masked.
export function maskBankInfoForAdmin(row) {
  return maskBankInfo(row);
}

const SWIFT_IBAN_RE = /^[A-Za-z0-9]+$/;

// Shared alphanumeric validation for SWIFT/IBAN: letters + numbers only,
// trimmed, never forced to a different case, never digit-only. A loose
// length ceiling (64) guards against pathological input without
// rejecting any real-world SWIFT (8/11 chars) or IBAN (up to 34 chars
// across every IBAN-using country).
function validateSwiftOrIban(value, label) {
  const trimmed = value.trim();
  if (!SWIFT_IBAN_RE.test(trimmed)) {
    return `${label} may only contain letters and numbers.`;
  }
  if (trimmed.length > 64) {
    return `${label} is too long.`;
  }
  return null;
}

// Customer self-service validation (POST /api/withdrawals/bank).
// fullName + address are always required (the wire recipient identity,
// needed regardless of domestic vs international). Beyond that, EITHER
// the domestic pair (routingNumber + accountNumber) OR the international
// pair (swift + iban) must be fully present -- never both, never all
// four required, never a lone field from either pair.
export function validateCustomerBankInfo(body) {
  const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
  const address = typeof body.address === "string" ? body.address.trim() : "";
  if (!fullName) return 'Field "fullName" is required.';
  if (!address) return 'Field "address" is required.';

  const routingNumber = typeof body.routingNumber === "string" ? body.routingNumber.trim() : "";
  const accountNumber = typeof body.accountNumber === "string" ? body.accountNumber.trim() : "";
  const swift = typeof body.swift === "string" ? body.swift.trim() : "";
  const iban = typeof body.iban === "string" ? body.iban.trim() : "";

  const hasDomesticPair = Boolean(routingNumber) && Boolean(accountNumber);
  const hasInternationalPair = Boolean(swift) && Boolean(iban);

  if (!hasDomesticPair && !hasInternationalPair) {
    return "Provide either Account Number + Routing Number, or SWIFT + IBAN.";
  }

  // Each SIDE is only format-validated when that side is actually being
  // submitted as a pair -- e.g. a customer submitting ONLY the
  // international pair never has their (absent) domestic fields format-
  // checked, and vice versa. A customer submitting BOTH pairs (spec:
  // "Account Number + Routing Number + SWIFT + IBAN -> VALID") gets both
  // validated. A lone field from either pair (e.g. "Account Number
  // only") already failed the hasDomesticPair/hasInternationalPair check
  // above and never reaches here.
  if (hasDomesticPair) {
    if (!/^\d{9}$/.test(routingNumber)) {
      return "Routing number must be exactly 9 digits.";
    }
    if (!/^\d{4,17}$/.test(accountNumber)) {
      return "Account number looks invalid.";
    }
  }
  if (hasInternationalPair) {
    const swiftErr = validateSwiftOrIban(swift, "SWIFT");
    if (swiftErr) return swiftErr;
    const ibanErr = validateSwiftOrIban(iban, "IBAN");
    if (ibanErr) return ibanErr;
  }

  return null;
}

// Admin validation (POST /api/admin/accounts/[id]/bank). Every field is
// INDEPENDENTLY optional -- no domestic-pair requirement, no
// international-pair requirement, no all-four requirement. Only format-
// validates a field that is both PRESENT and NON-EMPTY (an admin
// clearing a field by sending "" is always valid; a present digit-only
// routing/account value is still sanity-checked against the same real-
// world shape the customer path uses, but SWIFT/IBAN accept any
// alphanumeric content and nothing here enforces numeric-only on
// anything). Returns { ok: true, value } (trimmed) or { ok: false,
// message } per field; caller (the admin route) only applies fields the
// admin's request body actually included.
export function validateAdminBankField(field, rawValue) {
  if (typeof rawValue !== "string") {
    return { ok: false, message: `${field} must be text.` };
  }
  const trimmed = rawValue.trim();
  if (trimmed === "") {
    return { ok: true, value: "" }; // explicit clear -- always valid for Admin.
  }
  if (field === "routingNumber" && !/^\d{9}$/.test(trimmed)) {
    return { ok: false, message: "Routing number must be exactly 9 digits." };
  }
  if (field === "accountNumber" && !/^\d{4,17}$/.test(trimmed)) {
    return { ok: false, message: "Account number looks invalid." };
  }
  if (field === "swift") {
    const err = validateSwiftOrIban(trimmed, "SWIFT");
    if (err) return { ok: false, message: err };
  }
  if (field === "iban") {
    const err = validateSwiftOrIban(trimmed, "IBAN");
    if (err) return { ok: false, message: err };
  }
  return { ok: true, value: trimmed };
}
