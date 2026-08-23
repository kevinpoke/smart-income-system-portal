"use client";

// Admin Analytics batch: extracted verbatim (logic and markup unchanged)
// from the former AnalyticsTab() component that used to live inline in
// app/(portal)/admin/chats/page.js as a tab inside Support Chats. Moved
// here so it can be rendered from its own dedicated top-level
// /admin/analytics page instead of living inside Support Chats (per
// spec: "Analytics must NOT be inside Support Chats"). No calculation
// logic was rewritten -- this still fetches the exact same single
// server-side aggregate payload from /api/admin/support/analytics
// (route path intentionally left unchanged; only where the UI mounts
// this component moved).
import { useCallback, useEffect, useMemo, useState } from "react";
import { GlassCard } from "@/components/ui/Primitives";
import { BarChart3 } from "lucide-react";
import clsx from "clsx";

function formatDurationMs(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function StatCard({ label, value, sub, className = "" }) {
  return (
    <div className={clsx("rounded-xl border border-white/10 bg-white/[0.03] p-3.5", className)}>
      <div className="text-[11px] font-medium uppercase tracking-wide text-[#707070]">{label}</div>
      <div className="mt-1 text-2xl font-bold text-white">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-[#B0B0B0]">{sub}</div>}
    </div>
  );
}

const PERIOD_OPTIONS = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "last3", label: "Last 3 Days" },
  { value: "lastweek", label: "Last Week" },
  { value: "lastmonth", label: "Last Month" },
  { value: "custom", label: "Custom" },
];

// Fetches ONE server-side aggregate payload from
// /api/admin/support/analytics -- never fetches raw account/message rows
// for client-side computation (per the spec's "ANALYTICS PERFORMANCE"
// requirement, unchanged from the original implementation).
export default function AnalyticsPanel() {
  const [period, setPeriod] = useState("lastweek");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [data, setData] = useState(null);
  const [status, setStatus] = useState("loading"); // loading | ready | error
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setStatus((s) => (s === "ready" ? s : "loading"));
    try {
      const params = new URLSearchParams();
      params.set("period", period);
      if (period === "custom") {
        if (customStart) params.set("start", customStart);
        if (customEnd) params.set("end", customEnd);
      }
      const res = await fetch(`/api/admin/support/analytics?${params.toString()}`, {
        cache: "no-store",
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || "Unable to load analytics.");
        setStatus("error");
        return;
      }
      setData(json);
      setError("");
      setStatus("ready");
    } catch {
      setError("Something went wrong loading analytics.");
      setStatus("error");
    }
  }, [period, customStart, customEnd]);

  useEffect(() => {
    // fetch-on-mount / on-filter-change, same pattern as the rest of this page.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const responseTimeText = useMemo(() => {
    if (!data?.responseTime) return null;
    if (data.responseTime.error) return data.responseTime.error;
    if (data.responseTime.avgMs == null) return "No manually-answered conversations in this period yet.";
    return `${formatDurationMs(data.responseTime.avgMs)} — Based on ${data.responseTime.count} ${
      data.responseTime.count === 1 ? "reply" : "replies"
    }`;
  }, [data]);

  return (
    <GlassCard className="p-5">
      <div className="mb-4 flex items-center gap-2">
        <BarChart3 className="h-4 w-4 text-[#32B5FF]" />
        <h3 className="text-sm font-semibold text-white">Support Analytics</h3>
      </div>

      {status === "error" && (
        <div className="mb-4 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <StatCard label="Total Members" value={data ? data.totalMembers : "—"} />
        <StatCard
          label="Logged In At Least Once"
          value={data ? data.loggedInAtLeastOnce : "—"}
          sub={data ? `${data.loggedInAtLeastOnce} / ${data.totalMembers} · ${data.loggedInPct}%` : undefined}
        />
        <StatCard
          label="ISP Applications Submitted"
          value={data ? data.ispSubmitted : "—"}
          sub={
            data
              ? `${data.ispSubmitted} / ${data.loggedInAtLeastOnce} · ${data.ispSubmittedPct}%`
              : undefined
          }
        />
        <StatCard
          label="ISP Approved / Activated"
          value={data ? data.ispApprovedActivated : "—"}
          sub={
            data
              ? `${data.ispApprovedActivated} / ${data.loggedInAtLeastOnce} · ${data.ispApprovedActivatedPct}%`
              : undefined
          }
        />
        <StatCard
          label="Bridge Waitlist"
          value={data ? data.bridgeWaitlist : "—"}
          sub={
            data
              ? `${data.bridgeWaitlistPctOfTotal}% of Total · ${data.bridgeWaitlistPctOfLoggedIn}% of Logged-In`
              : undefined
          }
        />
        <StatCard label="Disabled Users" value={data ? data.disabledUsers : "—"} />
        <StatCard label="Module Timer Removed" value={data ? data.moduleTimerRemoved : "—"} />
        <StatCard label="Balance Increased" value={data ? data.balanceIncreased : "—"} />
      </div>

      <div className="mt-5 rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="text-[11px] font-medium uppercase tracking-wide text-[#707070]">
            Average Support Response Time
          </div>
          <div className="flex flex-wrap gap-1.5">
            {PERIOD_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setPeriod(opt.value)}
                className={clsx(
                  "rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors",
                  period === opt.value
                    ? "bg-[#32B5FF] text-[#06121a]"
                    : "bg-white/5 text-[#B0B0B0] hover:bg-white/10"
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        {period === "custom" && (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <label className="text-[11px] text-[#B0B0B0]">
              Start
              <input
                type="date"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
                className="ml-1.5 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-white outline-none focus:ring-1 focus:ring-[#32B5FF]"
              />
            </label>
            <label className="text-[11px] text-[#B0B0B0]">
              End
              <input
                type="date"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
                className="ml-1.5 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-white outline-none focus:ring-1 focus:ring-[#32B5FF]"
              />
            </label>
            <button
              onClick={load}
              className="rounded-lg bg-[#32B5FF]/20 px-2.5 py-1 text-[11px] font-medium text-[#32B5FF] hover:bg-[#32B5FF]/30"
            >
              Apply
            </button>
          </div>
        )}
        <div className="text-xl font-bold text-white">{responseTimeText || "—"}</div>
      </div>
    </GlassCard>
  );
}
