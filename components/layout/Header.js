"use client";

import { useMemo } from "react";
import { useAccount } from "@/lib/useAccount";
import { useLiveClock } from "@/lib/useLiveClock";
import { PulsingDot } from "@/components/ui/Primitives";
import { formatCompactDuration } from "@/lib/mockData";

// WiFi connection indicator is driven entirely by isp_status from SQLite
// (via /api/auth/me), never by client-only state. Only isp_status ===
// "active" (which only the customer's own "I Approve" action can set --
// see app/api/isp/authorize) shows the green/connected state; every other
// status (not_started, pending_review, approved_awaiting_user) shows the
// red/disconnected state, matching the Phase 2 requirement that admin
// approval alone must not flip the header to connected.
export default function Header() {
  const { account: user } = useAccount();
  const now = useLiveClock(1000);

  const connected = user?.ispStatus === "active";

  const uptimeLabel = useMemo(() => {
    if (!connected || !user?.nodeConnectedAt) return null;
    const elapsed = now - new Date(user.nodeConnectedAt).getTime();
    return formatCompactDuration(elapsed);
  }, [connected, user?.nodeConnectedAt, now]);

  return (
    <header className="sticky top-0 z-30 flex items-center justify-between border-b border-white/10 bg-[#121212]/80 px-4 py-4 backdrop-blur-xl sm:px-8">
      <div className="flex items-center gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-white sm:text-base">
            {connected ? (
              <PulsingDot color="#22c55e" />
            ) : (
              <span
                role="img"
                aria-label="Disconnected"
                className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500"
              />
            )}
            <span aria-live="polite">
              {connected
                ? "WiFi Connected to StarAtlas Network"
                : "WiFi Not Connected to StarAtlas Network"}
            </span>
            {connected && (
              <span className="ml-1 rounded-full bg-green-500/15 px-2 py-0.5 text-[10px] font-bold tracking-wider text-green-400">
                LIVE
              </span>
            )}
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
