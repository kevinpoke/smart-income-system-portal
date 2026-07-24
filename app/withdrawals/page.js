"use client";

import { useMemo, useState } from "react";
import { useStore } from "@/lib/store";
import { useLiveClock } from "@/lib/useLiveClock";
import { formatLongDuration } from "@/lib/mockData";
import { msUntilNextPayout } from "@/lib/earnings";
import { GlassCard, SectionTitle, AccentButton, FadeIn, Badge } from "@/components/ui/Primitives";
import { motion, AnimatePresence } from "framer-motion";
import { Banknote, AlertTriangle, CheckCircle2 } from "lucide-react";

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

export default function WithdrawalsPage() {
  const user = useStore((s) => s.users[s.currentUserId]);
  const saveBankInfo = useStore((s) => s.saveBankInfo);
  const requestTestWithdrawal = useStore((s) => s.requestTestWithdrawal);
  const now = useLiveClock(1000);

  const [form, setForm] = useState(
    user?.withdrawal?.bank || {
      routingNumber: "",
      accountNumber: "",
      fullName: "",
      address: "",
    }
  );
  const [warning, setWarning] = useState(false);

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  function handleSaveBank(e) {
    e.preventDefault();
    saveBankInfo(form);
  }

  const status = user?.withdrawal?.testWithdrawalStatus || "none";
  const payoutMsRemaining = msUntilNextPayout(user, now);

  function handleActionClick() {
    if (status === "complete") {
      setWarning(true);
    } else {
      requestTestWithdrawal();
    }
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
            <AccentButton type="submit" className="w-full sm:w-auto">
              Save Bank Info
            </AccentButton>
          </form>
        </GlassCard>
      </FadeIn>

      <FadeIn delay={0.05}>
        <GlassCard className="flex flex-col items-start justify-between gap-4 p-6 sm:flex-row sm:items-center">
          <div>
            <div className="text-sm font-semibold text-white">
              {status === "complete" ? "Withdraw Earnings" : "Test Withdrawal"}
            </div>
            <div className="mt-1 text-xs text-[#B0B0B0]">
              {status === "none" &&
                "Request a small test withdrawal to verify your bank details work correctly."}
              {status === "requested" &&
                "Your test withdrawal is being processed by our team."}
              {status === "complete" &&
                "Your test withdrawal succeeded. You can now request a full withdrawal once eligible."}
            </div>
            {status === "requested" && (
              <Badge tone="warning" className="mt-2">
                Pending Admin Review
              </Badge>
            )}
            {status === "complete" && (
              <Badge tone="success" className="mt-2">
                <CheckCircle2 className="mr-1 h-3 w-3" /> Verified
              </Badge>
            )}
          </div>
          <AccentButton
            disabled={status === "requested" || !user?.withdrawal?.bank}
            onClick={handleActionClick}
          >
            {status === "complete" ? "Withdraw Earnings" : "Request Test Withdrawal"}
          </AccentButton>
        </GlassCard>
      </FadeIn>

      <AnimatePresence>
        {warning && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
            onClick={() => setWarning(false)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-md rounded-2xl border border-yellow-500/30 bg-[#1E1E1E] p-6"
            >
              <div className="mb-3 flex items-center gap-2 text-yellow-400">
                <AlertTriangle className="h-6 w-6" />
                <h3 className="text-base font-bold">Withdrawal Unavailable</h3>
              </div>
              <p className="text-sm text-[#B0B0B0]">
                Earnings are currently not available for withdrawal.
                Withdrawal will be available in{" "}
                <span className="font-semibold text-white">
                  {payoutMsRemaining != null
                    ? formatLongDuration(payoutMsRemaining)
                    : "an unknown amount of time"}
                </span>
                .
              </p>
              <AccentButton className="mt-5 w-full" onClick={() => setWarning(false)}>
                Understood
              </AccentButton>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
