"use client";

import { useMemo } from "react";
import { useStore } from "@/lib/store";
import { generatePayoutHistory, generateNodeLocation, rngFromSeed, formatCurrency } from "@/lib/mockData";
import { GlassCard, SectionTitle, FadeIn, Badge } from "@/components/ui/Primitives";
import { MapPin, TrendingUp } from "lucide-react";

export default function PayoutsPage() {
  const user = useStore((s) => s.users[s.currentUserId]);

  const seed = useMemo(
    () => Math.floor(new Date(user?.joinDate || Date.now()).getTime() / 1000),
    [user?.joinDate]
  );

  const rows = useMemo(
    () => (user?.joinDate ? generatePayoutHistory(seed, user.joinDate) : []),
    [seed, user?.joinDate]
  );

  const location = useMemo(() => generateNodeLocation(rngFromSeed(seed + 7)), [seed]);

  const average = useMemo(() => {
    if (!rows.length) return 0;
    return rows.reduce((sum, r) => sum + r.amount, 0) / rows.length;
  }, [rows]);

  return (
    <div className="space-y-6">
      <SectionTitle
        eyebrow="Historical Data"
        title="Payouts"
        subtitle="See what nodes near you have historically earned."
      />

      <FadeIn>
        <GlassCard className="flex flex-col items-start justify-between gap-3 p-5 sm:flex-row sm:items-center">
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-[#32B5FF]/15 p-2.5">
              <MapPin className="h-5 w-5 text-[#32B5FF]" />
            </div>
            <div>
              <div className="text-sm font-semibold text-white">
                Average Payout for {location}
              </div>
              <div className="text-xs text-[#B0B0B0]">
                Based on the last 14 months of node activity in your area.
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 font-mono text-2xl font-bold text-[#32B5FF]">
            <TrendingUp className="h-5 w-5" />
            {formatCurrency(average)}
          </div>
        </GlassCard>
      </FadeIn>

      <FadeIn delay={0.05}>
        <GlassCard className="overflow-hidden">
          <div className="border-b border-white/10 px-5 py-4">
            <h3 className="text-sm font-semibold text-white">
              Previous Payouts in Your Area
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-[#707070]">
                  <th className="px-5 py-3">Month</th>
                  <th className="px-5 py-3">Location</th>
                  <th className="px-5 py-3 text-right">Amount</th>
                  <th className="px-5 py-3 text-right">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-white/5 text-[#B0B0B0] transition hover:bg-white/[0.03]"
                  >
                    <td className="px-5 py-3 text-white">{row.month}</td>
                    <td className="px-5 py-3">{location}</td>
                    <td className="px-5 py-3 text-right font-mono text-white">
                      {formatCurrency(row.amount)}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <Badge tone="success">Paid</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </GlassCard>
      </FadeIn>
    </div>
  );
}
