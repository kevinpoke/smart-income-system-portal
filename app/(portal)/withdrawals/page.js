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

// BANK-INTERNATIONAL batch: customer chooses Domestic (Account/Routing)
// or International (SWIFT/IBAN) -- only the chosen pair is required on
// submit (see lib/bank.js validateCustomerBankInfo, enforced
// authoritatively server-side; this client-side gating is a UX
// convenience only). Both pairs' form state is always kept (never
// destroyed by switching tabs mid-edit) so a customer who fills in both,
// then flips back and forth, never silently loses what they typed --
// only an actual Save commits anything, matching every other form in
// this app.
const EMPTY_FORM = {
  fullName: "",
  address: "",
  routingNumber: "",
  accountNumber: "",
  swift: "",
  iban: "",
};
const BANK_TYPE_DOMESTIC = "domestic";
const BANK_TYPE_INTERNATIONAL = "international";

export default function WithdrawalsPage() {
  const { summary } = useEarningsSummary(15000);
  const now = useLiveClock(1000);
  const hasMounted = useHasMounted();

  const [bank, setBank] = useState(null);
  const [locked, setLocked] = useState(true);
  const [module10Locked, setModule10Locked] = useState(false);
  const [loadingBank, setLoadingBank] = useState(true);
  const [form, setForm] = useState(EMPTY_FORM);
  const [bankType, setBankType] = useState(BANK_TYPE_DOMESTIC);
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
          setModule10Locked(Boolean(data.module10Locked));
          // Default the selector to whichever pair is ALREADY saved
          // (international, if that's what's on file) rather than always
          // defaulting to Domestic -- purely a UX convenience, never
          // affects validation.
          if (data.bank?.hasSwift || data.bank?.hasIban) {
            setBankType(BANK_TYPE_INTERNATIONAL);
          }
        }
      } catch {
        if (!cancelled) {
          setBank(null);
          setLocked(true);
          setModule10Locked(false);
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

  // Client-side convenience check only -- the server (lib/bank.js
  // validateCustomerBankInfo, called from POST /api/withdrawals/bank) is
  // the sole AUTHORITATIVE validator and re-checks this exact same rule
  // independently of whatever the client sends.
  const domesticFilled = form.routingNumber.trim() && form.accountNumber.trim();
  const internationalFilled = form.swift.trim() && form.iban.trim();
  const canSubmit =
    form.fullName.trim() &&
    form.address.trim() &&
    (bankType === BANK_TYPE_DOMESTIC ? domesticFilled : internationalFilled);

  async function handleSaveBank(e) {
    e.preventDefault();
    setSaveError("");
    if (!canSubmit) {
      setSaveError(
        bankType === BANK_TYPE_DOMESTIC
          ? "Enter both Account Number and Routing Number."
          : "Enter both SWIFT and IBAN."
      );
      return;
    }
    setSaving(true);
    try {
      // Only send the fields relevant to the chosen Bank Type -- a
      // customer who previously filled in the OTHER pair in this same
      // session (before switching tabs) never has it silently submitted
      // alongside their actual choice. Server-side validation would
      // still accept either/both regardless, but this keeps the
      // customer's explicit selection authoritative for what gets saved.
      const payload = {
        fullName: form.fullName,
        address: form.address,
        routingNumber: bankType === BANK_TYPE_DOMESTIC ? form.routingNumber : "",
        accountNumber: bankType === BANK_TYPE_DOMESTIC ? form.accountNumber : "",
        swift: bankType === BANK_TYPE_INTERNATIONAL ? form.swift : "",
        iban: bankType === BANK_TYPE_INTERNATIONAL ? form.iban : "",
      };
      const res = await fetch("/api/withdrawals/bank", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
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
        {/* WITHDRAWALS-MODULE10-LOCK-COPY batch: this Module-10-specific
            branch is the ONLY lock reason that gets the new title/body/
            button copy -- the ELSE branch (ISP setup not complete) is
            completely untouched (still "Location Required" / "Complete
            your ISP Setup to unlock Withdrawals." / "Complete ISP Setup"
            -> /isp-setup), per spec section K ("preserve other
            withdrawal lock reasons"). `module10Locked` here is the same
            boolean GET /api/withdrawals/bank already computed from
            hasWithdrawalsModule10Access() (real completed_at only --
            never modules_unlocked/"Unlock All"), so Admin Unlock All
            alone can never flip this branch. */}
        {module10Locked ? (
          <LocationRequiredCard
            title="Complete Module 10 to Unlock"
            body="Please complete watching Module 10 to unlock this section."
            ctaLabel="Complete Module 10"
            ctaHref="/modules"
          />
        ) : (
          <LocationRequiredCard body="Complete your ISP Setup to unlock Withdrawals." />
        )}
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
                {/* BANK-INTERNATIONAL batch: shows whichever pair is
                    ACTUALLY saved (domestic, international, or both) --
                    never fabricates a "Routing: ••••" line when only
                    SWIFT/IBAN are on file, and vice versa. */}
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs">
                  {bank.hasRoutingNumber && <span>Routing: •••• {bank.routingLast4}</span>}
                  {bank.hasAccountNumber && <span>Account: •••• {bank.accountLast4}</span>}
                  {bank.hasSwift && <span>SWIFT: •••• {bank.swiftLast4}</span>}
                  {bank.hasIban && <span>IBAN: •••• {bank.ibanLast4}</span>}
                </div>
                <div className="mt-1 text-[10px] text-[#707070]">
                  Last updated {new Date(bank.updatedAt).toLocaleString()}
                </div>
              </div>
            ) : null}

            {/* BANK-INTERNATIONAL batch: Bank Type selector -- Domestic
                (Account Number + Routing Number) vs International
                (SWIFT + IBAN). Only the selected pair is required to
                submit (enforced authoritatively server-side); switching
                tabs never clears what was typed in the other tab. */}
            <div>
              <span className="mb-1.5 block text-xs font-medium text-[#B0B0B0]">Bank Type</span>
              <div className="inline-flex rounded-xl border border-white/10 bg-white/5 p-1">
                <button
                  type="button"
                  onClick={() => setBankType(BANK_TYPE_DOMESTIC)}
                  className={`rounded-lg px-4 py-1.5 text-xs font-semibold transition-colors ${
                    bankType === BANK_TYPE_DOMESTIC
                      ? "bg-[#32B5FF] text-[#06121a]"
                      : "text-[#B0B0B0] hover:text-white"
                  }`}
                >
                  Domestic Bank
                </button>
                <button
                  type="button"
                  onClick={() => setBankType(BANK_TYPE_INTERNATIONAL)}
                  className={`rounded-lg px-4 py-1.5 text-xs font-semibold transition-colors ${
                    bankType === BANK_TYPE_INTERNATIONAL
                      ? "bg-[#32B5FF] text-[#06121a]"
                      : "text-[#B0B0B0] hover:text-white"
                  }`}
                >
                  International Bank
                </button>
              </div>
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
              <Field label="Address">
                <input
                  required
                  className={inputClass}
                  value={form.address}
                  onChange={(e) => update("address", e.target.value)}
                  placeholder="123 Main St, Austin, TX"
                />
              </Field>
              {bankType === BANK_TYPE_DOMESTIC ? (
                <>
                  <Field label="Routing Number">
                    <input
                      required
                      type="text"
                      className={inputClass}
                      value={form.routingNumber}
                      onChange={(e) => update("routingNumber", e.target.value)}
                      placeholder="021000021"
                    />
                  </Field>
                  <Field label="Account Number">
                    <input
                      required
                      type="text"
                      className={inputClass}
                      value={form.accountNumber}
                      onChange={(e) => update("accountNumber", e.target.value)}
                      placeholder="000123456789"
                    />
                  </Field>
                </>
              ) : (
                <>
                  <Field label="SWIFT">
                    <input
                      required
                      type="text"
                      className={inputClass}
                      value={form.swift}
                      onChange={(e) => update("swift", e.target.value)}
                      placeholder="ABCDUS12"
                    />
                  </Field>
                  <Field label="IBAN">
                    <input
                      required
                      type="text"
                      className={inputClass}
                      value={form.iban}
                      onChange={(e) => update("iban", e.target.value)}
                      placeholder="GB29NWBK60161331926819"
                    />
                  </Field>
                </>
              )}
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
