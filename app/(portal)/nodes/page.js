"use client";

import { useEffect, useState } from "react";
import { useAccount } from "@/lib/useAccount";
import { formatCurrency, centsToDollars, US_STATES } from "@/lib/mockData";
import { OTHER_STATE_CODE } from "@/lib/locationNormalize";
import { useWaitlistStatus } from "@/lib/useWaitlistStatus";
import {
  GlassCard,
  SectionTitle,
  FadeIn,
  LocationRequiredCard,
} from "@/components/ui/Primitives";
import NodeTierBadge from "@/components/ui/NodeTierBadge";
import FluctuatingEarnings from "@/components/ui/FluctuatingEarnings";
import { Server, Zap, Clock3, CheckCircle2, Sparkles, ImageOff } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";

// BRIDGES-REDESIGN batch: exact required headline/CTA/messages, preserved
// verbatim -- only this file references these strings.
const SOLD_OUT_HEADLINE = "All Bridges are Currently Sold Out!";
const JOIN_SUCCESS_MESSAGE =
  "You have joined the waitlist! If you are selected through our waitlist lottery system, you will have a chance to purchase and add additional bridges to your account.";
const JOINED_BANNER_MESSAGE =
  "You have joined the Waitlist! If selected, your dedicated support member will reach out to you with bridge availability.";

// PART I (future video support): no video yet -- a clean, swappable
// placeholder. A future video just replaces this block with a player
// component; nothing else in this file needs to change.
function SoldOutPlaceholder() {
  return (
    <div className="flex aspect-video flex-col items-center justify-center gap-3 rounded-xl bg-gradient-to-br from-[#1c2a33] to-[#0e1a20] px-6 text-center">
      <ImageOff className="h-12 w-12 text-[#32B5FF]" />
      <h2 className="text-lg font-bold text-white sm:text-xl">{SOLD_OUT_HEADLINE}</h2>
    </div>
  );
}

