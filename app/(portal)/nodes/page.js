"use client";

import { useEffect, useState } from "react";
import { useAccount } from "@/lib/useAccount";
import { formatCurrency, centsToDollars } from "@/lib/mockData";
import { useWaitlistStatus } from "@/lib/useWaitlistStatus";
import {
  GlassCard,
  SectionTitle,
  FadeIn,
  LocationRequiredCard,
} from "@/components/ui/Primitives";
import NodeTierBadge from "@/components/ui/NodeTierBadge";
import FluctuatingEarnings from "@/components/ui/FluctuatingEarnings";
import { Server, Zap, Clock3, CheckCircle2, Sparkles } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";

// Waitlist redesign batch (spec sections E/G): EXACT customer-facing
// copy, paragraph breaks preserved verbatim. Never materially rewrite --
// only this file references these two strings.
const PRE_JOIN_COPY = [
  "If you would like to purchase additional Bridges to increase your earning potential, please join our waitlist.",
  "At this time, all available Bridges have been allocated and we do not have any additional Bridges available for purchase.",
  "As new data Bridges are added to our system, eligible members will be selected from the waitlist through a lottery system. This process is designed to give everyone on the waitlist a fair opportunity to purchase additional Bridges.",
  "If you are selected, a member of our team will contact you directly through the Support area with availability and next steps.",
];

const CONFIRMATION_COPY = [
  "You\u2019re on the Waitlist!",
  "As new Bridges become available, members will be selected through our lottery system to ensure everyone has a fair opportunity.",
  "If you are selected, our team will contact you directly through the Support area of your account with availability and next steps.",
  "No further action is required at this time.",
];

// Pre-join popup/overlay: large, prominent, centered over the (still
// visible-but-darkened) Bridge inventory behind it. The green "Join
// Waitlist" CTA is the dominant action per spec section F. Hitting the
// EXISTING canonical join endpoint (/api/waitlist/join) -- no competing
// waitlist state is created here.
function PreJoinOverlay({ onJoin, joining, error }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 z-20 flex items-center justify-center p-4"
    >
      <motion.div
        initial={{ scale: 0.96, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="w-full max-w-xl rounded-2xl border border-[#32B5FF]/30 bg-[#1E1E1E] p-6 shadow-[0_0_60px_rgba(50,181,255,0.25)] sm:p-8"
      >
        <div className="mb-4 flex items-center gap-2 text-[#32B5FF]">
          <Clock3 className="h-6 w-6" />
          <h2 className="text-lg font-bold text-white sm:text-xl">Join the Waitlist</h2>
        </div>
        <div className="space-y-3 text-sm leading-relaxed text-[#B0B0B0] sm:text-base">
          {PRE_JOIN_COPY.map((para, i) => (
            <p key={i}>{para}</p>
          ))}
        </div>
        {error && (
          <div className="mt-4 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">
            {error}
          </div>
        )}
        <button
          onClick={onJoin}
          disabled={joining}
          className={`mt-6 flex w-full items-center justify-center gap-2 rounded-xl px-6 py-4 text-base font-extrabold tracking-wide text-white transition-all ${
            joining
              ? "cursor-not-allowed bg-green-700/50"
              : "bg-green-600 shadow-[0_0_30px_rgba(34,197,94,0.5)] hover:bg-green-500 active:scale-[0.98]"
          }`}
        >
          {joining ? "Joining\u2026" : "Join Waitlist"}
        </button>
      </motion.div>
    </motion.div>
  );
}

// Post-join confirmation panel: replaces the pre-join popup once
// waitlist_joined_at is set. Same prominent placement.
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
        <div className="space-y-2 text-sm text-[#B0B0B0]">
          {CONFIRMATION_COPY.map((para, i) => (
            <p key={i} className={i === 0 ? "text-base font-bold text-white" : undefined}>
              {para}
            </p>
          ))}
        </div>
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

export default function NodesPage() {
  const { loading: accountLoading } = useAccount();
  const [nodes, setNodes] = useState([]);
  const [locked, setLocked] = useState(true);
  const [loading, setLoading] = useState(true);

  // Waitlist redesign batch: state.state comes ENTIRELY from
  // /api/waitlist/status (accounts.waitlist_joined_at), polled by
  // useWaitlistStatus -- never localStorage/component-only state, so it
  // survives refresh/logout/login/new sessions per spec section B.
  const { status, refetch } = useWaitlistStatus(5000);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState("");
  // Shows the confirmation panel immediately after a successful join in
  // THIS session; on a later visit where the account already has
  // waitlist_joined_at set (spec Test 5 -- pre-existing joined member),
  // the page just shows the plain joined Bridge list with no popup at
  // all, never re-showing this confirmation unprompted.
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

  async function handleJoin() {
    setJoinError("");
    setJoining(true);
    try {
      const res = await fetch("/api/waitlist/join", { method: "POST" });
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
        <SectionTitle eyebrow="Marketplace" title="Waitlist" />
      </div>
    );
  }

  // Server-enforced restriction mirrored client-side: before ISP Setup is
  // completed and approved, the Waitlist/Data Bridges section is
  // inaccessible and shows the same "Location Required" locked-state card
  // used in Payouts.
  if (locked) {
    return (
      <div className="space-y-6">
        <SectionTitle
          eyebrow="Marketplace"
          title="Waitlist"
          subtitle="Premium Bridge inventory in high demand — most sell out within hours."
        />
        <LocationRequiredCard body="Complete your ISP Setup to unlock the Waitlist marketplace for your area." />
      </div>
    );
  }

  // Not-joined: waitlist_joined_at is still NULL for this account.
  // Underlying Bridge inventory stays rendered but visibly darkened/
  // greyed-out and non-interactive behind the overlay (spec section D) --
  // the popup (spec E/F) sits on top of it.
  const notJoined = status != null && status.state !== "joined";

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <SectionTitle
          eyebrow="Marketplace"
          title="Waitlist"
          subtitle="Premium Bridge inventory in high demand — most sell out within hours."
        />
      </div>

      <div className="relative">
        {/* Underlying Bridges content: darkened + non-interactive while
            not joined (pointer-events-none blocks every purchase/
            selection control beneath the overlay), but never hidden --
            the customer must still be able to visually see it per spec. */}
        <div
          aria-hidden={notJoined}
          className={
            notJoined
              ? "pointer-events-none select-none opacity-25 brightness-[0.35] blur-[1px] transition-all"
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
                                {/* Display-only +/-5% visual fluctuation layered
                                    over the stable server-supplied
                                    estMonthlyCents core value (see
                                    components/ui/FluctuatingEarnings.js) --
                                    never the actual stored rate, never fed
                                    into any accrual/payout math. */}
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
                              {/* Purchase is not implemented -- this button is
                                  permanently disabled and never fires a
                                  request or navigates anywhere; it exists
                                  purely to visually communicate "Sold Out" for
                                  every listed Bridge, matching the marketplace
                                  copy above ("most Bridges sell out within
                                  hours"). */}
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
