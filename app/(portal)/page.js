"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import { useRouter } from "next/navigation";
import { useEarningsSummary } from "@/lib/useEarningsSummary";
import { useLiveClock } from "@/lib/useLiveClock";
import { useHasMounted } from "@/lib/useHasMounted";
import { notifyAccountChanged } from "@/lib/accountEvents";
import {
  formatCurrency,
  centsToDollars,
  formatCountdownParts,
} from "@/lib/mockData";
import { GlassCard, SectionTitle, FadeIn, Badge } from "@/components/ui/Primitives";
import AnimatedNumber from "@/components/ui/AnimatedNumber";
import Link from "next/link";
import {
  TrendingUp,
  Clock,
  Wallet,
  Sparkles,
  Info,
  Wifi,
  WifiOff,
  Server,
} from "lucide-react";

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-white/10 bg-[#1E1E1E]/95 px-3 py-2 text-xs shadow-xl backdrop-blur">
      <div className="text-[#B0B0B0]">{label}</div>
      <div className="font-semibold text-[#32B5FF]">
        {formatCurrency(payload[0].value)}
      </div>
    </div>
  );
}

function InactiveState() {
  return (
    <FadeIn>
      <GlassCard className="flex flex-col items-center justify-center gap-4 px-6 py-20 text-center">
        <Sparkles className="h-10 w-10 text-[#32B5FF]" />
        <div>
          <h2 className="text-xl font-bold text-white">
            Your Node Isn&apos;t Earning Yet
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-[#B0B0B0]">
            Complete your ISP Setup and get your participation approved to
            start earning.
          </p>
        </div>
        <Link
          href="/isp-setup"
          className="rounded-xl bg-[#32B5FF] px-5 py-2.5 text-sm font-semibold text-[#06121a] shadow-[0_0_20px_rgba(50,181,255,0.35)] hover:bg-[#4dc0ff]"
        >
          Go to ISP Setup
        </Link>
      </GlassCard>
    </FadeIn>
  );
}

// Live Earnings interpolates smoothly BETWEEN server polls. The server
// (lib/earningsEngine.js computeEarningsSummary) is the ONLY source of
// truth: `summary.lifetimeEarningsCents` is every completed prior cycle's
// real ledger total, and `summary.todayAccruedCents` is the current
// cycle's WiFi-gated accrual as of the last poll. This hook NEVER invents
// independent progress -- it only fills the small gap between polls by
// projecting forward from the server-confirmed `todayAccruedCents` at the
// same per-ms rate the server itself uses (`todaysExpectedCents` spread
// evenly across the full cycle duration), clamped so it can never exceed
// `todaysExpectedCents` and so it never drifts far ahead of what the next
// poll (every 15s -- see lib/useEarningsSummary.js) will confirm.
//
// Phase 5 correction (fixes the "jumps to full amount / freezes at ~$90"
// bug): the PREVIOUS implementation computed elapsedMs directly against
// wall-clock `now` and assumed a full, uninterrupted 24h day of uptime
// (`fractionOfDay = elapsedMs / 86400000`), completely ignoring
// `summary.wifiEnabled` and `summary.todayAccruedCents`. That is why it
// reached the full daily amount regardless of actual connected time (100%
// uptime assumption) and never responded to the WiFi toggle. The fix:
// interpolate forward from the server's own already-WiFi-gated
// `todayAccruedCents`, and freeze immediately (return the server-confirmed
// total with zero further addition) whenever `summary.wifiEnabled` is
// false.
//
// `hasMounted` gates the Date.now()-driven projection: before mount (i.e.
// during SSR and the first client render) this returns the static,
// summary-only total (no live interpolation), so the server-rendered HTML
// and the first client render always agree. Once mounted, the live
// per-second ticking projection kicks in.
function useLiveEarningsCents(summary, now, hasMounted) {
  const [baseline, setBaseline] = useState({ summary: null, atMs: 0 });

  useEffect(() => {
    // Records when this exact server-confirmed summary was first observed
    // so the interpolation below can compute "how long has it been since
    // the last poll" -- same fetch-on-change bookkeeping pattern used
    // elsewhere in this app (see lib/useAccount.js).
    if (summary) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- baseline bookkeeping, not a render-triggering side effect
      setBaseline({ summary, atMs: Date.now() });
    }
  }, [summary]);

  return useMemo(() => {
    if (!summary?.active) return 0;
    const priorDaysCents = summary.lifetimeEarningsCents || 0;
    const serverAccruedCents = summary.todayAccruedCents || 0;
    if (!hasMounted) return priorDaysCents + serverAccruedCents;

    // WiFi off: never project further increase while disconnected --
    // literally just the last server-confirmed total, no client-side
    // addition at all.
    if (!summary.wifiEnabled) {
      return priorDaysCents + serverAccruedCents;
    }

    const cycleStartMs = new Date(summary.todayStartAt).getTime();
    const cycleEndMs = summary.cycleEndAt
      ? new Date(summary.cycleEndAt).getTime()
      : cycleStartMs + 86400000;
    const cycleDurationMs = Math.max(1, cycleEndMs - cycleStartMs);

    // Baseline timestamp: the moment this exact `summary` object was
    // first observed (set by the effect above, stored in state so it's
    // safe to read during render). Falls back to `now` for the very
    // first render of a brand-new summary, which correctly yields zero
    // projected extra until the effect commits.
    const baselineAtMs = baseline.summary === summary ? baseline.atMs : now;
    const elapsedSincePollMs = Math.max(0, now - baselineAtMs);
    const ratePerMs = (summary.todaysExpectedCents || 0) / cycleDurationMs;
    const projectedExtraCents = elapsedSincePollMs * ratePerMs;

    const interpolatedTodayCents = Math.min(
      summary.todaysExpectedCents || 0,
      serverAccruedCents + projectedExtraCents
    );

    return priorDaysCents + interpolatedTodayCents;
  }, [summary, now, hasMounted, baseline]);
}

