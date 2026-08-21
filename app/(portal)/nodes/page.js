"use client";

import { useEffect, useState } from "react";
import { useAccount } from "@/lib/useAccount";
import { formatCurrency, centsToDollars, formatCountdown } from "@/lib/mockData";
import { useWaitlistStatus } from "@/lib/useWaitlistStatus";
import { useLiveClock } from "@/lib/useLiveClock";
import { useHasMounted } from "@/lib/useHasMounted";
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

const WAITLIST_MODAL_COPY =
  "You have been added to the waitlist. As additional Bridges become available, a support representative will contact you directly when you are eligible to add more Bridges to your account. Until then, please remain on standby for further updates.";

function WaitlistJoinedModal({ onClose }) {
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
          <h3 className="text-base font-bold text-white">Waitlist Joined</h3>
        </div>
        <p className="text-sm text-[#B0B0B0]">{WAITLIST_MODAL_COPY}</p>
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

function WaitlistButton() {
  const { status, refetch } = useWaitlistStatus(5000);
  const now = useLiveClock(1000);
  const hasMounted = useHasMounted();
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState("");
  const [showJoinedModal, setShowJoinedModal] = useState(false);

  // deadlineAt - now depends on Date.now(), which differs between the
  // server render and the first client render. Gate behind hasMounted so
  // both agree (remainingMs === null, "Closes in ...” omitted) until the
  // real countdown appears right after mount and ticks every second.
  let remainingMs = null;
  if (hasMounted && status?.deadlineAt) {
    remainingMs = Math.max(0, new Date(status.deadlineAt).getTime() - now);
  }

  async function handleJoin() {
    setError("");
    setJoining(true);
    try {
      const res = await fetch("/api/waitlist/join", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Unable to join waitlist.");
        return;
      }
      await refetch();
      setShowJoinedModal(true);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setJoining(false);
    }
  }

  if (!status) return null;

  const disabled = status.state !== "open" || joining;
  let label = "Join Waitlist";
  if (status.state === "joined") label = "Waitlist Joined";
  else if (status.state === "closed") label = "Waitlist Closed";
  else if (joining) label = "Joining…";

  return (
    <div className="flex flex-col items-end gap-1.5">
      <button
        onClick={handleJoin}
        disabled={disabled}
        aria-disabled={disabled}
        className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-all ${
          disabled
            ? "cursor-not-allowed bg-white/5 text-white/30"
            : "bg-[#32B5FF] text-[#06121a] shadow-[0_0_20px_rgba(50,181,255,0.35)] hover:bg-[#4dc0ff]"
        }`}
      >
        {status.state === "joined" && <CheckCircle2 className="h-4 w-4" />}
        {status.state === "open" && <Clock3 className="h-4 w-4" />}
        {label}
      </button>
      {status.state === "open" && remainingMs != null && (
        <span className="font-mono text-[11px] text-[#707070]">
          Closes in {formatCountdown(remainingMs)}
        </span>
      )}
      {error && <span className="text-[11px] text-red-400">{error}</span>}
      <AnimatePresence>
        {showJoinedModal && (
          <WaitlistJoinedModal onClose={() => setShowJoinedModal(false)} />
        )}
      </AnimatePresence>
    </div>
  );
}

export default function NodesPage() {
  const { loading: accountLoading } = useAccount();
  const [nodes, setNodes] = useState([]);
  const [locked, setLocked] = useState(true);
  const [loading, setLoading] = useState(true);

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

  if (accountLoading || loading) {
    return (
      <div className="space-y-6">
        <SectionTitle eyebrow="Marketplace" title="Data Bridges" />
      </div>
    );
  }

  // Server-enforced restriction mirrored client-side: before ISP Setup is
  // completed and approved, the Data Bridges section is inaccessible and
  // shows the same "Location Required" locked-state card used in Payouts.
  if (locked) {
    return (
      <div className="space-y-6">
        <SectionTitle
          eyebrow="Marketplace"
          title="Data Bridges"
          subtitle="Premium Bridge inventory in high demand — most sell out within hours."
        />
        <LocationRequiredCard body="Complete your ISP Setup to unlock the Data Bridges marketplace for your area." />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <SectionTitle
          eyebrow="Marketplace"
          title="Data Bridges"
          subtitle="Premium Bridge inventory in high demand — most sell out within hours."
        />
        <WaitlistButton />
      </div>

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
  );
}
