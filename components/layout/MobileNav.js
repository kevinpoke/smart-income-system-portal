"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import clsx from "clsx";
import {
  LayoutDashboard,
  PlayCircle,
  Wifi,
  Wallet,
  Server,
  Banknote,
  LifeBuoy,
  LogOut,
} from "lucide-react";
import { useSupportUnread } from "@/lib/useSupportUnread";

const NAV_ITEMS = [
  { href: "/", label: "Home", icon: LayoutDashboard },
  { href: "/modules", label: "Modules", icon: PlayCircle },
  { href: "/isp-setup", label: "ISP", icon: Wifi },
  { href: "/payouts", label: "Payouts", icon: Wallet },
  { href: "/nodes", label: "Nodes", icon: Server },
  { href: "/withdrawals", label: "Cash Out", icon: Banknote },
  { href: "/support", label: "Support", icon: LifeBuoy },
];

export default function MobileNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);
  // Portal reliability pass: same persistent, server-polled Support
  // unread indicator as the desktop Sidebar (see lib/useSupportUnread.js).
  const { unread: supportUnread } = useSupportUnread();

  // Same logout behavior as the desktop Sidebar: POST to the real logout
  // endpoint (server session is the source of truth), guard against
  // double-taps, then redirect. This nav has no Admin Portal link (it
  // never did -- admin management is desktop-only in this app), so there
  // is no role-visibility change needed here beyond adding Logout.
  async function handleLogout() {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // fall through to redirect regardless -- proxy.js rejects any stale
      // cookie on the next request either way.
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 flex items-center justify-around border-t border-white/10 bg-[#161616]/95 px-1 py-2 backdrop-blur-xl lg:hidden">
      {NAV_ITEMS.map((item) => {
        const active = pathname === item.href;
        const Icon = item.icon;
        const showSupportBadge = item.href === "/support" && supportUnread;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={clsx(
              "flex flex-col items-center gap-0.5 rounded-lg px-2 py-1 text-[10px] font-medium",
              active ? "text-[#32B5FF]" : "text-[#707070]"
            )}
          >
            <span className="relative inline-flex">
              <Icon className="h-5 w-5" />
              {showSupportBadge && (
                <span
                  className="absolute -right-0.5 -top-0.5 h-2 w-2 animate-pulse rounded-full bg-[#32B5FF] shadow-[0_0_6px_rgba(50,181,255,0.8)]"
                  aria-label="Unread support reply"
                  title="Unread support reply"
                />
              )}
            </span>
            {item.label}
          </Link>
        );
      })}
      <button
        type="button"
        onClick={handleLogout}
        disabled={loggingOut}
        aria-busy={loggingOut}
        className={clsx(
          "flex flex-col items-center gap-0.5 rounded-lg px-2 py-1 text-[10px] font-medium",
          loggingOut ? "cursor-not-allowed text-[#707070]/60" : "text-[#707070]"
        )}
      >
        <LogOut className="h-5 w-5" />
        {loggingOut ? "…" : "Logout"}
      </button>
    </nav>
  );
}
