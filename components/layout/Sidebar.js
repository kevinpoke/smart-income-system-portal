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
  Satellite,
  ShieldCheck,
  LogOut,
} from "lucide-react";
import { useAccount } from "@/lib/useAccount";
import { useSupportUnread } from "@/lib/useSupportUnread";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/modules", label: "Modules", icon: PlayCircle },
  { href: "/isp-setup", label: "ISP Setup", icon: Wifi },
  { href: "/payouts", label: "Payouts", icon: Wallet },
  { href: "/nodes", label: "Nodes", icon: Server },
  { href: "/withdrawals", label: "Withdrawals", icon: Banknote },
  { href: "/support", label: "Support", icon: LifeBuoy },
];

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  // role comes from the server-authoritative /api/auth/me via useAccount --
  // never inferred from localStorage/Zustand. This only controls whether
  // the Admin Portal *link* is rendered; the actual admin protection is
  // enforced independently and unchanged in proxy.js (redirects
  // non-admins away from /admin and /api/admin/*) and in
  // lib/session.js requireAdmin() for every admin API route.
  const { account } = useAccount();
  const isAdmin = account?.role === "admin";
  // Portal reliability pass: persistent Support unread indicator (see
  // lib/useSupportUnread.js) -- server-backed, polls independently of
  // whatever page is currently mounted, and only clears when the
  // customer actually opens the Support page.
  const { unread: supportUnread } = useSupportUnread();

  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogout() {
    if (loggingOut) return; // prevent double-clicks from firing multiple requests
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // Even if the network request fails, still send the user to /login --
      // the server session is the source of truth for access control (see
      // proxy.js), so worst case a stale cookie gets rejected there on the
      // next request rather than silently leaving the user stuck.
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }

  return (
    <aside className="fixed left-0 top-0 z-40 hidden h-screen w-64 flex-col border-r border-white/10 bg-[#161616]/80 backdrop-blur-xl lg:flex">
      <div className="flex items-center gap-2 px-6 py-6">
        <Satellite className="h-7 w-7 text-[#32B5FF]" />
        <div>
          <div className="text-sm font-bold leading-tight text-white">
            Star Atlas
          </div>
          <div className="text-[11px] leading-tight text-[#B0B0B0]">
            Rewards Network
          </div>
        </div>
      </div>

      <nav className="flex-1 space-y-1 px-3">
        {NAV_ITEMS.map((item) => {
          const active = pathname === item.href;
          const Icon = item.icon;
          const showSupportBadge = item.href === "/support" && supportUnread;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={clsx(
                "group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all",
                active
                  ? "bg-[#32B5FF]/15 text-[#32B5FF] shadow-[inset_0_0_0_1px_rgba(50,181,255,0.3)]"
                  : "text-[#B0B0B0] hover:bg-white/5 hover:text-white"
              )}
            >
              <span className="relative inline-flex">
                <Icon
                  className={clsx(
                    "h-[18px] w-[18px] transition-colors",
                    active ? "text-[#32B5FF]" : "text-[#B0B0B0] group-hover:text-white"
                  )}
                />
                {showSupportBadge && (
                  <span
                    className="absolute -right-1 -top-1 h-2 w-2 animate-pulse rounded-full bg-[#32B5FF] shadow-[0_0_6px_rgba(50,181,255,0.8)]"
                    aria-label="Unread support reply"
                    title="Unread support reply"
                  />
                )}
              </span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="space-y-1 px-3 pb-4">
        {isAdmin && (
          <Link
            href="/admin"
            className={clsx(
              "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all",
              pathname.startsWith("/admin")
                ? "bg-white/10 text-white"
                : "text-[#707070] hover:bg-white/5 hover:text-white"
            )}
          >
            <ShieldCheck className="h-[18px] w-[18px]" />
            Admin Portal
          </Link>
        )}
        <button
          type="button"
          onClick={handleLogout}
          disabled={loggingOut}
          aria-busy={loggingOut}
          className={clsx(
            "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all",
            loggingOut
              ? "cursor-not-allowed text-[#707070]/60"
              : "text-[#707070] hover:bg-white/5 hover:text-white"
          )}
        >
          <LogOut className="h-[18px] w-[18px]" />
          {loggingOut ? "Logging out…" : "Logout"}
        </button>
      </div>
    </aside>
  );
}
