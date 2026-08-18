"use client";

import { useEffect, useState } from "react";
import { formatCurrency, centsToDollars } from "@/lib/mockData";
import { GlassCard, SectionTitle, FadeIn, Badge, LocationRequiredCard } from "@/components/ui/Primitives";
import { MapPin, TrendingUp, Info } from "lucide-react";

// Fully SQLite-backed payout estimates page. Location comes from the
// authenticated customer's own ISP setup (isp_city/isp_state); estimate
// rows are deterministic per account+month from /api/payouts/estimates.
// Nothing here reads from or writes to Zustand/localStorage, and nothing
// here touches the earnings ledger.
//
// Refinement pass: the locked/unlocked decision comes directly from the
// server's `locked` field (see lib/moduleAccess.js
// hasPayoutsNodesAccess() -- ISP fully active AND city+state both on
// file). This is DELIBERATELY independent of the admin's per-customer
// "Unlock All Modules" override, which affects training videos only and
// must never unlock Payouts.
export default function PayoutsPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/payouts/estimates", { cache: "no-store" });
        const json = await res.json();
        if (!cancelled) setData(json);
      } catch {
        if (!cancelled) setData({ locked: true, rows: [], location: null });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = data?.rows || [];
  const location = data?.location || null;
  const locked = Boolean(data?.locked);

  const average = rows.length
    ? rows.reduce((sum, r) => sum + centsToDollars(r.amountCents), 0) / rows.length
    : 0;

  return (
    <div className="space-y-6">
      <SectionTitle
        eyebrow="Historical Data"
        title="Payouts"
        subtitle="See what bridges near you have historically earned."
      />

      {!loading && locked && (
        <LocationRequiredCard body="Complete your ISP Setup to see payout estimates for your area." />
      )}

      {(loading || !locked) && (
        <FadeIn>
          <GlassCard className="flex flex-col items-start justify-between gap-3 p-5 sm:flex-row sm:items-center">
            <div className="flex items-center gap-3">
              <div className="rounded-xl bg-[#32B5FF]/15 p-2.5">
                <MapPin className="h-5 w-5 text-[#32B5FF]" />
              </div>
              <div>
                <div className="text-sm font-semibold text-white">
                  {loading ? "Loading location…" : `Average Payout for ${location || "Your Area"}`}
                </div>
                <div className="text-xs text-[#B0B0B0]">
                  Based on the last 12 months of bridge activity in your area.
                </div>
              </div>
            </div>
            {!loading && (
              <div className="flex items-center gap-2 font-mono text-2xl font-bold text-[#32B5FF]">
                <TrendingUp className="h-5 w-5" />
                {formatCurrency(average)}
              </div>
            )}
          </GlassCard>
        </FadeIn>
      )}

      {!locked && (
        <FadeIn delay={0.05}>
          <GlassCard className="overflow-hidden">
            <div className="border-b border-white/10 px-5 py-4">
              <h3 className="text-sm font-semibold text-white">
                Average Payouts in Your Area
              </h3>
              <p className="mt-1 flex items-start gap-1.5 text-xs text-[#B0B0B0]">
                <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-[#32B5FF]" />
                These amounts are based on the average monthly user earnings
                in your area. Actual payouts are issued every four months.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-[#707070]">
                    <th className="px-5 py-3">Month</th>
                    <th className="px-5 py-3">Location</th>
                    <th className="px-5 py-3 text-right">Average Earnings</th>
                    <th className="px-5 py-3 text-right">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.id}
                      className="border-b border-white/5 text-[#B0B0B0] transition hover:bg-white/[0.03]"
                    >
                      <td className="px-5 py-3 text-white">{row.monthLabel}</td>
                      <td className="px-5 py-3">{location || "Your Area"}</td>
                      <td className="px-5 py-3 text-right font-mono text-white">
                        {formatCurrency(centsToDollars(row.amountCents))}
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
      )}
    </div>
  );
}
