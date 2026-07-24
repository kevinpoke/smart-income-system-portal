"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
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
} from "lucide-react";

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
              <Icon
                className={clsx(
                  "h-[18px] w-[18px] transition-colors",
                  active ? "text-[#32B5FF]" : "text-[#B0B0B0] group-hover:text-white"
                )}
              />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="px-3 pb-4">
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
      </div>
    </aside>
  );
}
