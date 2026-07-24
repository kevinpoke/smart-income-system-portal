"use client";

import { useMemo, useState } from "react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import { motion } from "framer-motion";
import { useStore } from "@/lib/store";
import { useLiveClock } from "@/lib/useLiveClock";
import {
  GRAPH_RANGES,
  generateEarningsSeries,
  formatCurrency,
  formatLongDuration,
} from "@/lib/mockData";
import {
  totalEarnings,
  todayEarnings,
  weekEarnings,
  monthEarnings,
  isEarningActive,
  msUntilNextPayout,
} from "@/lib/earnings";
import { GlassCard, SectionTitle, FadeIn, Badge } from "@/components/ui/Primitives";
import AnimatedNumber from "@/components/ui/AnimatedNumber";
import Link from "next/link";
import { TrendingUp, Clock, Wallet, Sparkles } from "lucide-react";

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
            start the live earnings ticker and uptime clock.
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

export default function DashboardPage() {
  const user = useStore((s) => s.users[s.currentUserId]);
  const now = useLiveClock(100);
  const [range, setRange] = useState("7d");

  const active = isEarningActive(user);
  const live = totalEarnings(user, now);
  const today = todayEarnings(user, now);
  const week = weekEarnings(user, now);
  const month = monthEarnings(user, now);

  const series = useMemo(() => {
    if (!active) return [];
    return generateEarningsSeries(range, user.dailyRate, user.joinDate, live);
  }, [range, active, user?.dailyRate, user?.joinDate, Math.floor(live)]);

  const payoutMs = msUntilNextPayout(user, now);

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
          {/* Live Earnings Ticker */}
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
                  className="font-mono text-5xl font-extrabold tracking-tight text-white sm:text-6xl"
                />
                <div className="text-sm text-[#B0B0B0]">
                  Earning at ~{formatCurrency(user.dailyRate)}/day
                </div>
              </div>
            </GlassCard>
          </FadeIn>

          {/* Graph */}
          <FadeIn delay={0.05}>
            <GlassCard className="p-4 sm:p-6">
              <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <h3 className="text-sm font-semibold text-white">
                  Earnings Overview
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  {GRAPH_RANGES.map((r) => (
                    <button
                      key={r.key}
                      onClick={() => setRange(r.key)}
                      className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                        range === r.key
                          ? "bg-[#32B5FF] text-[#06121a]"
                          : "bg-white/5 text-[#B0B0B0] hover:bg-white/10 hover:text-white"
                      }`}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
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
              { label: "Today's Earnings", value: today, delay: 0.1 },
              { label: "This Week (7d)", value: week, delay: 0.15 },
              { label: "This Month (30d)", value: month, delay: 0.2 },
              { label: "All-Time Total", value: live, delay: 0.25 },
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
                    Payouts run on a 4.1 month cycle from your approval date.
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Wallet className="h-4 w-4 text-[#32B5FF]" />
                <span className="font-mono text-lg font-bold text-white">
                  {payoutMs != null ? formatLongDuration(payoutMs) : "--"}
                </span>
                <Badge tone="accent">remaining</Badge>
              </div>
            </GlassCard>
          </FadeIn>
        </>
      )}
    </div>
  );
}
