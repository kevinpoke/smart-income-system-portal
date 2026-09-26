import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getCurrentAccountRaw, toPublicAccount } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { generateId } from "@/lib/auth-crypto";
import {
  normalizeCity,
  normalizeState,
  isValidStateCode,
  normalizeOtherStateText,
  OTHER_STATE_CODE,
} from "@/lib/locationNormalize";

const REQUIRED_FIELDS = ["provider", "street", "city", "state", "zip", "ssid", "password"];

function validate(body) {
  for (const field of REQUIRED_FIELDS) {
    if (typeof body[field] !== "string" || !body[field].trim()) {
      return `Field "${field}" is required.`;
    }
  }
  if (body.zip.trim().length < 3 || body.zip.trim().length > 12) {
    return "Zip code looks invalid.";
  }
  // OTHER-STATE-ISP batch: the State selector now also accepts the
  // literal string "Other" (normalizeState uppercases -> "OTHER",
  // matching OTHER_STATE_CODE) as a valid selection alongside every
  // real two-letter US_STATES code. When Other is selected, the
  // customer's typed "State / Region" free-text value is REQUIRED and
  // must be non-empty after trimming -- validated here so the server
  // never trusts a client-side-only check.
  const normalizedState = normalizeState(body.state);
  const isOther = normalizedState === OTHER_STATE_CODE;
  if (!isOther && !isValidStateCode(normalizedState)) {
    return "State must be a valid two-letter US state code.";
  }
  if (isOther && !normalizeOtherStateText(body.stateOther).length) {
    return "Please enter your state, province, region, or territory.";
  }
  return null;
}

// Customer submits their ISP setup application. Server-side rules per
// Phase 2 spec:
// - validate all fields server-side (never trust the client)
// - isp_submitted_at set ONLY if null (never reset on resubmit/refresh)
// - isp_status -> pending_review
// - once isp_status has left "not_started", further submissions are
//   rejected (an admin must explicitly reset via the admin ISP-reset
//   action before a customer can resubmit) -- this is the
//   "prevent duplicate submission" rule.
//
// SECURITY (Phase 3 correction): the WiFi password submitted here is used
// only for the required-field validation above and is otherwise DISCARDED
// -- it is never written to isp_setups, never written to accounts, never
// logged (no console.log/error of `body` or `wifiPassword` anywhere in
// this route), and never included in the response. The portal has no need
// for the real credential to simulate Node activation. SSID IS stored
// (isp_setups.ssid) since it's a low-sensitivity network name, but it is
// only ever read back through authorized admin/customer detail views, not
// the general account-list endpoints (see app/api/admin/accounts).
export async function POST(request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const account = await getCurrentAccountRaw();
  if (!account) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const validationError = validate(body);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  const db = getDb();
  // Re-fetch fresh (account passed in may be a shallow copy) to get the
  // authoritative current isp_status right before writing.
  const fresh = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(account.id);

  if (fresh.isp_status !== "not_started") {
    return NextResponse.json(
      { error: "An ISP setup application has already been submitted for this account." },
      { status: 409 }
    );
  }

  const provider = body.provider.trim();
  const street = body.street.trim();
  // City/state are normalized via the SAME shared utility the admin
  // location editor uses (lib/locationNormalize.js) -- "do not maintain
  // separate formatting logic in multiple routes." Title-cased,
  // whitespace-collapsed city; uppercased two-letter state (or the
  // OTHER_STATE_CODE sentinel when the customer selected Other).
  const city = normalizeCity(body.city);
  const state = normalizeState(body.state);
  const isOther = state === OTHER_STATE_CODE;
  // OTHER-STATE-ISP batch: the customer's exact typed value, trimmed
  // only (never title-cased/rewritten) -- null (never empty string) for
  // a normal State selection, matching the explicit isp_state_is_other
  // flag written below.
  const stateOtherText = isOther ? normalizeOtherStateText(body.stateOther) : null;
  const zip = body.zip.trim();
  const ssid = body.ssid.trim();
  // WiFi password is intentionally NOT captured into a variable used
  // beyond validation -- it is never persisted or logged.
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO isp_setups (id, account_id, provider, street, city, state, zip, ssid, submitted_at, state_is_other, state_other_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    generateId("isp"),
    account.id,
    provider,
    street,
    city,
    state,
    zip,
    ssid,
    now,
    isOther ? 1 : 0,
    stateOtherText
  );

  db.prepare(
    `UPDATE accounts
     SET isp_provider = ?,
         isp_street = ?,
         isp_city = ?,
         isp_state = ?,
         isp_zip = ?,
         isp_status = 'pending_review',
         isp_submitted_at = COALESCE(isp_submitted_at, ?),
         isp_state_is_other = ?,
         isp_state_other_text = ?
     WHERE id = ?`
  ).run(provider, street, city, state, zip, now, isOther ? 1 : 0, stateOtherText, account.id);

  const updated = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(account.id);

  return NextResponse.json({ ok: true, account: toPublicAccount(updated) });
}
