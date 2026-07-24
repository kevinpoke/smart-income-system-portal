import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// Lists real accounts created via the purchase webhook / login system
// (separate from the client-side Zustand demo users on the main site).
// Used by the Admin Panel's "Real Accounts" table.
export async function GET() {
  const db = getDb();
  const accounts = db
    .prepare(
      `SELECT id, email, name, must_change_password, role, created_at FROM accounts ORDER BY created_at DESC`
    )
    .all();

  const outbox = db
    .prepare(
      `SELECT id, to_email, subject, sent_via, created_at FROM outbox ORDER BY created_at DESC LIMIT 20`
    )
    .all();

  return NextResponse.json({
    accounts: accounts.map((a) => ({
      id: a.id,
      email: a.email,
      name: a.name,
      role: a.role,
      status: a.must_change_password ? "New (must change password)" : "Active",
      createdAt: a.created_at,
    })),
    recentEmails: outbox,
  });
}
