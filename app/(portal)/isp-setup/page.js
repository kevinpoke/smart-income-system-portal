"use client";

import { useMemo, useState } from "react";
import { useAccount } from "@/lib/useAccount";
import { useLiveClock } from "@/lib/useLiveClock";
import { useHasMounted } from "@/lib/useHasMounted";
import { ISP_PROVIDERS, US_STATES, formatCountdown } from "@/lib/mockData";
import {
  GlassCard,
  SectionTitle,
  AccentButton,
  FadeIn,
  Badge,
} from "@/components/ui/Primitives";
import { CheckCircle2, Clock3, Wifi, ShieldCheck } from "lucide-react";

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

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

// Fully SQLite-backed ISP setup workflow. isp_status drives which of the
// four states renders: not_started -> pending_review ->
// approved_awaiting_user -> active. All timestamps (isp_submitted_at,
// isp_approved_at, user_authorized_at, node_connected_at) come from the
// server via /api/auth/me and are never derived from localStorage/Zustand.
export default function IspSetupPage() {
  const { account: user, loading, refetch } = useAccount();
  const now = useLiveClock(1000);
  const hasMounted = useHasMounted();

  const [form, setForm] = useState({
    provider: "",
    street: "",
    city: "",
    state: "",
    zip: "",
    ssid: "",
    password: "",
  });
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [authorizeError, setAuthorizeError] = useState("");

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitError("");
    setSubmitting(true);
    try {
      const res = await fetch("/api/isp/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) {
        setSubmitError(data.error || "Submission failed.");
        return;
      }
      await refetch();
    } catch {
      setSubmitError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAuthorize() {
    setAuthorizeError("");
    setAuthorizing(true);
    try {
      const res = await fetch("/api/isp/authorize", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setAuthorizeError(data.error || "Authorization failed.");
        return;
      }
      await refetch();
    } catch {
      setAuthorizeError("Something went wrong. Please try again.");
    } finally {
      setAuthorizing(false);
    }
  }

  // Timer begins exactly 3 days after isp_submitted_at (server timestamp).
  // Reaching zero never auto-approves -- it only affects the copy shown
  // while isp_status stays "pending_review" until an admin acts.
  //
  // deadline - now depends on Date.now(), which differs between the server
  // render and the first client render. Gate behind hasMounted so both
  // agree (reviewTimeRemaining === null, the "Estimated time remaining"
  // badge omitted) until the real countdown appears right after mount and
  // ticks every second.
  //
  // Computed inline (not useMemo) -- the React Compiler auto-memoizes this
  // and its own dependency inference disagreed with an explicit dep array
  // that includes hasMounted/now.
  let reviewTimeRemaining = null;
  if (hasMounted && user?.ispSubmittedAt) {
    const deadline = new Date(user.ispSubmittedAt).getTime() + THREE_DAYS_MS;
    reviewTimeRemaining = Math.max(0, deadline - now);
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <SectionTitle eyebrow="ISP Setup" title="Loading…" />
      </div>
    );
  }

  if (user?.ispStatus === "active") {
    return (
      <div className="space-y-6">
        <SectionTitle eyebrow="ISP Setup" title="Setup Complete" />
        <FadeIn>
          <GlassCard className="flex flex-col items-center gap-3 px-6 py-16 text-center">
            <CheckCircle2 className="h-12 w-12 text-green-400" />
            <h2 className="text-xl font-bold text-white">Your Node is Active</h2>
            <p className="max-w-md text-sm text-[#B0B0B0]">
              Your WiFi has been successfully connected to the StarAtlas
              Network. Visit your Dashboard to monitor your earnings and
              connection status.
            </p>
          </GlassCard>
        </FadeIn>
      </div>
    );
  }

  if (user?.ispStatus === "approved_awaiting_user") {
    return (
      <div className="space-y-6">
        <SectionTitle eyebrow="ISP Setup" title="Authorization Required" />
        <FadeIn>
          <GlassCard className="flex flex-col items-center gap-4 px-6 py-14 text-center">
            <ShieldCheck className="h-12 w-12 text-[#32B5FF]" />
            <div>
              <h2 className="text-xl font-bold text-white">
                Do you authorize us to connect your WiFi to the StarAtlas
                Network?
              </h2>
            </div>
            {authorizeError && (
              <div className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">
                {authorizeError}
              </div>
            )}
            <button
              onClick={handleAuthorize}
              disabled={authorizing}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-green-500 px-6 py-3 text-sm font-bold text-[#06121a] shadow-[0_0_20px_rgba(34,197,94,0.4)] transition hover:bg-green-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-green-300 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {authorizing ? "Authorizing…" : "I Approve"}
            </button>
          </GlassCard>
        </FadeIn>
      </div>
    );
  }

  if (user?.ispStatus === "pending_review") {
    return (
      <div className="space-y-6">
        <SectionTitle eyebrow="ISP Setup" title="Application Status" />
        <FadeIn>
          <GlassCard className="flex flex-col items-center gap-4 px-6 py-14 text-center">
            <Clock3 className="h-12 w-12 animate-pulse text-[#32B5FF]" />
            <div>
              <h2 className="text-xl font-bold text-white">
                We&rsquo;re currently connecting your WiFi to the StarAtlas
                Network.
              </h2>
              <p className="mx-auto mt-2 max-w-md text-sm text-[#B0B0B0]">
                Once your connection has been successfully configured,
                you&rsquo;ll receive a confirmation email. Because each setup
                is completed manually, please allow 1&ndash;3 business days
                for us to allocate and activate your Node.
              </p>
            </div>
            {reviewTimeRemaining != null && (
              <Badge tone="accent" className="font-mono">
                Estimated time remaining: {formatCountdown(reviewTimeRemaining)}
              </Badge>
            )}
            <p className="text-xs text-[#707070]">
              If you have not received a confirmation email within 3 days,
              please contact Support so we can review and expedite your
              setup.
            </p>
          </GlassCard>
        </FadeIn>
      </div>
    );
  }

  // isp_status === "not_started"
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

            {submitError && (
              <div className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">
                {submitError}
              </div>
            )}

            <AccentButton type="submit" disabled={submitting} className="w-full">
              {submitting ? "Submitting…" : "Complete ISP Setup"}
            </AccentButton>
          </form>
        </GlassCard>
      </FadeIn>
    </div>
  );
}
