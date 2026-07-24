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
} from "lucide-react";

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
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 flex items-center justify-around border-t border-white/10 bg-[#161616]/95 px-1 py-2 backdrop-blur-xl lg:hidden">
      {NAV_ITEMS.map((item) => {
        const active = pathname === item.href;
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={clsx(
              "flex flex-col items-center gap-0.5 rounded-lg px-2 py-1 text-[10px] font-medium",
              active ? "text-[#32B5FF]" : "text-[#707070]"
            )}
          >
            <Icon className="h-5 w-5" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
