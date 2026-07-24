"use client";

import { useMemo } from "react";
import { useStore } from "@/lib/store";
import { useLiveClock } from "@/lib/useLiveClock";
import { PulsingDot } from "@/components/ui/Primitives";
import { formatCompactDuration } from "@/lib/mockData";
import { Wifi } from "lucide-react";

export default function Header() {
  const user = useStore((s) => s.users[s.currentUserId]);
  const now = useLiveClock(1000);

  const uptimeLabel = useMemo(() => {
    if (!user?.participationApprovedAt) return null;
    const elapsed = now - new Date(user.participationApprovedAt).getTime();
    return formatCompactDuration(elapsed);
  }, [user?.participationApprovedAt, now]);

  return (
    <header className="sticky top-0 z-30 flex items-center justify-between border-b border-white/10 bg-[#121212]/80 px-4 py-4 backdrop-blur-xl sm:px-8">
      <div className="flex items-center gap-3">
        <Wifi className="hidden h-5 w-5 text-[#32B5FF] sm:block" />
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-white sm:text-base">
            <PulsingDot color="#22c55e" />
            Internet Connected to StarAtlas Network
            <span className="ml-1 rounded-full bg-green-500/15 px-2 py-0.5 text-[10px] font-bold tracking-wider text-green-400">
              LIVE
            </span>
          </div>
          {uptimeLabel && (
            <div className="mt-0.5 text-xs text-[#B0B0B0]">
              Uptime: <span className="font-mono text-[#32B5FF]">{uptimeLabel}</span>
            </div>
          )}
        </div>
      </div>

      <div className="hidden text-right sm:block">
        <div className="text-xs text-[#B0B0B0]">{user?.name}</div>
        <div className="text-[11px] text-[#707070]">{user?.email}</div>
      </div>
    </header>
  );
}