// Purely-visual "wobble" for the "Today's expected earnings ~$X (demo
// estimate)" line: re-rolls a fresh multiplier in [0.95, 1.05] every
// 5-10s. This is display-only jitter layered on top of the real
// server-computed todaysExpectedCents -- it never touches the ledger or
// any persisted value, and is gated behind hasMounted (via the caller)
// so SSR/first-client-render never disagree.
function useJitterMultiplier() {
  const [multiplier, setMultiplier] = useState(1);
  useEffect(() => {
    let timeoutId;
    function reroll() {
      const next = 1 + (Math.random() * 2 - 1) * 0.05; // +/-5%
      setMultiplier(next);
      const delayMs = 5000 + Math.random() * 5000; // 5-10s
      timeoutId = setTimeout(reroll, delayMs);
    }
    reroll();
    return () => clearTimeout(timeoutId);
  }, []);
  return multiplier;
}

function WifiToggleCard({ summary, refetch }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const eligible = summary?.ispStatus === "active" && Boolean(summary?.nodeConnectedAt);
  const enabled = Boolean(summary?.wifiEnabled);

  async function handleToggle() {
    if (!eligible || pending) return;
    setError("");
    setPending(true);
    try {
      const res = await fetch("/api/wifi/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !enabled }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Unable to update WiFi state.");
        return;
      }
      notifyAccountChanged();
      await refetch();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <GlassCard className="flex h-full flex-col justify-center gap-3 px-6 py-8">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-[#B0B0B0]">
        {enabled ? (
          <Wifi className="h-4 w-4 text-[#32B5FF]" />
        ) : (
          <WifiOff className="h-4 w-4 text-[#707070]" />
        )}
        WiFi Control
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          disabled={!eligible || pending}
          onClick={handleToggle}
          className={`relative inline-flex h-7 w-14 flex-shrink-0 items-center rounded-full transition-colors ${
            enabled ? "bg-[#32B5FF]" : "bg-white/10"
          } ${!eligible || pending ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
        >
          <span
            className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
              enabled ? "translate-x-8" : "translate-x-1.5"
            }`}
          />
        </button>
        <span className="font-mono text-lg font-bold text-white">
          {enabled ? "ON" : "OFF"}
        </span>
      </div>
      <div className="text-xs text-[#707070]">
        {eligible
          ? "Turning WiFi off freezes earnings accrual immediately; turning it back on resumes accrual (no retroactive credit for off time)."
          : "WiFi control unlocks once ISP Setup is approved and your initial connection process is complete."}
      </div>
      {error && <div className="text-xs text-red-400">{error}</div>}
    </GlassCard>
  );
}

function YourNodesSection({ nodes, loading }) {
  return (
    <FadeIn delay={0.22}>
      <GlassCard className="overflow-hidden">
        <div className="flex items-center gap-2 border-b border-white/10 px-5 py-4">
          <Server className="h-4 w-4 text-[#32B5FF]" />
          <h3 className="text-sm font-semibold text-white">Your Nodes</h3>
        </div>
        {loading ? (
          <div className="px-5 py-6 text-xs text-[#707070]">Loading your Nodes…</div>
        ) : nodes.length === 0 ? (
          <div className="px-5 py-6 text-xs text-[#707070]">
            You don&apos;t own any Nodes yet. Complete ISP Setup to get your first Node.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[600px] text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-[#707070]">
                  <th className="px-4 py-3">Node ID</th>
                  <th className="px-4 py-3">Node Type</th>
                  <th className="px-4 py-3">Location</th>
                  <th className="px-4 py-3 text-right">Est. Monthly Earnings</th>
                </tr>
              </thead>
              <tbody>
                {nodes.map((node) => (
                  <tr key={node.nodeId} className="border-b border-white/5 text-[#B0B0B0]">
                    <td className="px-4 py-3 font-mono text-xs text-white">#{node.nodeId}</td>
                    <td className="px-4 py-3">
                      <Badge tone={node.tier === "Super Node" ? "warning" : "accent"}>
                        {node.tier}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-xs">{node.location || "—"}</td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-white">
                      {formatCurrency(centsToDollars(node.estMonthlyCents))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </GlassCard>
    </FadeIn>
  );
}

export default function DashboardPage() {
  const { summary, loading, refetch } = useEarningsSummary(15000);
  const now = useLiveClock(100);
  const hasMounted = useHasMounted();
  const jitter = useJitterMultiplier();
  const router = useRouter();

  const [nodes, setNodes] = useState([]);
  const [nodesLoading, setNodesLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function loadNodes() {
      try {
        const res = await fetch("/api/nodes/owned", { cache: "no-store" });
        const data = await res.json();
        if (!cancelled) setNodes(data.nodes || []);
      } catch {
        if (!cancelled) setNodes([]);
      } finally {
        if (!cancelled) setNodesLoading(false);
      }
    }
    loadNodes();
    return () => {
      cancelled = true;
    };
  }, [summary?.active]);

  const liveCents = useLiveEarningsCents(summary, now, hasMounted);
  const live = centsToDollars(liveCents);
  const todaysExpectedRaw = centsToDollars(summary?.todaysExpectedCents);
  const todaysExpected = hasMounted ? todaysExpectedRaw * jitter : todaysExpectedRaw;
  const today = centsToDollars(summary?.todayAccruedCents);
  const week = centsToDollars(summary?.weekEarningsCents);
  const month = centsToDollars(summary?.monthEarningsCents);
  const lifetime = centsToDollars(summary?.lifetimeEarningsCents);

  // payoutMs depends on Date.now() (`now`) -- gate it behind hasMounted so
  // the server render and first client render both fall into the existing
  // `payoutMs == null` branch (which already renders "--"), and the real
  // countdown appears immediately after mount and ticks normally.
  //
  // Computed inline (not useMemo) -- the React Compiler auto-memoizes this
  // and its own dependency inference disagreed with an explicit dep array
  // that includes hasMounted/now.
  let payoutMs = null;
  if (hasMounted && summary?.payoutTargetAt) {
    payoutMs = Math.max(0, new Date(summary.payoutTargetAt).getTime() - now);
  }
  const payoutParts = payoutMs != null ? formatCountdownParts(payoutMs) : null;

  const series = useMemo(
    () =>
      (summary?.series || []).map((p) => ({
        label: p.label,
        value: p.value,
      })),
    [summary?.series]
  );

  if (loading) {
    return (
      <div className="space-y-6">
        <SectionTitle eyebrow="Overview" title="Dashboard" />
      </div>
    );
  }

  const active = Boolean(summary?.active);

  return (
    <div className="space-y-6">
      <SectionTitle
        eyebrow="Overview"
        title="Dashboard"
        subtitle="Track your live node earnings and network performance."
      />

      {!active ? (
        <InactiveState />
      ) : (
        <>
          {/* Live Earnings + WiFi Control */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
            <FadeIn>
              <GlassCard className="relative overflow-hidden px-6 py-8 sm:px-10 sm:py-10">
                <div
                  className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full opacity-20 blur-3xl"
                  style={{ background: "#32B5FF" }}
                />
                <div className="relative flex flex-col gap-2">
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-[#B0B0B0]">
                    <TrendingUp className="h-4 w-4 text-[#32B5FF]" />
                    Live Earnings
                  </div>
                  <AnimatedNumber
                    value={live}
                    format="currency5"
                    className="font-mono text-4xl font-extrabold tracking-tight text-[#32B5FF] [text-shadow:0_0_18px_rgba(50,181,255,0.65),0_0_40px_rgba(50,181,255,0.35)] sm:text-5xl"
                  />
                  <div className="flex items-center gap-1.5 text-xs text-[#B0B0B0]">
                    <Info className="h-3 w-3" />
                    Today&apos;s expected earnings ~{formatCurrency(todaysExpected)}
                    <span className="text-[#707070]">(demo estimate)</span>
                  </div>
                </div>
              </GlassCard>
            </FadeIn>

            <FadeIn delay={0.03}>
              <WifiToggleCard summary={summary} refetch={refetch} />
            </FadeIn>
          </div>

          {/* Graph */}
          <FadeIn delay={0.05}>
            <GlassCard className="p-4 sm:p-6">
              <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <h3 className="text-sm font-semibold text-white">
                  Earnings Overview (Last 14 Days — Ledger)
                </h3>
              </div>
              <div className="h-72 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={series} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="earningsGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#32B5FF" stopOpacity={0.5} />
                        <stop offset="100%" stopColor="#32B5FF" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                    <XAxis
                      dataKey="label"
                      stroke="#707070"
                      tick={{ fontSize: 11, fill: "#707070" }}
                      tickLine={false}
                      axisLine={false}
                      minTickGap={20}
                    />
                    <YAxis
                      stroke="#707070"
                      tick={{ fontSize: 11, fill: "#707070" }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v) => `$${v}`}
                      width={56}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Area
                      type="monotone"
                      dataKey="value"
                      stroke="#32B5FF"
                      strokeWidth={2.5}
                      fill="url(#earningsGradient)"
                      isAnimationActive
                      animationDuration={500}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </GlassCard>
          </FadeIn>

          {/* Summary Cards */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { label: "Today (1d)", value: today, delay: 0.08 },
              { label: "This Week (7d)", value: week, delay: 0.1 },
              { label: "This Month (30d)", value: month, delay: 0.15 },
              { label: "Total Earnings (Lifetime)", value: lifetime, delay: 0.2 },
            ].map((card) => (
              <FadeIn key={card.label} delay={card.delay}>
                <GlassCard className="p-5">
                  <div className="text-xs font-medium uppercase tracking-wide text-[#B0B0B0]">
                    {card.label}
                  </div>
                  <AnimatedNumber
                    value={card.value}
                    className="mt-2 block font-mono text-2xl font-bold text-white"
                  />
                </GlassCard>
              </FadeIn>
            ))}
          </div>

          {/* Your Nodes */}
          <YourNodesSection nodes={nodes} loading={nodesLoading} />

          {/* Next payout */}
          <FadeIn delay={0.3}>
            <GlassCard className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <div className="rounded-xl bg-[#32B5FF]/15 p-2.5">
                  <Clock className="h-5 w-5 text-[#32B5FF]" />
                </div>
                <div>
                  <div className="text-sm font-semibold text-white">Next Payout</div>
                  <div className="text-xs text-[#B0B0B0]">
                    Payouts run on a 4 month cycle from your Node connection
                    date.
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 sm:justify-end sm:gap-4">
                <div className="flex items-center gap-2">
                  {summary?.payoutAvailable ? (
                    <Badge tone="success">Payout Available</Badge>
                  ) : (
                    <>
                      <Wallet className="h-4 w-4 text-[#32B5FF]" />
                      {payoutParts ? (
                        <span className="font-mono text-sm font-bold text-white">
                          {payoutParts.months}mo {payoutParts.days}d {String(payoutParts.hours).padStart(2, "0")}h{" "}
                          {String(payoutParts.minutes).padStart(2, "0")}m {String(payoutParts.seconds).padStart(2, "0")}s
                        </span>
                      ) : (
                        <span className="font-mono text-sm font-bold text-white">--</span>
                      )}
                      <Badge tone="accent">remaining</Badge>
                    </>
                  )}
                </div>
                <button
                  type="button"
                  disabled={!summary?.payoutAvailable}
                  onClick={() => router.push("/withdrawals")}
                  className={`rounded-xl px-4 py-2 text-xs font-semibold transition ${
                    summary?.payoutAvailable
                      ? "bg-[#32B5FF] text-[#06121a] shadow-[0_0_20px_rgba(50,181,255,0.35)] hover:bg-[#4dc0ff]"
                      : "cursor-not-allowed bg-white/5 text-white/30"
                  }`}
                >
                  Withdrawal
                </button>
              </div>
            </GlassCard>
          </FadeIn>
        </>
      )}
    </div>
  );
}
