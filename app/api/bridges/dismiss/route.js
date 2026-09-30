import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getCurrentAccountRaw } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { cookies } from "next/headers";
import { COOKIE_NAME } from "@/lib/authz";

// Customer opened the Bridges page/popup: stamp bridges_dismissed_at on
// THIS session only (never accounts, never other sessions) -- see
// lib/bridgesNotification.js for the full state-machine rationale.
export async function POST(request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }
  const account = await getCurrentAccountRaw();
  if (!account) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const db = getDb();
  db.prepare(`UPDATE sessions SET bridges_dismissed_at = ? WHERE token = ?`).run(
    new Date().toISOString(),
    token
  );

  return NextResponse.json({ ok: true });
}
