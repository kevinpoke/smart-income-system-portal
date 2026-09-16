import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getCurrentAccountRaw } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { completeModule, computeModuleStatuses } from "@/lib/moduleEngine";
import { triggerGoldenBridgeFollowupFromModuleCompletion } from "@/lib/supportAutomation";

const GOLDEN_BRIDGE_FOLLOWUP_MODULE_KEY = 7;

// Marks one training module complete for the authenticated customer's OWN
// account. Re-derives and re-checks eligibility entirely server-side
// (lib/moduleEngine.js completeModule) -- a customer POSTing directly to
// this route for a module that isn't ALREADY unlocked per persisted
// server state (or covered by the admin's "Unlock All Modules" override)
// gets a 409, never a silent skip-ahead. Idempotent: completing an
// already-completed module returns success without changing anything
// (completed_at is set with COALESCE, never overwritten).
export async function POST(request, { params }) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const account = await getCurrentAccountRaw();
  if (!account) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const { key } = await params;
  const moduleKey = Number.parseInt(key, 10);
  if (!Number.isInteger(moduleKey) || moduleKey < 1) {
    return NextResponse.json({ error: "Invalid module." }, { status: 400 });
  }

  const db = getDb();
  const result = completeModule(db, account, moduleKey);

  if (!result.ok) {
    const messages = {
      not_found: "That module does not exist.",
      locked: "This module is not yet unlocked.",
    };
    return NextResponse.json(
      { error: messages[result.reason] || "Unable to complete module.", remainingMs: result.remainingMs },
      { status: 409 }
    );
  }

  // GOLDEN-BRIDGE-FOLLOWUP batch (spec section J, Option 1): fire
  // Trigger A ONLY on a genuinely FRESH Module 7 completion --
  // result.alreadyCompleted is the idempotent no-op branch (module was
  // already marked complete before this request), which must NEVER
  // re-fire the automation. This is the single, authoritative call site
  // for actual Module 7 completion in the whole app (see
  // lib/moduleEngine.js#completeModule -- the admin "Unlock All
  // Modules" override only bypasses the unlock TIMER and never itself
  // calls completeModule/writes completed_at), so there is no other
  // path that could race or duplicate this trigger. Fire-and-forget in
  // the sense that a failure here must never break the customer's
  // actual module completion response -- caught and logged, never
  // rethrown.
  if (!result.alreadyCompleted && moduleKey === GOLDEN_BRIDGE_FOLLOWUP_MODULE_KEY) {
    try {
      triggerGoldenBridgeFollowupFromModuleCompletion(db, account.id);
    } catch (err) {
      console.error("[modules/complete] Golden Bridge follow-up trigger failed:", err);
    }
  }

  const fresh = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(account.id);
  const statuses = computeModuleStatuses(db, fresh);

  return NextResponse.json({ ok: true, modules: statuses });
}
