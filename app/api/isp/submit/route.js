import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getCurrentAccountRaw, toPublicAccount } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { generateId } from "@/lib/auth-crypto";

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
  const city = body.city.trim();
  const state = body.state.trim();
  const zip = body.zip.trim();
  const ssid = body.ssid.trim();
  const wifiPassword = body.password;
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO isp_setups (id, account_id, provider, street, city, state, zip, ssid, wifi_password, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(generateId("isp"), account.id, provider, street, city, state, zip, ssid, wifiPassword, now);

  db.prepare(
    `UPDATE accounts
     SET isp_provider = ?,
         isp_street = ?,
         isp_city = ?,
         isp_state = ?,
         isp_zip = ?,
         isp_status = 'pending_review',
         isp_submitted_at = COALESCE(isp_submitted_at, ?)
     WHERE id = ?`
  ).run(provider, street, city, state, zip, now, account.id);

  const updated = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(account.id);

  return NextResponse.json({ ok: true, account: toPublicAccount(updated) });
}
