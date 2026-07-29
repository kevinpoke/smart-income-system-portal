"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { Users, MessageSquare, ShieldCheck, FlaskConical } from "lucide-react";

const TABS = [
  { href: "/admin", label: "Users", icon: Users },
  { href: "/admin/chats", label: "Support Chats", icon: MessageSquare },
  { href: "/admin/isp-approvals", label: "ISP Approvals", icon: ShieldCheck },
  { href: "/admin/test", label: "Test", icon: FlaskConical },
];

export default function AdminLayout({ children }) {
  const pathname = usePathname();
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-6 w-6 text-[#32B5FF]" />
        <h1 className="text-2xl font-bold text-white">Admin Portal</h1>
      </div>
      <div className="flex gap-2 overflow-x-auto border-b border-white/10 pb-2">
        {TABS.map((tab) => {
          const active = pathname === tab.href;
          const Icon = tab.icon;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={clsx(
                "flex flex-shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-[#32B5FF]/15 text-[#32B5FF]"
                  : "text-[#B0B0B0] hover:bg-white/5 hover:text-white"
              )}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
            </Link>
          );
        })}
      </div>
      {children}
    </div>
  );
}
