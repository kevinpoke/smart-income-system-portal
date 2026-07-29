"use client";

import { useEffect, useState } from "react";
import { useEarningsSummary } from "@/lib/useEarningsSummary";
import { useLiveClock } from "@/lib/useLiveClock";
import { useHasMounted } from "@/lib/useHasMounted";
import { formatCountdownParts } from "@/lib/mockData";
import {
  GlassCard,
  SectionTitle,
  AccentButton,
  FadeIn,
  Badge,
  LocationRequiredCard,
} from "@/components/ui/Primitives";
import { motion, AnimatePresence } from "framer-motion";
import { Banknote, CheckCircle2, Clock } from "lucide-react";

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-[#B0B0B0]">
        {label}
      </span>
      {children}
    </label>
  );
}

const inputClass =
  "w-full rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 text-sm text-white placeholder-[#707070] outline-none transition focus:border-[#32B5FF]/60 focus:ring-1 focus:ring-[#32B5FF]/60";

const EMPTY_FORM = { fullName: "", address: "", routingNumber: "", accountNumber: "" };

export default function WithdrawalsPage() {
  const { summary } = useEarningsSummary(15000);
  const now = useLiveClock(1000);
  const hasMounted = useHasMounted();

  const [bank, setBank] = useState(null);
  const [locked, setLocked] = useState(true);
  const [loadingBank, setLoadingBank] = useState(true);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [showSavedModal, setShowSavedModal] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/withdrawals/bank", { cache: "no-store" });
        const data = await res.json();
        if (!cancelled) {
          setBank(data.bank || null);
          setLocked(Boolean(data.locked));
        }
      } catch {
        if (!cancelled) {
          setBank(null);
          setLocked(true);
        }
      } finally {
        if (!cancelled) setLoadingBank(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleSaveBank(e) {
    e.preventDefault();
    setSaveError("");
    setSaving(true);
    try {
      const res = await fetch("/api/withdrawals/bank", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) {
        setSaveError(data.error || "Unable to save bank information.");
        return;
      }
      setBank(data.bank);
      setForm(EMPTY_FORM);
      setShowSavedModal(true);
    } catch {
      setSaveError("Something went wrong. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  // Same shared payoutTargetAt as the Dashboard -- sourced from the same
  // useEarningsSummary() hook, never recomputed independently. Gated
  // behind hasMounted to avoid a Date.now()-driven hydration mismatch.
  let payoutMs = null;
  if (hasMounted && summary?.payoutTargetAt) {
    payoutMs = Math.max(0, new Date(summary.payoutTargetAt).getTime() - now);
  }
  const payoutParts = payoutMs != null ? formatCountdownParts(payoutMs) : null;

  if (!loadingBank && locked) {
    return (
      <div className="space-y-6">
        <SectionTitle
          eyebrow="Cash Out"
          title="Withdrawals"
          subtitle="Add your bank information to receive your earnings."
        />
        <LocationRequiredCard body="Complete your ISP Setup to unlock Withdrawals." />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SectionTitle
        eyebrow="Cash Out"
        title="Withdrawals"
        subtitle="Add your bank information to receive your earnings."
      />

      <FadeIn>
        <GlassCard className="p-6 sm:p-8">
          <form onSubmit={handleSaveBank} className="space-y-4">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-white">
              <Banknote className="h-4 w-4 text-[#32B5FF]" /> Bank Information
            </div>

            {loadingBank ? (
              <div className="text-xs text-[#707070]">Loading bank information…</div>
            ) : bank ? (
              <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm text-[#B0B0B0]">
                <div className="mb-1 text-white">{bank.fullName}</div>
                <div className="text-xs">{bank.address}</div>
                <div className="mt-2 flex gap-4 font-mono text-xs">
                  <span>Routing: •••• {bank.routingLast4}</span>
                  <span>Account: •••• {bank.accountLast4}</span>
                </div>
                <div className="mt-1 text-[10px] text-[#707070]">
                  Last updated {new Date(bank.updatedAt).toLocaleString()}
                </div>
              </div>
            ) : null}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Full Name">
                <input
                  required
                  className={inputClass}
                  value={form.fullName}
                  onChange={(e) => update("fullName", e.target.value)}
                  placeholder="Jane Doe"
                />
              </Field>
              <Field label="Routing Number">
                <input
                  required
                  className={inputClass}
                  value={form.routingNumber}
                  onChange={(e) => update("routingNumber", e.target.value)}
                  placeholder="021000021"
                />
              </Field>
              <Field label="Account Number">
                <input
                  required
                  className={inputClass}
                  value={form.accountNumber}
                  onChange={(e) => update("accountNumber", e.target.value)}
                  placeholder="000123456789"
                />
              </Field>
              <Field label="Address">
                <input
                  required
                  className={inputClass}
                  value={form.address}
                  onChange={(e) => update("address", e.target.value)}
                  placeholder="123 Main St, Austin, TX"
                />
              </Field>
            </div>

            {saveError && (
              <div className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">
                {saveError}
              </div>
            )}

            <AccentButton type="submit" disabled={saving} className="w-full sm:w-auto">
              {saving ? "Saving…" : "Save Bank Info"}
            </AccentButton>
          </form>
        </GlassCard>
      </FadeIn>

      <FadeIn delay={0.05}>
        <GlassCard className="flex flex-col items-start justify-between gap-4 p-6 sm:flex-row sm:items-center">
          <div>
            <div className="text-sm font-semibold text-white">Test Withdrawal</div>
            <div className="mt-1 text-xs text-[#B0B0B0]">
              Test withdrawals are temporarily unavailable while this feature is finalized.
            </div>
            <Badge tone="warning" className="mt-2">
              Unavailable
            </Badge>
          </div>
          <AccentButton disabled className="cursor-not-allowed opacity-50">
            Complete Test Withdrawal
          </AccentButton>
        </GlassCard>
      </FadeIn>

      <FadeIn delay={0.1}>
        <GlassCard className="flex flex-col items-start justify-between gap-3 p-5 sm:flex-row sm:items-center">
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-[#32B5FF]/15 p-2.5">
              <Clock className="h-5 w-5 text-[#32B5FF]" />
            </div>
            <div className="text-sm font-semibold text-white">
              Next withdrawal available in…
            </div>
          </div>
          {summary?.payoutAvailable ? (
            <Badge tone="success">Payout Available</Badge>
          ) : payoutParts ? (
            <span className="font-mono text-sm font-bold text-white">
              {payoutParts.months}mo {payoutParts.days}d{" "}
              {String(payoutParts.hours).padStart(2, "0")}h{" "}
              {String(payoutParts.minutes).padStart(2, "0")}m{" "}
              {String(payoutParts.seconds).padStart(2, "0")}s
            </span>
          ) : (
            <span className="font-mono text-sm font-bold text-white">--</span>
          )}
        </GlassCard>
      </FadeIn>

      <AnimatePresence>
        {showSavedModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
            onClick={() => setShowSavedModal(false)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-md rounded-2xl border border-green-500/30 bg-[#1E1E1E] p-6"
            >
              <div className="mb-3 flex items-center gap-2 text-green-400">
                <CheckCircle2 className="h-6 w-6" />
                <h3 className="text-base font-bold">Bank Information Saved</h3>
              </div>
              <p className="text-sm text-[#B0B0B0]">
                Thank you, your bank information has been saved in our system.
              </p>
              <AccentButton className="mt-5 w-full" onClick={() => setShowSavedModal(false)}>
                Understood
              </AccentButton>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
