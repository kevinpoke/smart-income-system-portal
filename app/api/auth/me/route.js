import { NextResponse } from "next/server";
import { getCurrentAccount } from "@/lib/session";

export async function GET() {
  const account = await getCurrentAccount();
  if (!account) {
    return NextResponse.json({ account: null }, { status: 200 });
  }
  return NextResponse.json({
    account: {
      id: account.id,
      email: account.email,
      name: account.name,
      mustChangePassword: !!account.must_change_password,
      role: account.role,
    },
  });
}
