"use client";

import { useAccount } from "@/lib/useAccount";
import { useLiveClock } from "@/lib/useLiveClock";
import { useHasMounted } from "@/lib/useHasMounted";
import { PulsingDot } from "@/components/ui/Primitives";
import { formatCompactDuration } from "@/lib/mockData";

// WiFi connection indicator is driven entirely by SQLite (via
// /api/auth/me), never by client-only state. "Connected" now requires
// BOTH isp_status === "active" (which only the customer's own "I
// Approve" action can set -- see app/api/isp/authorize) AND the
// customer's own WiFi toggle being on (wifiEnabled) -- Phase 5's
// on/off control must be reflected here too, not just the one-way ISP
// activation flag. useAccount() already refetches on every mount and on
// every accountEvents broadcast, so this stays in sync (and keeps
// pulsing) across page loads and WiFi toggle flips without a hard
// refresh.
export default function Header() {
  const { account: user } = useAccount();
  const now = useLiveClock(1000);
  const hasMounted = useHasMounted();

  const connected = user?.ispStatus === "active" && Boolean(user?.wifiEnabled);

  // Uptime is derived from Date.now() (via useLiveClock), which necessarily
  // differs between the server render and the first client render -- the
  // server has no way to know "now" at the moment the browser paints. Gate
  // the live value behind hasMounted so both the server-rendered HTML and
  // React's first client render agree (uptimeLabel === null, nothing
  // rendered); the real duration then appears immediately after mount and
  // ticks every second from useLiveClock's 1s interval.
  //
  // Computed inline (not useMemo) -- the React Compiler auto-memoizes this
  // and its own dependency inference disagreed with an explicit dep array
  // here (it doesn't count `hasMounted`/`now` the way a manual array does).
  let uptimeLabel = null;
  if (hasMounted && connected && user?.nodeConnectedAt) {
    const elapsed = now - new Date(user.nodeConnectedAt).getTime();
    uptimeLabel = formatCompactDuration(elapsed);
  }

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
