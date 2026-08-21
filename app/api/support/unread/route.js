import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getCurrentAccountRaw } from "@/lib/session";
import { getOrCreateConversation, getCustomerUnread } from "@/lib/supportEngine";
import { deliverDueMessages } from "@/lib/supportAutomation";

// Lightweight, read-only "does the customer have an unread admin reply"
// check for the persistent Support nav-tab indicator (Sidebar/MobileNav).
// Deliberately does NOT mark anything read -- only actually opening/
// loading the Support page itself (GET /api/support/messages) clears the
// indicator, per spec ("must not disappear merely because another page
// re-renders... clear the notification only when the customer opens or
// taps the Support tab/page"). Polled every few seconds while the
// customer is logged in so the badge appears automatically without a
// hard refresh.
export async function GET() {
  const account = await getCurrentAccountRaw();
  if (!account) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const db = getDb();
  // Production feature/fix batch: this route is the one polled every
  // few seconds by the Sidebar/MobileNav nav badge WITHOUT the customer
  // ever opening the Support page itself -- it must also flush any due
  // scheduled automated messages first, otherwise a welcome/check-in
  // message that becomes due while the customer is browsing elsewhere
  // would silently sit undelivered (and therefore invisible, no badge)
  // until they happened to open Support, defeating lazy delivery. See
  // lib/supportAutomation.js.
  deliverDueMessages(db, account.id);
  const conversation = getOrCreateConversation(db, account.id);
  const unread = getCustomerUnread(db, account.id);

  return NextResponse.json({ unread });
}
