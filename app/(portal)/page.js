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
import { useEarningsSummary } from "@/lib/useEarningsSummary";
import { useLiveClock } from "@/lib/useLiveClock";
import { useHasMounted } from "@/lib/useHasMounted";
import { notifyAccountChanged } from "@/lib/accountEvents";
import { useSteppedConnectionProgress } from "@/lib/useSteppedConnectionProgress";
import {
  formatCurrency,
  centsToDollars,
} from "@/lib/mockData";
import { GlassCard, SectionTitle, FadeIn } from "@/components/ui/Primitives";
import NodeTierBadge from "@/components/ui/NodeTierBadge";
import FluctuatingEarnings from "@/components/ui/FluctuatingEarnings";
import AnimatedNumber from "@/components/ui/AnimatedNumber";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import {
  TrendingUp,
  Sparkles,
  Info,
  Wifi,
  WifiOff,
  Server,
  ShieldCheck,
  CheckCircle2,
} from "lucide-react";

const RECONNECT_DURATION_MS = 20000; // exactly 20 seconds, per spec -- must match lib/wifiEngine.js
const RECONNECT_SUCCESS_COPY =
  "You have successfully connected to the Smart Income System. You may now resume your estimated earnings.";
const RECONNECT_PROGRESS_COPY = "Establishing a Secure Connection to the Smart Income System…";


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
            Your Bridge Isn&apos;t Earning Yet
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
// Restored continuous real-time display (removing the previous 4-hour
// display-freeze pass, see HERMES_PROGRESS.md): every customer-facing
// earnings figure on this Dashboard must visibly tick upward in real
// time, exactly as it did before the freeze was introduced. The
// underlying accounting engine (lib/earningsEngine.js -- catch-up
// ledger writes, midnight-Pacific cycle boundaries, WiFi-gating) is
// completely untouched by this restoration; only the client-side
// interpolation between polls (removed by the freeze) is brought back.
//
// WiFi off (including "reconnecting", which keeps wifiEnabled false
// server-side for the full 20-second window): never project further
// increase -- literally just the last server-confirmed total, no
// client-side addition at all.
//
// Returns { interpolatedTodayCents, lifetimeCents } so every Dashboard
// number that must move in lockstep with Live Earnings (the four summary
// cards AND each Bridge's live "Total Earnings" contribution) can derive
// from this ONE interpolation, never a second independently-computed
// live number that could drift out of sync.
//
// `hasMounted` gates the Date.now()-driven projection: before mount (i.e.
// during SSR and the first client render) this returns the static,
// summary-only totals (no live interpolation), so the server-rendered
// HTML and the first client render always agree. Once mounted, the live
// per-ms ticking projection kicks in.
function useLiveEarnings(summary, now, hasMounted) {
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
    if (!summary?.active) {
      return { interpolatedTodayCents: 0, lifetimeCents: 0 };
    }
    const lifetimePriorCents = summary.lifetimeEarningsCents || 0;
    const serverAccruedCents = summary.todayAccruedCents || 0;
    if (!hasMounted) {
      return {
        interpolatedTodayCents: serverAccruedCents,
        lifetimeCents: lifetimePriorCents + serverAccruedCents,
      };
    }

    // WiFi off (including "reconnecting", which keeps wifiEnabled false
    // server-side for the full 20-second window): never project further
    // increase -- literally just the last server-confirmed total, no
    // client-side addition at all.
    if (!summary.wifiEnabled) {
      return {
        interpolatedTodayCents: serverAccruedCents,
        lifetimeCents: lifetimePriorCents + serverAccruedCents,
      };
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

    return {
      interpolatedTodayCents,
      lifetimeCents: lifetimePriorCents + interpolatedTodayCents,
    };
  }, [summary, now, hasMounted, baseline]);
}

