// Server-only helpers for the bank_accounts table. Full routing/account
// numbers are written here but must NEVER be serialized in a client
// response in full -- every read-side consumer must go through
// maskBankInfo() below (or an equivalent last-4 projection), matching the
// same allowlist discipline as lib/authz.js toPublicAccount().

function last4(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.slice(-4).padStart(4, "•");
}

export function maskBankInfo(row) {
  if (!row) return null;
  return {
    fullName: row.full_name,
    address: row.address,
    routingLast4: last4(row.routing_number),
    accountLast4: last4(row.account_number),
    updatedAt: row.updated_at,
  };
}

const REQUIRED_FIELDS = ["fullName", "address", "routingNumber", "accountNumber"];

export function validateBankInfo(body) {
  for (const field of REQUIRED_FIELDS) {
    if (typeof body[field] !== "string" || !body[field].trim()) {
      return `Field "${field}" is required.`;
    }
  }
  const routing = body.routingNumber.trim();
  const account = body.accountNumber.trim();
  if (!/^\d{9}$/.test(routing)) {
    return "Routing number must be exactly 9 digits.";
  }
  if (!/^\d{4,17}$/.test(account)) {
    return "Account number looks invalid.";
  }
  return null;
}
