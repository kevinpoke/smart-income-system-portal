"use client";

import { useMemo, useState } from "react";
import { useStore } from "@/lib/store";
import { useLiveClock } from "@/lib/useLiveClock";
import { ISP_PROVIDERS, US_STATES, formatCompactDuration } from "@/lib/mockData";
import {
  GlassCard,
  SectionTitle,
  AccentButton,
  FadeIn,
  Badge,
} from "@/components/ui/Primitives";
import { motion } from "framer-motion";
import { CheckCircle2, Clock3, Wifi, ShieldCheck } from "lucide-react";

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

export default function IspSetupPage() {
  const user = useStore((s) => s.users[s.currentUserId]);
  const submitIspApplication = useStore((s) => s.submitIspApplication);
  const approveParticipation = useStore((s) => s.approveParticipation);
  const manualSendApproveButton = useStore((s) => s.manualSendApproveButton);
  const now = useLiveClock(1000);

  const [form, setForm] = useState({
    provider: "",
    street: "",
    city: "",
    state: "",
    zip: "",
    ssid: "",
    password: "",
  });

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  function handleSubmit(e) {
    e.preventDefault();
    submitIspApplication(form);
  }

  const showApproveButton = useMemo(() => {
    if (!user?.approveButtonAvailableAt) return false;
    return now >= new Date(user.approveButtonAvailableAt).getTime();
  }, [user?.approveButtonAvailableAt, now]);

  const timeRemaining = useMemo(() => {
    if (!user?.approveButtonAvailableAt) return null;
    return Math.max(0, new Date(user.approveButtonAvailableAt).getTime() - now);
  }, [user?.approveButtonAvailableAt, now]);

  if (user?.status === "active") {
    return (
      <div className="space-y-6">
        <SectionTitle eyebrow="ISP Setup" title="Setup Complete" />
        <FadeIn>
          <GlassCard className="flex flex-col items-center gap-3 px-6 py-16 text-center">
            <CheckCircle2 className="h-12 w-12 text-green-400" />
            <h2 className="text-xl font-bold text-white">
              Your Node is Active
            </h2>
            <p className="max-w-md text-sm text-[#B0B0B0]">
              Your participation was approved and your uptime + earnings are
              live. Head to the Dashboard to watch it grow.
            </p>
          </GlassCard>
        </FadeIn>
      </div>
    );
  }

  if (user?.status === "isp_pending") {
    return (
      <div className="space-y-6">
        <SectionTitle eyebrow="ISP Setup" title="Application Status" />
        <FadeIn>
          <GlassCard className="flex flex-col items-center gap-4 px-6 py-14 text-center">
            {showApproveButton ? (
              <>
                <ShieldCheck className="h-12 w-12 text-[#32B5FF]" />
                <div>
                  <h2 className="text-xl font-bold text-white">
                    You&apos;re Verified!
                  </h2>
                  <p className="mx-auto mt-2 max-w-md text-sm text-[#B0B0B0]">
                    Your ISP setup has been reviewed. Approve your
                    participation below to start your uptime timer and live
                    earnings.
                  </p>
                </div>
                <AccentButton onClick={() => approveParticipation(user.id)}>
                  Approve Participation
                </AccentButton>
              </>
            ) : (
              <>
                <Clock3 className="h-12 w-12 animate-pulse text-[#32B5FF]" />
                <div>
                  <h2 className="text-xl font-bold text-white">
                    Your application is in-review
                  </h2>
                  <p className="mx-auto mt-2 max-w-md text-sm text-[#B0B0B0]">
                    Please wait 1-3 days for verification. We will email you.
                  </p>
                </div>
                {timeRemaining != null && (
                  <Badge tone="accent">
                    Est. remaining: {formatCompactDuration(timeRemaining)}
                  </Badge>
                )}
                <p className="text-xs text-[#707070]">
                  If it&apos;s taking too long, contact Support and we can
                  expedite your approval.
                </p>
              </>
            )}
          </GlassCard>
        </FadeIn>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SectionTitle
        eyebrow="Step 1 of 1"
        title="ISP Setup"
        subtitle="Connect your home network to the StarAtlas Rewards Network."
      />
      <FadeIn>
        <GlassCard className="p-6 sm:p-8">
          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-white">
                <Wifi className="h-4 w-4 text-[#32B5FF]" /> Internet Provider
              </div>
              <Field label="ISP Provider">
                <select
                  required
                  value={form.provider}
                  onChange={(e) => update("provider", e.target.value)}
                  className={inputClass}
                >
                  <option value="" disabled>
                    Select your provider...
                  </option>
                  {ISP_PROVIDERS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <div>
              <div className="mb-3 text-sm font-semibold text-white">
                Home Address
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <Field label="Street Address">
                    <input
                      required
                      className={inputClass}
                      value={form.street}
                      onChange={(e) => update("street", e.target.value)}
                      placeholder="123 Main St"
                    />
                  </Field>
                </div>
                <Field label="City">
                  <input
                    required
                    className={inputClass}
                    value={form.city}
                    onChange={(e) => update("city", e.target.value)}
                    placeholder="Austin"
                  />
                </Field>
                <div className="grid grid-cols-2 gap-4">
                  <Field label="State">
                    <select
                      required
                      className={inputClass}
                      value={form.state}
                      onChange={(e) => update("state", e.target.value)}
                    >
                      <option value="" disabled>
                        --
                      </option>
                      {US_STATES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Zip">
                    <input
                      required
                      className={inputClass}
                      value={form.zip}
                      onChange={(e) => update("zip", e.target.value)}
                      placeholder="78701"
                    />
                  </Field>
                </div>
              </div>
            </div>

            <div>
              <div className="mb-3 text-sm font-semibold text-white">
                WiFi Credentials
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="WiFi SSID (Network Name)">
                  <input
                    required
                    className={inputClass}
                    value={form.ssid}
                    onChange={(e) => update("ssid", e.target.value)}
                    placeholder="MyHomeWiFi"
                  />
                </Field>
                <Field label="WiFi Password">
                  <input
                    required
                    type="password"
                    className={inputClass}
                    value={form.password}
                    onChange={(e) => update("password", e.target.value)}
                    placeholder="••••••••"
                  />
                </Field>
              </div>
            </div>

            <AccentButton type="submit" className="w-full">
              Submit Application
            </AccentButton>
          </form>
        </GlassCard>
      </FadeIn>
    </div>
  );
}
