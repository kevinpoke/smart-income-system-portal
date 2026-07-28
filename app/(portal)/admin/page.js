"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount } from "@/lib/useAccount";
import { useLiveClock } from "@/lib/useLiveClock";
import { useHasMounted } from "@/lib/useHasMounted";
import { formatCurrency, centsToDollars, formatCountdown } from "@/lib/mockData";
import { GlassCard, Badge, AccentButton, GhostButton } from "@/components/ui/Primitives";
import {
  CheckCircle2,
  XCircle,
  Mail,
  Zap,
  RefreshCw,
  ShieldCheck,
  Lock,
  Unlock,
  DollarSign,
  Sparkles,
} from "lucide-react";

const TEST_PAYLOAD = {
  email: "test@example.com",
  name: "Test User",
  password: "Password123",
};

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

const ISP_STATUS_LABELS = {
  not_started: { label: "Not Started", tone: "default" },
  pending_review: { label: "Pending Review", tone: "warning" },
  approved_awaiting_user: { label: "Approved — Awaiting User", tone: "accent" },
  active: { label: "Active", tone: "success" },
};

// Real, SQLite-backed ISP approval panel (Phase 2). This operates on the
// exact same /api/admin/accounts data as the "Real Accounts" table below
// and the /api/admin/isp/[id]/approve route -- there is no Zustand/
// localStorage involved anywhere in this component. Kept as-is per Phase
// 5 scope (the ISP approval workflow stays available outside User
// Management, which is why the fake table's own Approve/Reject column
// was removed rather than this panel).
function IspApprovalPanel({ accounts, now, onApproved }) {
  const [approvingId, setApprovingId] = useState(null);
  const [error, setError] = useState("");

  const pending = useMemo(
    () => accounts.filter((a) => a.ispStatus === "pending_review"),
    [accounts]
  );

  async function handleApprove(id) {
    setError("");
    setApprovingId(id);
    try {
      const res = await fetch(`/api/admin/isp/${id}/approve`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Approval failed.");
        return;
      }
      await onApproved();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setApprovingId(null);
    }
  }

  return (
    <GlassCard className="overflow-hidden">
      <div className="border-b border-white/10 px-5 py-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
          <ShieldCheck className="h-4 w-4 text-[#32B5FF]" /> Pending ISP Approvals
        </h3>
        <p className="text-xs text-[#B0B0B0]">
          Approving here only moves the account to &ldquo;approved, awaiting
          user&rdquo; -- earnings/connection only begin once the customer
          clicks &ldquo;I Approve&rdquo; on their own ISP Setup page.
        </p>
      </div>
      {error && (
        <div className="border-b border-white/10 px-5 py-3">
          <div className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">
            {error}
          </div>
        </div>
      )}
      {pending.length === 0 ? (
        <div className="px-5 py-4 text-xs text-[#707070]">
          No accounts currently pending ISP review.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[700px] text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-[#707070]">
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Submitted</th>
                <th className="px-4 py-3">Review Countdown</th>
                <th className="px-4 py-3">Approve</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((a) => {
                const deadline = a.ispSubmittedAt
                  ? new Date(a.ispSubmittedAt).getTime() + THREE_DAYS_MS
                  : null;
                const remaining = deadline != null ? Math.max(0, deadline - now) : null;
                return (
                  <tr key={a.id} className="border-b border-white/5 text-[#B0B0B0]">
                    <td className="px-4 py-3 font-mono text-xs text-white">{a.email}</td>
                    <td className="px-4 py-3 text-xs">
                      {a.ispSubmittedAt ? new Date(a.ispSubmittedAt).toLocaleString() : "—"}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {remaining != null ? formatCountdown(remaining) : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => handleApprove(a.id)}
                        disabled={approvingId === a.id}
                        className="flex items-center gap-1 rounded-lg bg-green-500/15 px-2 py-1.5 text-xs font-semibold text-green-400 hover:bg-green-500/25 disabled:opacity-50"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        {approvingId === a.id ? "Approving…" : "Approve"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </GlassCard>
  );
}

function SimulatePurchaseCard({ accounts, recentEmails, loadingAccounts, now, loadAccounts }) {
  const [status, setStatus] = useState("idle"); // idle | loading | success | error
  const [result, setResult] = useState(null);

  async function handleSimulate() {
    setStatus("loading");
    setResult(null);
    try {
      const res = await fetch("/api/webhooks/purchase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(TEST_PAYLOAD),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus("error");
        setResult(data);
        return;
      }
      setStatus("success");
      setResult(data);
      await loadAccounts();
    } catch (err) {
      setStatus("error");
      setResult({ error: err.message });
    }
  }

  return (
    <>
      <IspApprovalPanel accounts={accounts} now={now} onApproved={loadAccounts} />
      <GlassCard className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-white/10 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-sm font-semibold text-white">
              Test Scenario: Simulate JVZoo Purchase
            </h3>
            <p className="text-xs text-[#B0B0B0]">
              Sends a mock webhook payload ({TEST_PAYLOAD.email} /{" "}
              {TEST_PAYLOAD.password}) to <code>/api/webhooks/purchase</code>{" "}
              and creates a real account in the auth database.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={loadAccounts}
              title="Refresh account list"
              className="flex items-center gap-1 rounded-lg bg-white/5 px-3 py-2.5 text-xs font-semibold text-[#B0B0B0] hover:bg-white/10"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loadingAccounts ? "animate-spin" : ""}`} />
            </button>
            <AccentButton onClick={handleSimulate} disabled={status === "loading"}>
              <Zap className="h-4 w-4" />
              {status === "loading" ? "Sending..." : "Simulate JVZoo Purchase"}
            </AccentButton>
          </div>
        </div>

        {result && (
          <div className="border-b border-white/10 px-5 py-3">
            {status === "success" ? (
              <Badge tone="success" className="mb-2">
                <CheckCircle2 className="mr-1 h-3 w-3" /> Webhook succeeded
              </Badge>
            ) : (
              <Badge tone="danger" className="mb-2">
                <XCircle className="mr-1 h-3 w-3" /> Webhook failed
              </Badge>
            )}
            <pre className="max-h-40 overflow-auto rounded-lg bg-black/30 p-3 text-[11px] text-[#B0B0B0]">
              {JSON.stringify(result, null, 2)}
            </pre>
          </div>
        )}

        <div className="px-5 py-4">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#707070]">
            Email Log (outbox — &quot;Email Sent&quot; logic)
          </h4>
          {recentEmails.length === 0 ? (
            <p className="text-xs text-[#707070]">No emails sent yet.</p>
          ) : (
            <ul className="space-y-1">
              {recentEmails.map((m) => (
                <li key={m.id} className="flex items-center gap-2 text-xs text-[#B0B0B0]">
                  <Mail className="h-3 w-3 text-[#32B5FF]" />
                  <span className="font-mono text-white">{m.to_email}</span>
                  <span>— {m.subject}</span>
                  <Badge tone={m.sent_via === "sendgrid" ? "success" : "default"} className="text-[10px]">
                    {m.sent_via}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      </GlassCard>
    </>
  );
}

function UnlockAllModal({ account, onClose, onSubmitted }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleConfirm() {
    setError("");
    setSubmitting(true);
    try {
      const res = await fetch(`/api/admin/accounts/${account.id}/unlock-all`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Unable to unlock modules.");
        return;
      }
      onSubmitted(data.message);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-white/10 bg-[#1E1E1E] p-6"
      >
        <h3 className="mb-1 text-base font-bold text-white">Unlock All Modules</h3>
        <p className="mb-4 text-xs text-[#B0B0B0]">
          Unlock every module for{" "}
          <span className="font-semibold text-white">{account.name || account.email}</span> (
          {account.email}). This does not affect any other customer.
        </p>
        {error && <div className="mb-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</div>}
        <div className="flex gap-2">
          <GhostButton type="button" onClick={onClose} className="flex-1">
            Cancel
          </GhostButton>
          <AccentButton type="button" onClick={handleConfirm} disabled={submitting} className="flex-1">
            {submitting ? "Unlocking…" : "Confirm Unlock"}
          </AccentButton>
        </div>
      </div>
    </div>
  );
}

function BalanceModal({ account, onClose, onSubmitted }) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    const dollars = Number(amount);
    if (!Number.isFinite(dollars) || dollars === 0) {
      setError("Enter a non-zero dollar amount (use a negative number to debit).");
      return;
    }
    if (!reason.trim()) {
      setError("A reason is required.");
      return;
    }
    const amountCents = Math.round(dollars * 100);
    const verb = amountCents > 0 ? "credit" : "debit";
    if (!window.confirm(`Confirm: ${verb} ${formatCurrency(Math.abs(dollars))} to ${account.email}?`)) {
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/admin/accounts/${account.id}/balance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountCents, reason: reason.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Unable to adjust balance.");
        return;
      }
      onSubmitted();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-white/10 bg-[#1E1E1E] p-6"
      >
        <h3 className="mb-1 text-base font-bold text-white">Adjust Balance</h3>
        <p className="mb-4 text-xs text-[#707070]">{account.email}</p>
        <form onSubmit={handleSubmit} className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs text-[#B0B0B0]">Amount (USD, negative to debit)</span>
            <input
              autoFocus
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="25.00"
              className="w-full rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 text-sm text-white outline-none focus:ring-1 focus:ring-[#32B5FF]"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-[#B0B0B0]">Reason (required)</span>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Goodwill credit for support issue"
              className="w-full rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 text-sm text-white outline-none focus:ring-1 focus:ring-[#32B5FF]"
            />
          </label>
          {error && <div className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</div>}
          <div className="flex gap-2 pt-1">
            <GhostButton type="button" onClick={onClose} className="flex-1">
              Cancel
            </GhostButton>
            <AccentButton type="submit" disabled={submitting} className="flex-1">
              {submitting ? "Submitting…" : "Submit"}
            </AccentButton>
          </div>
        </form>
      </div>
    </div>
  );
}

function AccountRow({ account, currentAdminId, onChanged }) {
  const [emailDraft, setEmailDraft] = useState(account.email);
  const [editingEmail, setEditingEmail] = useState(false);
  const [savingEmail, setSavingEmail] = useState(false);
  const [emailError, setEmailError] = useState("");
  const [togglingDisable, setTogglingDisable] = useState(false);
  const [showBalanceModal, setShowBalanceModal] = useState(false);
  const [showUnlockModal, setShowUnlockModal] = useState(false);
  const [unlockMessage, setUnlockMessage] = useState("");

  const disabled = account.accountStatus === "disabled";
  const ispMeta = ISP_STATUS_LABELS[account.ispStatus] || ISP_STATUS_LABELS.not_started;

  async function handleSaveEmail() {
    const trimmed = emailDraft.trim();
    if (!trimmed || trimmed === account.email) {
      setEditingEmail(false);
      return;
    }
    setEmailError("");
    setSavingEmail(true);
    try {
      const res = await fetch(`/api/admin/accounts/${account.id}/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) {
        setEmailError(data.error || "Unable to update email.");
        return;
      }
      setEditingEmail(false);
      onChanged();
    } catch {
      setEmailError("Something went wrong. Please try again.");
    } finally {
      setSavingEmail(false);
    }
  }

  async function handleToggleDisable() {
    const nextDisabled = !disabled;
    const isSelfTarget = account.id === currentAdminId;

    if (nextDisabled) {
      if (isSelfTarget) {
        const confirmed = window.confirm(
          "This is your own admin account — you will be logged out immediately if you disable it. Continue?"
        );
        if (!confirmed) return;
      } else {
        const confirmed = window.confirm(`Disable ${account.email}? This immediately ends all their sessions.`);
        if (!confirmed) return;
      }
    } else {
      const confirmed = window.confirm(`Re-enable ${account.email}?`);
      if (!confirmed) return;
    }

    setTogglingDisable(true);
    try {
      const res = await fetch(`/api/admin/accounts/${account.id}/disable`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disabled: nextDisabled }),
      });
      const data = await res.json();
      if (res.ok) {
        onChanged();
      }
    } catch {
      // non-fatal; row just stays stale until next refresh
    } finally {
      setTogglingDisable(false);
    }
  }

  return (
    <tr className="border-b border-white/5 align-top text-[#B0B0B0] hover:bg-white/[0.03]">
      <td className="px-4 py-3">
        <div className="font-semibold text-white">{account.name}</div>
        {editingEmail ? (
          <div className="mt-1 flex items-center gap-1">
            <input
              value={emailDraft}
              onChange={(e) => setEmailDraft(e.target.value)}
              className="w-44 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-white outline-none focus:ring-1 focus:ring-[#32B5FF]"
            />
            <button
              onClick={handleSaveEmail}
              disabled={savingEmail}
              className="rounded-lg bg-[#32B5FF]/20 px-2 py-1 text-[10px] font-semibold text-[#32B5FF] disabled:opacity-50"
            >
              Save
            </button>
            <button
              onClick={() => {
                setEditingEmail(false);
                setEmailDraft(account.email);
                setEmailError("");
              }}
              className="text-[10px] text-[#707070] hover:text-white"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setEditingEmail(true)}
            className="text-xs text-[#707070] underline decoration-dotted hover:text-white"
            title="Click to edit email"
          >
            {account.email}
          </button>
        )}
        {emailError && <div className="mt-1 text-[10px] text-red-400">{emailError}</div>}
      </td>
      <td className="px-4 py-3 text-xs capitalize">{account.role}</td>
      <td className="px-4 py-3">
        <Badge tone={disabled ? "danger" : "success"}>{disabled ? "Disabled" : "Active"}</Badge>
      </td>
      <td className="px-4 py-3 font-mono text-xs text-white">
        {formatCurrency(centsToDollars(account.currentBalanceCents))}
      </td>
      <td className="px-4 py-3">
        <Badge tone={ispMeta.tone}>{ispMeta.label}</Badge>
      </td>
      <td className="px-4 py-3 text-xs">{new Date(account.createdAt).toLocaleDateString()}</td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {account.role === "customer" && (
            <>
              <button
                onClick={handleToggleDisable}
                disabled={togglingDisable}
                className={`flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-semibold disabled:opacity-50 ${
                  disabled
                    ? "bg-green-500/15 text-green-400 hover:bg-green-500/25"
                    : "bg-red-500/15 text-red-400 hover:bg-red-500/25"
                }`}
              >
                {disabled ? <Unlock className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
                {disabled ? "Re-enable" : "Disable"}
              </button>
              <button
                onClick={() => setShowBalanceModal(true)}
                className="flex items-center gap-1 rounded-lg bg-[#32B5FF]/15 px-2 py-1.5 text-xs font-semibold text-[#32B5FF] hover:bg-[#32B5FF]/25"
              >
                <DollarSign className="h-3.5 w-3.5" /> Balance
              </button>
              <button
                onClick={() => setShowUnlockModal(true)}
                className="flex items-center gap-1 rounded-lg bg-yellow-500/15 px-2 py-1.5 text-xs font-semibold text-yellow-400 hover:bg-yellow-500/25"
              >
                <Sparkles className="h-3.5 w-3.5" /> Unlock All Modules
              </button>
            </>
          )}
        </div>
        {unlockMessage && <div className="mt-1 text-[10px] text-green-400">{unlockMessage}</div>}
      </td>
      {showBalanceModal && (
        <BalanceModal
          account={account}
          onClose={() => setShowBalanceModal(false)}
          onSubmitted={() => {
            setShowBalanceModal(false);
            onChanged();
          }}
        />
      )}
      {showUnlockModal && (
        <UnlockAllModal
          account={account}
          onClose={() => setShowUnlockModal(false)}
          onSubmitted={(message) => {
            setShowUnlockModal(false);
            setUnlockMessage(message || "Modules unlocked.");
            onChanged();
          }}
        />
      )}
    </tr>
  );
}

export default function AdminUsersPage() {
  const { account: currentAdmin } = useAccount();
  const now = useLiveClock(1000);
  const hasMounted = useHasMounted();

  const [accounts, setAccounts] = useState([]);
  const [recentEmails, setRecentEmails] = useState([]);
  const [loadingAccounts, setLoadingAccounts] = useState(false);

  async function loadAccounts() {
    setLoadingAccounts(true);
    try {
      const res = await fetch("/api/admin/accounts");
      const data = await res.json();
      setAccounts(data.accounts || []);
      setRecentEmails(data.recentEmails || []);
    } catch {
      // ignore, table just stays stale
    } finally {
      setLoadingAccounts(false);
    }
  }

  useEffect(() => {
    // fetch-on-mount, same pattern as lib/useAccount.js.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial
    loadAccounts();
  }, []);

  const customerRows = useMemo(() => accounts.filter((a) => a.role === "customer"), [accounts]);
  const adminRows = useMemo(() => accounts.filter((a) => a.role !== "customer"), [accounts]);

  if (!hasMounted) {
    return (
      <div className="space-y-6">
        <GlassCard className="overflow-hidden">
          <div className="border-b border-white/10 px-5 py-4">
            <h3 className="text-sm font-semibold text-white">User Management</h3>
            <p className="text-xs text-[#B0B0B0]">Loading users…</p>
          </div>
          <div className="p-10 text-center text-sm text-[#707070]">
            Loading admin data…
          </div>
        </GlassCard>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SimulatePurchaseCard
        accounts={accounts}
        recentEmails={recentEmails}
        loadingAccounts={loadingAccounts}
        now={now}
        loadAccounts={loadAccounts}
      />
      <GlassCard className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-white/10 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-sm font-semibold text-white">User Management</h3>
            <p className="text-xs text-[#B0B0B0]">
              Real accounts sourced from SQLite (data/auth.db). &quot;Unlock All Modules&quot;
              is available per-customer in the Actions column below.
            </p>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-[#707070]">
                <th className="px-4 py-3">User</th>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Balance</th>
                <th className="px-4 py-3">ISP Status</th>
                <th className="px-4 py-3">Created</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {customerRows.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  currentAdminId={currentAdmin?.id}
                  onChanged={loadAccounts}
                />
              ))}
              {adminRows.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  currentAdminId={currentAdmin?.id}
                  onChanged={loadAccounts}
                />
              ))}
              {accounts.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-xs text-[#707070]">
                    No accounts yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </GlassCard>
    </div>
  );
}
