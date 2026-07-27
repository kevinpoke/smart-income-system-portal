"use client";

import { useMemo } from "react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import { useEarningsSummary } from "@/lib/useEarningsSummary";
import { useLiveClock } from "@/lib/useLiveClock";
import {
  formatCurrency,
  centsToDollars,
  formatLongDuration,
} from "@/lib/mockData";
import { GlassCard, SectionTitle, FadeIn, Badge } from "@/components/ui/Primitives";
import AnimatedNumber from "@/components/ui/AnimatedNumber";
import Link from "next/link";
import { TrendingUp, Clock, Wallet, Sparkles, Info } from "lucide-react";

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

// Live Earnings interpolates smoothly BETWEEN server polls: we know the
// server-confirmed total as of `todayStartAt` (which is always $0 baseline
// for "today's" contribution, since today's ledger row is intentionally
// never written until it's no longer "today" -- see
// lib/earningsEngine.js) plus lifetime prior-days total. Between polls we
// linearly project today's expected amount by elapsed fraction of the day,
// which is exactly the same "expected daily estimate" the dashboard labels
// as such -- it never invents money that isn't backed by either a written
// ledger row (prior days) or the clearly-labeled today's-estimate rule.
function useLiveEarningsCents(summary, now) {
  return useMemo(() => {
    if (!summary?.active) return 0;
    const priorDaysCents = summary.lifetimeEarningsCents || 0;
    const todayStart = new Date(summary.todayStartAt).getTime();
    // Never project earnings before the Node's actual connection moment,
    // even on the very first (partial) day of activation.
    const connectedAt = summary.nodeConnectedAt ? new Date(summary.nodeConnectedAt).getTime() : todayStart;
    const accrualStart = Math.max(todayStart, connectedAt);
    const elapsedMs = Math.max(0, now - accrualStart);
    const fractionOfDay = Math.min(1, elapsedMs / 86400000);
    const todayProjectedCents = (summary.todaysExpectedCents || 0) * fractionOfDay;
    return priorDaysCents + todayProjectedCents;
  }, [summary, now]);
}

export default function DashboardPage() {
  const { summary, loading } = useEarningsSummary(15000);
  const now = useLiveClock(100);

  const liveCents = useLiveEarningsCents(summary, now);
  const live = centsToDollars(liveCents);
  const todaysExpected = centsToDollars(summary?.todaysExpectedCents);
  const averageDaily = centsToDollars(summary?.averageDailyCents);
  const week = centsToDollars(summary?.weekEarningsCents);
  const month = centsToDollars(summary?.monthEarningsCents);
  const lifetime = centsToDollars(summary?.lifetimeEarningsCents);
  const balance = centsToDollars(summary?.currentBalanceCents);

  const payoutMs = useMemo(() => {
    if (!summary?.payoutTargetAt) return null;
    return Math.max(0, new Date(summary.payoutTargetAt).getTime() - now);
  }, [summary?.payoutTargetAt, now]);

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
          {/* Live Earnings + Average Daily Earnings */}
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
              <GlassCard className="flex h-full flex-col justify-center gap-2 px-6 py-8">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-[#B0B0B0]">
                  <TrendingUp className="h-4 w-4 text-[#32B5FF]" />
                  Average Daily Earnings
                </div>
                <AnimatedNumber
                  value={averageDaily}
                  className="font-mono text-3xl font-bold text-white"
                />
                <div className="text-xs text-[#707070]">
                  Ledger-based average across {summary?.completedDays ?? 0} completed day
                  {summary?.completedDays === 1 ? "" : "s"} (demo estimate).
                </div>
              </GlassCard>
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
              { label: "This Week (7d)", value: week, delay: 0.1 },
              { label: "This Month (30d)", value: month, delay: 0.15 },
              { label: "Total Earnings (Lifetime)", value: lifetime, delay: 0.2 },
              { label: "Current Balance", value: balance, delay: 0.25 },
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

          {/* Next payout */}
          <FadeIn delay={0.3}>
            <GlassCard className="flex flex-col items-start justify-between gap-3 p-5 sm:flex-row sm:items-center">
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
              <div className="flex items-center gap-2">
                {summary?.payoutAvailable ? (
                  <Badge tone="success">Payout Available</Badge>
                ) : (
                  <>
                    <Wallet className="h-4 w-4 text-[#32B5FF]" />
                    <span className="font-mono text-lg font-bold text-white">
                      {payoutMs != null ? formatLongDuration(payoutMs) : "--"}
                    </span>
                    <Badge tone="accent">remaining</Badge>
                  </>
                )}
              </div>
            </GlassCard>
          </FadeIn>
        </>
      )}
    </div>
  );
}
