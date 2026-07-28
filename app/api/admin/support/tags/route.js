import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { listTags, createTag } from "@/lib/supportEngine";

// Global tag list/creation for the Support inbox. Tags are shared across
// all conversations (assigned per-conversation via conversation_tags).
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.account) {
    return NextResponse.json({ error: guard.errorMessage }, { status: guard.errorStatus });
  }
  const db = getDb();
  return NextResponse.json({ tags: listTags(db) });
}

export async function POST(request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }
  const guard = await requireAdmin();
  if (!guard.account) {
    return NextResponse.json({ error: guard.errorMessage }, { status: guard.errorStatus });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (typeof body.name !== "string" || !body.name.trim()) {
    return NextResponse.json({ error: "Tag name is required." }, { status: 400 });
  }

  const db = getDb();
  const result = createTag(db, body.name);
  if (result.error) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true, tag: result.tag });
}
