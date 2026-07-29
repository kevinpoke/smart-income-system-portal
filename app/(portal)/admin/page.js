"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAccount } from "@/lib/useAccount";
import { useLiveClock } from "@/lib/useLiveClock";
import { useHasMounted } from "@/lib/useHasMounted";
import { formatCurrency, centsToDollars, formatCountdown } from "@/lib/mockData";
import { GlassCard, Badge, AccentButton, GhostButton } from "@/components/ui/Primitives";
import {
  Lock,
  Unlock,
  DollarSign,
  Sparkles,
  Search,
  X,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Send,
  UserPlus,
  Filter,
} from "lucide-react";

const ISP_STATUS_LABELS = {
  not_started: { label: "Not Started", tone: "default" },
  pending_review: { label: "Pending Review", tone: "warning" },
  approved_awaiting_user: { label: "Approved — Awaiting User", tone: "accent" },
  active: { label: "Active", tone: "success" },
};

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
          Unlock every training module and video for{" "}
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

// Portal reliability pass: broadcast "Send Message" confirmation modal.
function BroadcastModal({ recipientIds, onClose, onSubmitted }) {
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const requestKeyRef = useRef(null);
  function getRequestKey() {
    if (!requestKeyRef.current) {
      requestKeyRef.current = `bcast_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    }
    return requestKeyRef.current;
  }

  async function handleSend() {
    const text = message.trim();
    if (!text || submitting) return;
    setError("");
    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/support/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestKey: getRequestKey(),
          message: text,
          recipientIds,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Unable to send broadcast message.");
        return;
      }
      setResult(data);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={submitting ? undefined : onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#1E1E1E] p-6"
      >
        {result ? (
          <>
            <div className="mb-3 flex items-center gap-2 text-green-400">
              <h3 className="text-base font-bold text-white">Broadcast Sent</h3>
            </div>
            <div className="mb-4 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                <div className="text-lg font-bold text-green-400">{result.sent}</div>
                <div className="text-[10px] uppercase tracking-wide text-[#707070]">Sent</div>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                <div className="text-lg font-bold text-yellow-400">{result.skipped}</div>
                <div className="text-[10px] uppercase tracking-wide text-[#707070]">Skipped</div>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                <div className="text-lg font-bold text-red-400">{result.failed}</div>
                <div className="text-[10px] uppercase tracking-wide text-[#707070]">Failed</div>
              </div>
            </div>
            <AccentButton className="w-full" onClick={() => onSubmitted()}>
              Done
            </AccentButton>
          </>
        ) : (
          <>
            <h3 className="mb-1 text-base font-bold text-white">Send Message</h3>
            <p className="mb-4 text-xs text-[#B0B0B0]">
              This message will be sent to{" "}
              <span className="font-semibold text-white">
                {recipientIds.length} selected customer{recipientIds.length === 1 ? "" : "s"}
              </span>{" "}
              as an ordinary Support message in their own conversation. No customer will see who
              else received it.
            </p>
            <label className="block">
              <span className="mb-1 block text-xs text-[#B0B0B0]">Message</span>
              <textarea
                autoFocus
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={4}
                placeholder="Type the broadcast message..."
                className="w-full resize-none rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 text-sm text-white outline-none focus:ring-1 focus:ring-[#32B5FF]"
              />
            </label>
            {message.trim() && (
              <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.03] p-3">
                <div className="mb-1 text-[10px] uppercase tracking-wide text-[#707070]">Preview</div>
                <div className="max-w-[70%] rounded-2xl bg-white/10 px-4 py-2.5 text-sm text-white">
                  {message.trim()}
                </div>
              </div>
            )}
            {error && (
              <div className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</div>
            )}
            <div className="mt-4 flex gap-2">
              <GhostButton type="button" onClick={onClose} disabled={submitting} className="flex-1">
                Cancel
              </GhostButton>
              <AccentButton
                type="button"
                onClick={handleSend}
                disabled={submitting || !message.trim()}
                className="flex-1"
              >
                <Send className="h-4 w-4" />
                {submitting ? "Sending…" : `Send to ${recipientIds.length}`}
              </AccentButton>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function CreateUserModal({ onClose, onCreated }) {
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    password: "",
    startingBalance: "0.00",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/accounts/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Unable to create user.");
        return;
      }
      onCreated();
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
        <h3 className="mb-4 text-base font-bold text-white">Create User</h3>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-xs text-[#B0B0B0]">First Name</span>
              <input
                required
                value={form.firstName}
                onChange={(e) => update("firstName", e.target.value)}
                className="w-full rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 text-sm text-white outline-none focus:ring-1 focus:ring-[#32B5FF]"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-[#B0B0B0]">Last Name</span>
              <input
                required
                value={form.lastName}
                onChange={(e) => update("lastName", e.target.value)}
                className="w-full rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 text-sm text-white outline-none focus:ring-1 focus:ring-[#32B5FF]"
              />
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-xs text-[#B0B0B0]">Email</span>
            <input
              required
              type="email"
              value={form.email}
              onChange={(e) => update("email", e.target.value)}
              className="w-full rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 text-sm text-white outline-none focus:ring-1 focus:ring-[#32B5FF]"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-[#B0B0B0]">Password</span>
            <input
              required
              type="password"
              minLength={8}
              value={form.password}
              onChange={(e) => update("password", e.target.value)}
              className="w-full rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 text-sm text-white outline-none focus:ring-1 focus:ring-[#32B5FF]"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-[#B0B0B0]">Starting Balance (USD)</span>
            <input
              value={form.startingBalance}
              onChange={(e) => update("startingBalance", e.target.value)}
              placeholder="0.00"
              className="w-full rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 text-sm text-white outline-none focus:ring-1 focus:ring-[#32B5FF]"
            />
          </label>
          {error && <div className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</div>}
          <div className="flex gap-2 pt-1">
            <GhostButton type="button" onClick={onClose} className="flex-1">
              Cancel
            </GhostButton>
            <AccentButton type="submit" disabled={submitting} className="flex-1">
              {submitting ? "Creating…" : "Create User"}
            </AccentButton>
          </div>
        </form>
      </div>
    </div>
  );
}

function formatLastLogin(iso) {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString();
}

function WithdrawCell({ account, now }) {
  if (account.payoutAvailable) {
    return <Badge tone="success">Available</Badge>;
  }
  if (!account.payoutTargetAt) {
    return <span className="text-xs text-[#707070]">—</span>;
  }
  const remaining = Math.max(0, new Date(account.payoutTargetAt).getTime() - now);
  return <span className="font-mono text-xs text-white">{formatCountdown(remaining)}</span>;
}

function AccountRow({
  account,
  currentAdminId,
  onChanged,
  now,
  selectable,
  selected,
  onToggleSelect,
}) {
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
      {selectable && (
        <td className="px-4 py-3">
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect(account.id)}
            aria-label={`Select ${account.email}`}
            className="h-4 w-4 rounded border-white/20 bg-white/5 accent-[#32B5FF]"
          />
        </td>
      )}
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
      <td className="px-4 py-3">
        <Badge tone={disabled ? "danger" : "success"}>{disabled ? "Disabled" : "Active"}</Badge>
      </td>
      <td className="px-4 py-3">
        <Badge tone={ispMeta.tone}>{ispMeta.label}</Badge>
      </td>
      <td className="px-4 py-3 font-mono text-xs text-white">
        {formatCurrency(centsToDollars(account.currentBalanceCents))}
      </td>
      <td className="px-4 py-3 text-xs">{new Date(account.createdAt).toLocaleDateString()}</td>
      <td className="px-4 py-3 text-xs">{formatLastLogin(account.lastLoginAt)}</td>
      <td className="px-4 py-3">
        <WithdrawCell account={account} now={now} />
      </td>
      <td className="px-4 py-3">
        <Badge tone={account.waitlistJoined ? "accent" : "default"}>
          {account.waitlistJoined ? "Yes" : "No"}
        </Badge>
      </td>
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

// Debounce hook: returns `value` only after it has stopped changing for
// `delayMs` -- used for the User Management search box and dollar-amount
// filters so typing doesn't refetch on every keystroke.
function useDebouncedValue(value, delayMs) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

const DEFAULT_FILTERS = {
  status: "all",
  isp: "all",
  balanceMin: "",
  balanceMax: "",
  joinedFrom: "",
  joinedTo: "",
  lastLogin: "all",
  lastLoginFrom: "",
  lastLoginTo: "",
  withdraw: "all",
  waitlist: "all",
};

function isFilterActive(filters, key) {
  if (key === "status") return filters.status !== "all";
  if (key === "isp") return filters.isp !== "all";
  if (key === "balance") return Boolean(filters.balanceMin || filters.balanceMax);
  if (key === "joined") return Boolean(filters.joinedFrom || filters.joinedTo);
  if (key === "lastLogin") return filters.lastLogin !== "all";
  if (key === "withdraw") return filters.withdraw !== "all";
  if (key === "waitlist") return filters.waitlist !== "all";
  return false;
}

// Small filter-popover wrapper shared by every column filter button --
// shows a visible highlighted state on the trigger button when that
// column's filter is active (per spec: "Show a visible indicator when a
// column filter is active").
function ColumnFilter({ label, active, children }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={`Filter ${label}`}
        className={`ml-1 inline-flex items-center rounded p-0.5 ${
          active ? "text-[#32B5FF]" : "text-[#707070] hover:text-white"
        }`}
      >
        <Filter className="h-3 w-3" fill={active ? "currentColor" : "none"} />
      </button>
      {open && (
        <div
          className="absolute left-0 top-full z-30 mt-1 w-56 rounded-xl border border-white/10 bg-[#1E1E1E] p-3 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          {children}
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="mt-2 w-full rounded-lg bg-white/5 px-2 py-1.5 text-[11px] font-semibold text-[#B0B0B0] hover:bg-white/10"
          >
            Done
          </button>
        </div>
      )}
    </span>
  );
}

const filterInputClass =
  "w-full rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-white outline-none focus:ring-1 focus:ring-[#32B5FF]";
const filterSelectClass = filterInputClass;

export default function AdminUsersPage() {
  const { account: currentAdmin } = useAccount();
  const now = useLiveClock(1000);
  const hasMounted = useHasMounted();

  const [accounts, setAccounts] = useState([]);
  const [recentEmails, setRecentEmails] = useState([]);
  const [loadingAccounts, setLoadingAccounts] = useState(false);

  const [searchInput, setSearchInput] = useState("");
  const searchTerm = useDebouncedValue(searchInput, 300);
  const [sortBy, setSortBy] = useState("createdAt");
  const [sortDir, setSortDir] = useState("desc");
  const [page, setPage] = useState(1);
  const pageSize = 30;
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const debouncedBalanceMin = useDebouncedValue(filters.balanceMin, 400);
  const debouncedBalanceMax = useDebouncedValue(filters.balanceMax, 400);

  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [showBroadcastModal, setShowBroadcastModal] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);

  function setFilter(key, value) {
    setFilters((f) => ({ ...f, [key]: value }));
  }

  function clearAllFilters() {
    setFilters(DEFAULT_FILTERS);
  }

  const anyFilterActive = useMemo(
    () =>
      ["status", "isp", "balance", "joined", "lastLogin", "withdraw", "waitlist"].some((k) =>
        isFilterActive(filters, k)
      ),
    [filters]
  );

  async function loadAccounts() {
    setLoadingAccounts(true);
    try {
      const params = new URLSearchParams();
      if (searchTerm.trim()) params.set("q", searchTerm.trim());
      params.set("sortBy", sortBy);
      params.set("sortDir", sortDir);
      params.set("page", String(page));
      params.set("pageSize", String(pageSize));
      if (filters.status !== "all") params.set("status", filters.status);
      if (filters.isp !== "all") params.set("isp", filters.isp);
      if (debouncedBalanceMin) params.set("balanceMin", debouncedBalanceMin);
      if (debouncedBalanceMax) params.set("balanceMax", debouncedBalanceMax);
      if (filters.joinedFrom) params.set("joinedFrom", filters.joinedFrom);
      if (filters.joinedTo) params.set("joinedTo", filters.joinedTo);
      if (filters.lastLogin !== "all") params.set("lastLogin", filters.lastLogin);
      if (filters.lastLogin === "range") {
        if (filters.lastLoginFrom) params.set("lastLoginFrom", filters.lastLoginFrom);
        if (filters.lastLoginTo) params.set("lastLoginTo", filters.lastLoginTo);
      }
      if (filters.withdraw !== "all") params.set("withdraw", filters.withdraw);
      if (filters.waitlist !== "all") params.set("waitlist", filters.waitlist);

      const res = await fetch(`/api/admin/accounts?${params.toString()}`, { cache: "no-store" });
      const data = await res.json();
      setAccounts(data.accounts || []);
      setRecentEmails(data.recentEmails || []);
      setTotal(data.total || 0);
      setTotalPages(data.totalPages || 1);
    } catch {
      // ignore, table just stays stale
    } finally {
      setLoadingAccounts(false);
    }
  }

  useEffect(() => {
    // fetch-on-mount + whenever a search/sort/page/filter param changes,
    // same pattern as lib/useAccount.js.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial
    loadAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    searchTerm,
    sortBy,
    sortDir,
    page,
    filters.status,
    filters.isp,
    debouncedBalanceMin,
    debouncedBalanceMax,
    filters.joinedFrom,
    filters.joinedTo,
    filters.lastLogin,
    filters.lastLoginFrom,
    filters.lastLoginTo,
    filters.withdraw,
    filters.waitlist,
  ]);

  // Reset to page 1 whenever search/sort/filters change (a stale page
  // number from a previous, larger result set could otherwise land past
  // the end of a new, smaller filtered set). Filters PERSIST across this
  // reset and across sort changes -- only the page number resets.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPage(1);
  }, [
    searchTerm,
    sortBy,
    sortDir,
    filters.status,
    filters.isp,
    debouncedBalanceMin,
    debouncedBalanceMax,
    filters.joinedFrom,
    filters.joinedTo,
    filters.lastLogin,
    filters.lastLoginFrom,
    filters.lastLoginTo,
    filters.withdraw,
    filters.waitlist,
  ]);

  // Clear selection whenever the underlying filtered/sorted/paginated
  // result set changes -- selection must always refer to currently
  // visible/filtered rows, never a stale set from a previous query.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedIds(new Set());
  }, [searchTerm, sortBy, sortDir, page, filters]);

  const customerRows = useMemo(() => accounts.filter((a) => a.role === "customer"), [accounts]);
  const adminRows = useMemo(() => accounts.filter((a) => a.role !== "customer"), [accounts]);

  const allCustomerIdsOnPage = useMemo(() => customerRows.map((a) => a.id), [customerRows]);
  const allSelectedOnPage =
    allCustomerIdsOnPage.length > 0 && allCustomerIdsOnPage.every((id) => selectedIds.has(id));
  const someSelectedOnPage = allCustomerIdsOnPage.some((id) => selectedIds.has(id));

  function toggleSelectOne(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAllOnPage() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allSelectedOnPage) {
        for (const id of allCustomerIdsOnPage) next.delete(id);
      } else {
        for (const id of allCustomerIdsOnPage) next.add(id);
      }
      return next;
    });
  }

  function handleSortClick(column) {
    if (sortBy === column) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortBy(column);
      setSortDir("desc");
    }
  }

  if (!hasMounted) {
    return (
      <div className="space-y-6">
        <GlassCard className="overflow-hidden">
          <div className="border-b border-white/10 px-5 py-4">
            <h3 className="text-sm font-semibold text-white">User Management</h3>
            <p className="text-xs text-[#B0B0B0]">Loading users…</p>
          </div>
          <div className="p-10 text-center text-sm text-[#707070]">Loading admin data…</div>
        </GlassCard>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <GlassCard className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-white/10 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-sm font-semibold text-white">User Management</h3>
            <p className="text-xs text-[#B0B0B0]">
              Real accounts sourced from SQLite (data/auth.db). &quot;Unlock All Modules&quot; is
              available per-customer in the Actions column below.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#707070]" />
              <input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search name or email…"
                className="w-56 rounded-xl border border-white/10 bg-white/5 py-2 pl-8 pr-8 text-xs text-white placeholder-[#707070] outline-none focus:ring-1 focus:ring-[#32B5FF]"
              />
              {searchInput && (
                <button
                  onClick={() => setSearchInput("")}
                  title="Clear search"
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[#707070] hover:text-white"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <button
              onClick={() => handleSortClick("createdAt")}
              className={`flex items-center gap-1 rounded-lg px-2.5 py-2 text-[11px] font-semibold ${
                sortBy === "createdAt" ? "bg-[#32B5FF]/20 text-[#32B5FF]" : "bg-white/5 text-[#B0B0B0] hover:bg-white/10"
              }`}
              title="Sort by Created Date"
            >
              <ArrowUpDown className="h-3 w-3" />
              Created {sortBy === "createdAt" ? (sortDir === "desc" ? "(Newest)" : "(Oldest)") : ""}
            </button>
            <button
              onClick={() => handleSortClick("lastLoginAt")}
              className={`flex items-center gap-1 rounded-lg px-2.5 py-2 text-[11px] font-semibold ${
                sortBy === "lastLoginAt" ? "bg-[#32B5FF]/20 text-[#32B5FF]" : "bg-white/5 text-[#B0B0B0] hover:bg-white/10"
              }`}
              title="Sort by Last Login"
            >
              <ArrowUpDown className="h-3 w-3" />
              Last Login {sortBy === "lastLoginAt" ? (sortDir === "desc" ? "(Newest)" : "(Oldest)") : ""}
            </button>
            {anyFilterActive && (
              <button
                onClick={clearAllFilters}
                className="flex items-center gap-1 rounded-lg bg-red-500/10 px-2.5 py-2 text-[11px] font-semibold text-red-400 hover:bg-red-500/20"
              >
                <X className="h-3 w-3" /> Clear all filters
              </button>
            )}
            <AccentButton onClick={() => setShowCreateModal(true)}>
              <UserPlus className="h-4 w-4" /> Create User
            </AccentButton>
          </div>
        </div>

        {selectedIds.size > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-[#32B5FF]/5 px-5 py-3">
            <span className="text-xs font-semibold text-white">
              {selectedIds.size} customer{selectedIds.size === 1 ? "" : "s"} selected
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setSelectedIds(new Set())}
                className="rounded-lg bg-white/5 px-3 py-1.5 text-xs font-semibold text-[#B0B0B0] hover:bg-white/10"
              >
                Clear
              </button>
              <AccentButton onClick={() => setShowBroadcastModal(true)}>
                <Send className="h-3.5 w-3.5" /> Send Message
              </AccentButton>
            </div>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1300px] text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-[#707070]">
                <th className="px-4 py-3">
                  <input
                    type="checkbox"
                    checked={allSelectedOnPage}
                    ref={(el) => {
                      if (el) el.indeterminate = !allSelectedOnPage && someSelectedOnPage;
                    }}
                    onChange={toggleSelectAllOnPage}
                    disabled={allCustomerIdsOnPage.length === 0}
                    aria-label="Select all filtered customers"
                    className="h-4 w-4 rounded border-white/20 bg-white/5 accent-[#32B5FF]"
                  />
                </th>
                <th className="px-4 py-3">User</th>
                <th className="px-4 py-3">
                  <span className="inline-flex items-center">
                    Status
                    <ColumnFilter label="Status" active={isFilterActive(filters, "status")}>
                      <select
                        value={filters.status}
                        onChange={(e) => setFilter("status", e.target.value)}
                        className={filterSelectClass}
                      >
                        <option value="all">All</option>
                        <option value="active">Active</option>
                        <option value="disabled">Disabled</option>
                      </select>
                    </ColumnFilter>
                  </span>
                </th>
                <th className="px-4 py-3">
                  <span className="inline-flex items-center">
                    ISP
                    <ColumnFilter label="ISP" active={isFilterActive(filters, "isp")}>
                      <select
                        value={filters.isp}
                        onChange={(e) => setFilter("isp", e.target.value)}
                        className={filterSelectClass}
                      >
                        <option value="all">All</option>
                        <option value="on">On (actively running)</option>
                        <option value="off">Off</option>
                      </select>
                    </ColumnFilter>
                  </span>
                </th>
                <th className="px-4 py-3">
                  <span className="inline-flex items-center">
                    Balance
                    <ColumnFilter label="Balance" active={isFilterActive(filters, "balance")}>
                      <div className="space-y-2">
                        <label className="block">
                          <span className="mb-1 block text-[10px] text-[#707070]">Min ($)</span>
                          <input
                            value={filters.balanceMin}
                            onChange={(e) => setFilter("balanceMin", e.target.value)}
                            placeholder="0.00"
                            className={filterInputClass}
                          />
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-[10px] text-[#707070]">Max ($)</span>
                          <input
                            value={filters.balanceMax}
                            onChange={(e) => setFilter("balanceMax", e.target.value)}
                            placeholder="1000.00"
                            className={filterInputClass}
                          />
                        </label>
                      </div>
                    </ColumnFilter>
                  </span>
                </th>
                <th className="px-4 py-3">
                  <span className="inline-flex items-center">
                    Joined
                    <ColumnFilter label="Joined" active={isFilterActive(filters, "joined")}>
                      <div className="space-y-2">
                        <label className="block">
                          <span className="mb-1 block text-[10px] text-[#707070]">From</span>
                          <input
                            type="date"
                            value={filters.joinedFrom}
                            onChange={(e) => setFilter("joinedFrom", e.target.value)}
                            className={filterInputClass}
                          />
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-[10px] text-[#707070]">To</span>
                          <input
                            type="date"
                            value={filters.joinedTo}
                            onChange={(e) => setFilter("joinedTo", e.target.value)}
                            className={filterInputClass}
                          />
                        </label>
                      </div>
                    </ColumnFilter>
                  </span>
                </th>
                <th className="px-4 py-3">
                  <span className="inline-flex items-center">
                    Last Login
                    <ColumnFilter label="Last Login" active={isFilterActive(filters, "lastLogin")}>
                      <div className="space-y-2">
                        <select
                          value={filters.lastLogin}
                          onChange={(e) => setFilter("lastLogin", e.target.value)}
                          className={filterSelectClass}
                        >
                          <option value="all">All</option>
                          <option value="never">Never</option>
                          <option value="range">Date range</option>
                        </select>
                        {filters.lastLogin === "range" && (
                          <>
                            <label className="block">
                              <span className="mb-1 block text-[10px] text-[#707070]">From</span>
                              <input
                                type="date"
                                value={filters.lastLoginFrom}
                                onChange={(e) => setFilter("lastLoginFrom", e.target.value)}
                                className={filterInputClass}
                              />
                            </label>
                            <label className="block">
                              <span className="mb-1 block text-[10px] text-[#707070]">To</span>
                              <input
                                type="date"
                                value={filters.lastLoginTo}
                                onChange={(e) => setFilter("lastLoginTo", e.target.value)}
                                className={filterInputClass}
                              />
                            </label>
                          </>
                        )}
                      </div>
                    </ColumnFilter>
                  </span>
                </th>
                <th className="px-4 py-3">
                  <span className="inline-flex items-center">
                    Withdraw
                    <ColumnFilter label="Withdraw" active={isFilterActive(filters, "withdraw")}>
                      <select
                        value={filters.withdraw}
                        onChange={(e) => setFilter("withdraw", e.target.value)}
                        className={filterSelectClass}
                      >
                        <option value="all">All</option>
                        <option value="available">Available now</option>
                        <option value="not_available">Not yet available</option>
                      </select>
                    </ColumnFilter>
                  </span>
                </th>
                <th className="px-4 py-3">
                  <span className="inline-flex items-center">
                    Waitlist
                    <ColumnFilter label="Waitlist" active={isFilterActive(filters, "waitlist")}>
                      <select
                        value={filters.waitlist}
                        onChange={(e) => setFilter("waitlist", e.target.value)}
                        className={filterSelectClass}
                      >
                        <option value="all">All</option>
                        <option value="yes">Yes</option>
                        <option value="no">No</option>
                      </select>
                    </ColumnFilter>
                  </span>
                </th>
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
                  now={now}
                  selectable
                  selected={selectedIds.has(account.id)}
                  onToggleSelect={toggleSelectOne}
                />
              ))}
              {adminRows.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  currentAdminId={currentAdmin?.id}
                  onChanged={loadAccounts}
                  now={now}
                  selectable={false}
                />
              ))}
              {accounts.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-6 text-center text-xs text-[#707070]">
                    {searchTerm || anyFilterActive
                      ? "No customers match your search/filters."
                      : "No accounts yet."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-col items-center justify-between gap-2 border-t border-white/10 px-5 py-3 sm:flex-row">
          <span className="text-[11px] text-[#707070]">
            {total === 0
              ? "0 results"
              : `Showing ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total}`}
            {loadingAccounts && " · Loading…"}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="flex items-center gap-1 rounded-lg bg-white/5 px-2.5 py-1.5 text-xs font-semibold text-[#B0B0B0] hover:bg-white/10 disabled:opacity-30"
            >
              <ChevronLeft className="h-3.5 w-3.5" /> Prev
            </button>
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter((p) => p === 1 || p === totalPages || Math.abs(p - page) <= 1)
              .reduce((acc, p, idx, arr) => {
                if (idx > 0 && p - arr[idx - 1] > 1) acc.push("...");
                acc.push(p);
                return acc;
              }, [])
              .map((p, idx) =>
                p === "..." ? (
                  <span key={`ellipsis-${idx}`} className="text-[11px] text-[#707070]">
                    …
                  </span>
                ) : (
                  <button
                    key={p}
                    onClick={() => setPage(p)}
                    className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold ${
                      p === page ? "bg-[#32B5FF]/20 text-[#32B5FF]" : "bg-white/5 text-[#B0B0B0] hover:bg-white/10"
                    }`}
                  >
                    {p}
                  </button>
                )
              )}
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="flex items-center gap-1 rounded-lg bg-white/5 px-2.5 py-1.5 text-xs font-semibold text-[#B0B0B0] hover:bg-white/10 disabled:opacity-30"
            >
              Next <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </GlassCard>

      {showBroadcastModal && (
        <BroadcastModal
          recipientIds={[...selectedIds]}
          onClose={() => setShowBroadcastModal(false)}
          onSubmitted={() => {
            setShowBroadcastModal(false);
            setSelectedIds(new Set());
            loadAccounts();
          }}
        />
      )}
      {showCreateModal && (
        <CreateUserModal
          onClose={() => setShowCreateModal(false)}
          onCreated={() => {
            setShowCreateModal(false);
            loadAccounts();
          }}
        />
      )}
    </div>
  );
}
