import { NextResponse } from "next/server";
import { getCurrentAccountRaw, toPublicAccount } from "@/lib/session";

export async function GET() {
  const account = await getCurrentAccountRaw();
  if (!account) {
    return NextResponse.json({ account: null }, { status: 200 });
  }
  return NextResponse.json({ account: toPublicAccount(account) });
}