// PART D: State/Other selector mirrors ISP Setup's exact pattern (same
// US_STATES list, same OTHER_STATE_CODE sentinel, same custom-region
// requirement when Other is selected).
function WaitlistForm({ onSubmit, submitting, error }) {
  const [state, setState] = useState("");
  const [stateOther, setStateOther] = useState("");
  const [zip, setZip] = useState("");
  const isOther = state === OTHER_STATE_CODE;

  function handleSubmit(e) {
    e.preventDefault();
    onSubmit({ state, stateOther, zip });
  }

  const inputClass =
    "w-full rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 text-sm text-white placeholder-[#707070] outline-none transition focus:border-[#32B5FF]/60 focus:ring-1 focus:ring-[#32B5FF]/60";

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-[#B0B0B0]">State / Region</span>
        <select
          value={state}
          onChange={(e) => setState(e.target.value)}
          required
          className={inputClass}
        >
          <option value="" disabled>
            Select a state
          </option>
          {US_STATES.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
          <option value={OTHER_STATE_CODE}>Other</option>
        </select>
      </label>
      {isOther && (
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-[#B0B0B0]">
            State / Province / Region / Territory
          </span>
          <input
            type="text"
            value={stateOther}
            onChange={(e) => setStateOther(e.target.value)}
            required
            placeholder="e.g. Panama, British Columbia"
            className={inputClass}
          />
        </label>
      )}
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-[#B0B0B0]">ZIP / Postal Code</span>
        <input
          type="text"
          value={zip}
          onChange={(e) => setZip(e.target.value)}
          required
          className={inputClass}
        />
      </label>
      {error && (
        <div className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</div>
      )}
      <button
        type="submit"
        disabled={submitting}
        className={`flex w-full items-center justify-center gap-2 rounded-xl px-6 py-4 text-base font-extrabold tracking-wide text-white transition-all ${
          submitting
            ? "cursor-not-allowed bg-green-700/50"
            : "bg-green-600 shadow-[0_0_30px_rgba(34,197,94,0.5)] hover:bg-green-500 active:scale-[0.98]"
        }`}
      >
        {submitting ? "Submitting\u2026" : "Confirm Waitlist Spot"}
      </button>
    </form>
  );
}

// Pre-join popup/overlay: placeholder card + "Join the Waitlist" CTA,
// which reveals the State/ZIP form (PART D/E) in place.
function PreJoinOverlay({ onJoin, joining, error }) {
  const [showForm, setShowForm] = useState(false);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 z-20 flex items-start justify-center p-4 pt-6 sm:pt-8"
    >
      <motion.div
        initial={{ scale: 0.96, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="w-full max-w-xl rounded-2xl border border-[#32B5FF]/30 bg-[#1E1E1E] p-6 shadow-[0_0_60px_rgba(50,181,255,0.25)] sm:p-8"
      >
        <SoldOutPlaceholder />
        {!showForm ? (
          <button
            onClick={() => setShowForm(true)}
            className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-green-600 px-6 py-4 text-base font-extrabold tracking-wide text-white shadow-[0_0_30px_rgba(34,197,94,0.5)] transition-all hover:bg-green-500 active:scale-[0.98]"
          >
            <Clock3 className="h-5 w-5" />
            Join the Waitlist
          </button>
        ) : (
          <div className="mt-6">
            <WaitlistForm onSubmit={onJoin} submitting={joining} error={error} />
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}

// Post-join confirmation panel -- shown once, immediately after a
// successful join in THIS session.
function ConfirmationOverlay({ onClose }) {
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
        </div>
        <p className="text-sm text-[#B0B0B0]">{JOIN_SUCCESS_MESSAGE}</p>
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

// PART G: prominent/glowing banner shown at the TOP once joined.
function JoinedBanner() {
  return (
    <FadeIn>
      <div className="rounded-2xl border border-[#32B5FF]/40 bg-[#32B5FF]/[0.08] p-4 shadow-[0_0_30px_rgba(50,181,255,0.25)]">
        <div className="flex items-center gap-2 text-sm font-semibold text-[#32B5FF]">
          <CheckCircle2 className="h-5 w-5" />
          {JOINED_BANNER_MESSAGE}
        </div>
      </div>
    </FadeIn>
  );
}

export default function NodesPage() {
  const { loading: accountLoading } = useAccount();
  const [nodes, setNodes] = useState([]);
  const [locked, setLocked] = useState(true);
  const [loading, setLoading] = useState(true);

  const { status, refetch } = useWaitlistStatus(5000);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState("");
  // Shows the confirmation panel immediately after a successful join in
  // THIS session; a pre-existing joined member never sees this unprompted.
  const [justJoined, setJustJoined] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/nodes", { cache: "no-store" });
        const data = await res.json();
        if (!cancelled) {
          setNodes(data.nodes || []);
          setLocked(Boolean(data.locked));
        }
      } catch {
        if (!cancelled) {
          setNodes([]);
          setLocked(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // BRIDGES-NOTIFICATION batch: clear the Bridges badge for THIS session
  // the moment this page loads -- mirrors the ISP Setup mark-seen pattern.
  useEffect(() => {
    fetch("/api/bridges/dismiss", { method: "POST" }).catch(() => {});
  }, []);

  async function handleJoin({ state, stateOther, zip }) {
    setJoinError("");
    setJoining(true);
    try {
      const res = await fetch("/api/waitlist/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state, stateOther, zip }),
      });
      const data = await res.json();
      if (!res.ok) {
        setJoinError(data.error || "Unable to join waitlist.");
        return;
      }
      await refetch();
      setJustJoined(true);
    } catch {
      setJoinError("Something went wrong. Please try again.");
    } finally {
      setJoining(false);
    }
  }

  if (accountLoading || loading) {
    return (
      <div className="space-y-6">
        <SectionTitle eyebrow="Marketplace" title="Bridges" />
      </div>
    );
  }

  // Server-enforced restriction mirrored client-side: before ISP Setup is
  // completed and approved, the Bridges section is inaccessible.
  if (locked) {
    return (
      <div className="space-y-6">
        <SectionTitle
          eyebrow="Marketplace"
          title="Bridges"
          subtitle="Premium Bridge inventory in high demand — most sell out within hours."
        />
        <LocationRequiredCard body="Complete your ISP Setup to unlock the Bridges marketplace for your area." />
      </div>
    );
  }

  // Not-joined: waitlist_joined_at is still NULL for this account.
  const notJoined = status != null && status.state !== "joined";

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <SectionTitle
          eyebrow="Marketplace"
          title="Bridges"
          subtitle="Premium Bridge inventory in high demand — most sell out within hours."
        />
      </div>

      {/* PART G: joined banner replaces the repeated join experience. */}
      {status?.state === "joined" && <JoinedBanner />}

      <div className="relative">
        {/* Underlying Bridges content: darkened + non-interactive while
            not joined, but never hidden -- the customer must still be
            able to visually see it. */}
        <div
          aria-hidden={notJoined}
          className={
            notJoined
              ? "pointer-events-none select-none opacity-50 brightness-[0.65] transition-all"
              : "transition-all"
          }
        >
          <div className="space-y-6">
            <FadeIn>
              <GlassCard className="p-5">
                <p className="max-w-3xl text-sm leading-relaxed text-[#B0B0B0]">
                  Premium Bridge inventory is in high demand, and most Bridges sell
                  out within hours. Listed below are the Bridges currently
                  available for purchase in your area.
                </p>
              </GlassCard>
            </FadeIn>

            <FadeIn delay={0.05}>
              <GlassCard className="overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[900px] text-sm">
                    <thead>
                      <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-[#707070]">
                        <th className="px-4 py-3">Bridge ID</th>
                        <th className="px-4 py-3">Bridge Tier</th>
                        <th className="px-4 py-3">IP Address</th>
                        <th className="px-4 py-3 text-right">Est. Monthly Earnings</th>
                        <th className="px-4 py-3 text-right">Cost</th>
                        <th className="px-4 py-3 text-right">Status</th>
                        <th className="px-4 py-3 text-right">Purchase</th>
                      </tr>
                    </thead>
                    <tbody>
                      {nodes.map((node) => {
                        const tierKey = node.tierKey || (node.tier === "Super Node" ? "super" : "standard");
                        return (
                          <tr
                            key={node.nodeId}
                            className="border-b border-white/5 text-[#B0B0B0] transition hover:bg-white/[0.03]"
                          >
                            <td className="px-4 py-3 font-mono text-xs text-white">#{node.nodeId}</td>
                            <td className="px-4 py-3">
                              <NodeTierBadge tierKey={tierKey} tier={node.tier}>
                                {tierKey === "nova" && <Sparkles className="mr-1 h-3 w-3" />}
                                {tierKey === "super" && <Zap className="mr-1 h-3 w-3" />}
                                {tierKey === "standard" && <Server className="mr-1 h-3 w-3" />}
                              </NodeTierBadge>
                            </td>
                            <td className="px-4 py-3 font-mono text-xs">{node.ip}</td>
                            <td className="px-4 py-3 text-right font-mono text-xs">
                              <span className="text-white [text-shadow:0_0_8px_rgba(50,181,255,0.5)]">
                                <FluctuatingEarnings coreCents={node.estMonthlyCents} />
                              </span>
                              <div className="text-[10px] font-sans text-[#707070]">estimated</div>
                            </td>
                            <td className="px-4 py-3 text-right font-mono text-xs text-white">
                              {formatCurrency(centsToDollars(node.costCents))}
                              {typeof node.costPercent === "number" && (
                                <div className="text-[10px] font-sans text-[#707070]">
                                  {Math.round(node.costPercent * 100)}% of earnings
                                </div>
                              )}
                            </td>
                            <td className="px-4 py-3 text-right">
                              <span className="rounded-md bg-red-600 px-2.5 py-1 text-[10px] font-extrabold tracking-wide text-white">
                                {node.status}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <button
                                type="button"
                                disabled
                                aria-disabled="true"
                                tabIndex={-1}
                                className="cursor-not-allowed rounded-md bg-white/10 px-3 py-1.5 text-[10px] font-extrabold tracking-wide text-[#707070]"
                              >
                                Sold Out
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </GlassCard>
            </FadeIn>
          </div>
        </div>

        <AnimatePresence>
          {notJoined && (
            <PreJoinOverlay onJoin={handleJoin} joining={joining} error={joinError} />
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {justJoined && <ConfirmationOverlay onClose={() => setJustJoined(false)} />}
      </AnimatePresence>
    </div>
  );
}