function WifiToggleCard({ summary, refetch }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  // Dashboard adjustment pass: `reconnecting` is DERIVED (not a
  // separately-synced effect+setState pair) from two sources OR'd
  // together: (1) `localReconnecting`, set true the instant this
  // component itself starts the flow (optimistic UI), and (2) the
  // server-persisted `summary.wifiReconnectStartedAt` (never a
  // client-only timer as the source of truth) so a refresh/re-mount
  // mid-flow resumes showing the modal correctly even though
  // `localReconnecting` reset to its initial `false` on remount. This
  // avoids a `useEffect` that calls `setState` synchronously purely to
  // mirror already-available prop/state data (an anti-pattern flagged by
  // the react-hooks/set-state-in-effect rule) -- deriving during render is
  // both simpler and correct here.
  const [localReconnecting, setLocalReconnecting] = useState(false);
  const [showSuccessModal, setShowSuccessModal] = useState(false);

  const eligible = summary?.ispStatus === "active" && Boolean(summary?.nodeConnectedAt);
  const enabled = Boolean(summary?.wifiEnabled);
  // `errorOverride`: force-hides the modal after a genuine completion
  // failure even if the server still reports wifiReconnectStartedAt set
  // (e.g. a transient error occurred after the 20s window itself elapsed
  // successfully server-side but the completion request failed) --
  // cleared the next time the customer starts a fresh attempt.
  const [errorOverride, setErrorOverride] = useState(false);
  const reconnecting =
    !errorOverride &&
    (localReconnecting || Boolean(summary?.wifiReconnectStartedAt && !enabled));

  async function handleToggleOff() {
    if (!eligible || pending) return;
    setError("");
    setPending(true);
    try {
      const res = await fetch("/api/wifi/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
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

  // Starts the 20-second reconnection flow: opens the progress modal
  // immediately (optimistic UI) and fires POST /api/wifi/reconnect/start
  // in the background to persist wifi_reconnect_started_at server-side.
  // Prevented from double-firing by both the `pending` guard and the
  // route's own idempotent "already in progress" handling.
  async function handleToggleOn() {
    if (!eligible || pending || reconnecting) return;
    setError("");
    setErrorOverride(false);
    setPending(true);
    try {
      const res = await fetch("/api/wifi/reconnect/start", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Unable to start reconnection.");
        return;
      }
      setLocalReconnecting(true);
      await refetch();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setPending(false);
    }
  }

  async function handleReconnectDone() {
    setLocalReconnecting(false);
    await refetch();
    notifyAccountChanged();
    setShowSuccessModal(true);
  }

  function handleReconnectError(message) {
    setLocalReconnecting(false);
    setErrorOverride(true);
    setError(message);
  }

  return (
    <>
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
            disabled={!eligible || pending || reconnecting}
            onClick={enabled ? handleToggleOff : handleToggleOn}
            className={`relative inline-flex h-7 w-14 flex-shrink-0 items-center rounded-full transition-colors ${
              enabled ? "bg-[#32B5FF]" : "bg-white/10"
            } ${
              !eligible || pending || reconnecting
                ? "cursor-not-allowed opacity-50"
                : "cursor-pointer"
            }`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                enabled ? "translate-x-8" : "translate-x-1.5"
              }`}
            />
          </button>
          <span className="font-mono text-lg font-bold text-white">
            {reconnecting ? "CONNECTING…" : enabled ? "ON" : "OFF"}
          </span>
        </div>
        <div className="text-xs text-[#707070]">
          {eligible ? (
            <>
              Disconnect your WiFi from the Smart Income System at any time. Disabling the
              connection will immediately pause earnings accrual. No earnings will be
              credited for the time your WiFi was disconnected.
            </>
          ) : (
            "WiFi control unlocks once ISP Setup is approved and your initial connection process is complete."
          )}
        </div>
        {error && <div className="text-xs text-red-400">{error}</div>}
      </GlassCard>

      <AnimatePresence>
        {reconnecting && (
          <ReconnectModal
            startedAt={summary?.wifiReconnectStartedAt}
            onDone={handleReconnectDone}
            onError={handleReconnectError}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {showSuccessModal && (
          <ReconnectSuccessModal onClose={() => setShowSuccessModal(false)} />
        )}
      </AnimatePresence>
    </>
  );
}

// 0% -> 100% "Establishing a Secure Connection..." progress modal for the
// OFF -> ON reconnection flow. Progress advances in exact discrete 5%
// steps once per second (0, 5, 10, ... 100) over exactly 20 seconds --
// driven by the shared lib/useSteppedConnectionProgress.js hook (see that
// file's header comment for the root-cause diagnosis of the previous
// "stuck at 0%" bug and the completion-reliability design: bounded
// automatic retries on transient/network failures, a single real wait+
// retry when the server reports the window hasn't fully elapsed yet, and
// "already connected" always treated as success). onDone() only ever
// fires after the visual timer AND the real backend completion call have
// both succeeded (never before). If the customer refreshes mid-flow,
// `startedAt` is re-derived from the server-persisted
// wifiReconnectStartedAt (via the parent's summary poll), so the visual
// bar resumes from the CORRECT step rather than restarting at 0%.
function ReconnectModal({ startedAt, onDone, onError }) {
  const { progress, retrying } = useSteppedConnectionProgress({
    active: true,
    startedAt,
    durationMs: RECONNECT_DURATION_MS,
    completeUrl: "/api/wifi/reconnect/complete",
    onDone,
    onError,
  });

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="w-full max-w-md rounded-2xl border border-[#32B5FF]/30 bg-[#1E1E1E] p-8 text-center"
      >
        <ShieldCheck className="mx-auto h-12 w-12 animate-pulse text-[#32B5FF]" />
        <h3 className="mt-4 text-base font-bold text-white">{RECONNECT_PROGRESS_COPY}</h3>
        <div className="mt-5 h-3 w-full overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-[#32B5FF] shadow-[0_0_12px_rgba(50,181,255,0.6)] transition-[width] duration-300 ease-linear"
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="mt-2 font-mono text-sm text-[#B0B0B0]">{progress}%</div>
        {retrying && (
          <div className="mt-2 text-xs text-[#707070]">Reconnecting to the server…</div>
        )}
      </motion.div>
    </motion.div>
  );
}

function ReconnectSuccessModal({ onClose }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-[#32B5FF]/30 bg-[#1E1E1E] p-6"
      >
        <div className="mb-3 flex items-center gap-2 text-[#32B5FF]">
          <CheckCircle2 className="h-6 w-6" />
          <h3 className="text-base font-bold text-white">Connected</h3>
        </div>
        <p className="text-sm text-[#B0B0B0]">{RECONNECT_SUCCESS_COPY}</p>
        <button
          onClick={onClose}
          className="mt-5 w-full rounded-xl bg-[#32B5FF] px-4 py-2.5 text-sm font-semibold text-[#06121a] hover:bg-[#4dc0ff]"
        >
          Understood
        </button>
      </motion.div>
    </motion.div>
  );
}

function YourNodesSection({ nodes, loading }) {
  return (
    <FadeIn delay={0.22}>
      <GlassCard className="overflow-hidden">
        <div className="flex items-center gap-2 border-b border-white/10 px-5 py-4">
          <Server className="h-4 w-4 text-[#32B5FF]" />
          <h3 className="text-sm font-semibold text-white">Your Bridges</h3>
        </div>
        {loading ? (
          <div className="px-5 py-6 text-xs text-[#707070]">Loading your Bridges…</div>
        ) : nodes.length === 0 ? (
          <div className="px-5 py-6 text-xs text-[#707070]">
            You don&apos;t own any Bridges yet. Complete ISP Setup to get your first Bridge.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-[#707070]">
                  <th className="px-4 py-3">Bridge ID</th>
                  <th className="px-4 py-3">Bridge Type</th>
                  <th className="px-4 py-3">Location</th>
                  <th className="px-4 py-3 text-right">Avg Daily Earnings</th>
                  <th className="px-4 py-3 text-right">Total Earnings</th>
                  <th className="px-4 py-3 text-right">Est. Monthly Earnings</th>
                </tr>
              </thead>
              <tbody>
                {nodes.map((node) => (
                  <tr
                    key={node.id || node.nodeId}
                    className="border-b border-white/5 text-[#B0B0B0]"
                  >
                    <td className="px-4 py-3 font-mono text-xs text-white">
                      #{node.displayNodeId || node.nodeId}
                    </td>
                    <td className="px-4 py-3">
                      <NodeTierBadge tierKey={node.tierKey} tier={node.tier} />
                    </td>
                    <td className="px-4 py-3 text-xs">{node.location || "—"}</td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-[#B0B0B0]">
                      {/* Avg Daily Earnings = this Node's canonical
                          totalEarningsCents / its canonical ON-duration
                          (lib/earningsEngine.js computeAvgDailyEarningsCents,
                          server-computed) -- always shown as a plain,
                          non-animated, exactly-2-decimal figure (never the
                          fluctuating display treatment used for estimated
                          rates) since it is a derived historical average,
                          not a live/projected number. */}
                      {formatCurrency(centsToDollars(node.avgDailyEarningsCents))}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-[#32B5FF]">
                      <AnimatedNumber
                        value={centsToDollars(node.totalEarningsCents)}
                        format="currencyTrimmed"
                        className="font-mono text-xs text-[#32B5FF]"
                      />
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-white">
                      {/* Display-only +/-5% visual fluctuation over the
                          stable server-supplied estMonthlyCents core
                          (see components/ui/FluctuatingEarnings.js) --
                          never the actual stored rate/ledger/accrual. */}
                      <FluctuatingEarnings coreCents={node.estMonthlyCents} />
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
    // Dashboard adjustment pass: re-fetch owned Bridges (and their live
    // "Total Earnings") on every earnings-summary poll (~every 15s, see
    // lib/useEarningsSummary.js), not just when `active` flips -- so the
    // per-Bridge Total Earnings column stays in sync with the rest of the
    // Dashboard's numbers instead of only updating when WiFi state
    // changes. Now driven directly by `summary` (the live-polled value)
    // since the 4-hour display freeze has been removed.
  }, [summary]);

  const { interpolatedTodayCents, lifetimeCents } = useLiveEarnings(summary, now, hasMounted);
  const todaysExpected = centsToDollars(summary?.todaysExpectedCents);

  // Dashboard adjustment pass: all four summary cards (Today/Week/Month/
  // Lifetime) now derive from the SAME `interpolatedTodayCents`/
  // `lifetimeCents` that drive the Live Earnings ticker -- never a
  // second, independently-computed number -- so they can never drift
  // apart from Live Earnings, and (with the 4-hour display freeze
  // removed) all four now tick upward continuously in real time exactly
  // in lockstep with the hero Live Earnings number.
  // Week/Month add the CURRENT in-progress cycle's live interpolated
  // amount on top of the completed-cycles total from the ledger (today's
  // cycle is never itself written to the ledger until it completes, so
  // without this addition "This Week"/"This Month" would silently
  // exclude today's live progress). `live` (the hero "Live Earnings"
  // number) IS `lifetimeCents` -- same value, just also bound to a local
  // name for readability at its render call site below.
  const live = centsToDollars(lifetimeCents);
  const today = centsToDollars(interpolatedTodayCents);
  const week = centsToDollars((summary?.weekEarningsCents || 0) + interpolatedTodayCents);
  const month = centsToDollars((summary?.monthEarningsCents || 0) + interpolatedTodayCents);
  const lifetime = centsToDollars(lifetimeCents);

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
        subtitle="Track your Bridge earnings and network performance."
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
                    format="currency"
                    className="font-mono text-4xl font-extrabold tracking-tight text-[#32B5FF] [text-shadow:0_0_18px_rgba(50,181,255,0.65),0_0_40px_rgba(50,181,255,0.35)] sm:text-5xl"
                  />
                  <div className="flex items-center gap-1.5 text-xs text-[#B0B0B0]">
                    <Info className="h-3 w-3" />
                    Today&apos;s expected earnings ~{formatCurrency(todaysExpected)}
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
                  Earnings Overview (Last 14 Days)
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
                    format="currency"
                    className="mt-2 block font-mono text-2xl font-bold text-white"
                  />
                </GlassCard>
              </FadeIn>
            ))}
          </div>

          {/* Your Nodes */}
          <YourNodesSection nodes={nodes} loading={nodesLoading} />
        </>
      )}
    </div>
  );
}
