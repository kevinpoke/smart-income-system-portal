"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAccount } from "@/lib/useAccount";
import { useLiveClock } from "@/lib/useLiveClock";
import { useHasMounted } from "@/lib/useHasMounted";
import { formatCurrency, centsToDollars, formatCountdown } from "@/lib/mockData";
import { GlassCard, Badge, AccentButton, GhostButton } from "@/components/ui/Primitives";
import NodeTierBadge from "@/components/ui/NodeTierBadge";
import LocationCell from "@/components/admin/LocationCell";
import { EditNodePopup, AddNodePopup } from "@/components/admin/NodeModals";
import {
  Lock,
  Unlock,
  DollarSign,
  Sparkles,
  Search,
  X,
  ArrowUp,
  ArrowDown,
  ChevronLeft,
  ChevronRight,
  Send,
  UserPlus,
  Pencil,
  Plus,
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
  onOpenAddBalance,
  onOpenUnlockModules,
  unlockMessage,
  onOpenEditNodes,
  onOpenAddNode,
}) {
  const [emailDraft, setEmailDraft] = useState(account.email);
  const [editingEmail, setEditingEmail] = useState(false);
  const [savingEmail, setSavingEmail] = useState(false);
  const [emailError, setEmailError] = useState("");
  const [togglingDisable, setTogglingDisable] = useState(false);

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
        <td className="w-8 px-2 py-3">
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
      <td className="px-4 py-3">
        {account.role === "customer" ? (
          <div className="flex items-center gap-1.5">
            {account.primaryNodeTier ? (
              <NodeTierBadge tierKey={account.primaryNodeTierKey} tier={account.primaryNodeTier} />
            ) : (
              <span className="text-xs text-[#707070]">No Node</span>
            )}
            {account.nodeCount > 1 && (
              <span className="text-[10px] text-[#707070]">+{account.nodeCount - 1}</span>
            )}
            <button
              onClick={() => onOpenEditNodes(account)}
              aria-label={`Edit Nodes for ${account.email}`}
              title="Edit Nodes"
              className="flex h-6 w-6 items-center justify-center rounded-md bg-white/5 text-[#B0B0B0] hover:bg-white/10 hover:text-white"
            >
              <Pencil className="h-3 w-3" />
            </button>
            <button
              onClick={() => onOpenAddNode(account)}
              aria-label={`Add Node for ${account.email}`}
              title="Add Node"
              className="flex h-6 w-6 items-center justify-center rounded-md bg-white/5 text-[#B0B0B0] hover:bg-white/10 hover:text-white"
            >
              <Plus className="h-3 w-3" />
            </button>
          </div>
        ) : (
          <span className="text-xs text-[#707070]">—</span>
        )}
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
        {account.role === "customer" ? (
          <LocationCell account={account} field="city" onSaved={onChanged} />
        ) : (
          <span className="text-xs text-[#707070]">—</span>
        )}
      </td>
      <td className="px-4 py-3">
        {account.role === "customer" ? (
          <LocationCell account={account} field="state" onSaved={onChanged} />
        ) : (
          <span className="text-xs text-[#707070]">—</span>
        )}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1.5">
          {account.role === "customer" && (
            <>
              <button
                onClick={handleToggleDisable}
                disabled={togglingDisable}
                aria-label={disabled ? `Enable account ${account.email}` : `Disable account ${account.email}`}
                title={disabled ? "Enable Account" : "Disable Account"}
                className={`group relative flex h-8 w-8 items-center justify-center rounded-lg disabled:opacity-50 ${
                  disabled
                    ? "bg-green-500/15 text-green-400 hover:bg-green-500/25"
                    : "bg-red-500/15 text-red-400 hover:bg-red-500/25"
                }`}
              >
                {disabled ? <Unlock className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
                <span className="pointer-events-none absolute bottom-full left-1/2 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-md bg-black px-2 py-1 text-[10px] font-medium text-white opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                  {disabled ? "Enable Account" : "Disable Account"}
                </span>
              </button>
              <button
                onClick={() => onOpenAddBalance(account)}
                aria-label={`Add balance for ${account.email}`}
                title="Add Balance"
                className="group relative flex h-8 w-8 items-center justify-center rounded-lg bg-[#32B5FF]/15 text-[#32B5FF] hover:bg-[#32B5FF]/25"
              >
                <DollarSign className="h-3.5 w-3.5" />
                <span className="pointer-events-none absolute bottom-full left-1/2 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-md bg-black px-2 py-1 text-[10px] font-medium text-white opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                  Add Balance
                </span>
              </button>
              <button
                onClick={() => onOpenUnlockModules(account)}
                aria-label={`Unlock modules for ${account.email}`}
                title="Unlock Modules"
                className="group relative flex h-8 w-8 items-center justify-center rounded-lg bg-yellow-500/15 text-yellow-400 hover:bg-yellow-500/25"
              >
                <Sparkles className="h-3.5 w-3.5" />
                <span className="pointer-events-none absolute bottom-full left-1/2 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-md bg-black px-2 py-1 text-[10px] font-medium text-white opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                  Unlock Modules
                </span>
              </button>
            </>
          )}
        </div>
        {unlockMessage && <div className="mt-1 text-[10px] text-green-400">{unlockMessage}</div>}
      </td>
    </tr>
  );
}

// Debounce hook: returns `value` only after it has stopped changing for
// `delayMs` -- used for the User Management search box so typing
// doesn't refetch on every keystroke.
function useDebouncedValue(value, delayMs) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

// User Management redesign: shared sortable column header. Renders the
// label as a clickable button with a visible ascending/descending
// indicator (per spec: "show a visible ascending/descending indicator")
// -- clicking a column that's already the active sort flips direction;
// clicking a different column switches to it starting at `defaultDir`.
function SortableHeader({ column, label, sortBy, sortDir, onSort, defaultDir = "desc", align }) {
  const active = sortBy === column;
  return (
    <button
      type="button"
      onClick={() => onSort(column, defaultDir)}
      className={`inline-flex items-center gap-1 whitespace-nowrap font-semibold uppercase tracking-wide transition-colors ${
        align === "right" ? "flex-row-reverse" : ""
      } ${active ? "text-[#32B5FF]" : "text-[#707070] hover:text-white"}`}
      title={`Sort by ${label}`}
    >
      {label}
      {active ? (
        sortDir === "asc" ? (
          <ArrowUp className="h-3 w-3" />
        ) : (
          <ArrowDown className="h-3 w-3" />
        )
      ) : (
        <ArrowUpDownGhost />
      )}
    </button>
  );
}

// Faint, always-present up/down glyph shown on inactive sortable
// columns so every column visibly affords sorting even before it's
// clicked (a11y + discoverability), without competing visually with the
// bright active-column indicator.
function ArrowUpDownGhost() {
  return (
    <span className="flex flex-col leading-none text-[#707070]/40">
      <ArrowUp className="h-2.5 w-2.5" />
      <ArrowDown className="-mt-1 h-2.5 w-2.5" />
    </span>
  );
}

export default function AdminUsersPage() {
  const { account: currentAdmin } = useAccount();
  const now = useLiveClock(1000);
  const hasMounted = useHasMounted();

  const [accounts, setAccounts] = useState([]);
  const [recentEmails, setRecentEmails] = useState([]);
  const [loadingAccounts, setLoadingAccounts] = useState(false);

  const [searchInput, setSearchInput] = useState("");
  const searchTerm = useDebouncedValue(searchInput, 300);
  // User Management redesign: per-column FILTERS replaced entirely by
  // per-column SORTING -- "joined" (newest-first) is the default, same
  // as the old default filter-free view.
  const [sortBy, setSortBy] = useState("joined");
  const [sortDir, setSortDir] = useState("desc");
  const [page, setPage] = useState(1);
  const pageSize = 30;
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [showBroadcastModal, setShowBroadcastModal] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  // Hydration fix: these two modals used to be rendered directly inside
  // the <tr> returned by AccountRow (invalid HTML -- a <tr> may only
  // contain <td>/<th>). State is lifted here to the page level instead;
  // AccountRow now only calls onOpenAddBalance(account)/
  // onOpenUnlockModules(account) and both modals are rendered once,
  // after the closing </table>, same pattern already used for
  // BroadcastModal/CreateUserModal.
  const [balanceModalAccount, setBalanceModalAccount] = useState(null);
  const [unlockModalAccount, setUnlockModalAccount] = useState(null);
  // Same lifted-to-page-root pattern for the new Node popups -- never
  // rendered as a direct child of a <tr>/<table>/<tbody>.
  const [editNodesAccount, setEditNodesAccount] = useState(null);
  const [addNodeAccount, setAddNodeAccount] = useState(null);
  // Per-account "Modules unlocked." confirmation text shown inline in
  // that account's row -- keyed by account id so each row keeps its own
  // message independently, matching the previous per-row local state.
  const [unlockMessages, setUnlockMessages] = useState({});

  async function loadAccounts() {
    setLoadingAccounts(true);
    try {
      const params = new URLSearchParams();
      if (searchTerm.trim()) params.set("q", searchTerm.trim());
      params.set("sortBy", sortBy);
      params.set("sortDir", sortDir);
      params.set("page", String(page));
      params.set("pageSize", String(pageSize));

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
    // fetch-on-mount + whenever a search/sort/page param changes, same
    // pattern as lib/useAccount.js.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial
    loadAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm, sortBy, sortDir, page]);

  // Reset to page 1 whenever search/sort changes (a stale page number
  // from a previous, larger result set could otherwise land past the
  // end of a new, smaller/differently-ordered set). Search PERSISTS
  // across this reset and across sort changes -- only the page number
  // resets (per spec: "reset to page 1... preserve global search").
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPage(1);
  }, [searchTerm, sortBy, sortDir]);

  // Clear selection whenever the underlying filtered/sorted/paginated
  // result set changes -- selection must always refer to currently
  // visible/filtered rows, never a stale set from a previous query.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedIds(new Set());
  }, [searchTerm, sortBy, sortDir, page]);

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

  function handleSort(column, defaultDir) {
    if (sortBy === column) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortBy(column);
      setSortDir(defaultDir);
    }
  }

  if (!hasMounted) {
    return (
      <div className="space-y-6">
        <GlassCard className="overflow-hidden">
          <div className="border-b border-white/10 px-5 py-4">
            <h3 className="text-sm font-semibold text-white">User Management</h3>
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
          <h3 className="text-sm font-semibold text-white">User Management</h3>
          <div className="flex flex-wrap items-center justify-end gap-2 sm:flex-nowrap">
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
          <table className="w-full min-w-[1550px] text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-[#707070]">
                <th className="w-8 px-2 py-3">
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
                  <SortableHeader
                    column="status"
                    label="Status"
                    sortBy={sortBy}
                    sortDir={sortDir}
                    onSort={handleSort}
                    defaultDir="asc"
                  />
                </th>
                <th className="px-4 py-3">
                  <SortableHeader
                    column="isp"
                    label="ISP"
                    sortBy={sortBy}
                    sortDir={sortDir}
                    onSort={handleSort}
                    defaultDir="asc"
                  />
                </th>
                <th className="px-4 py-3">
                  <SortableHeader
                    column="node"
                    label="Node"
                    sortBy={sortBy}
                    sortDir={sortDir}
                    onSort={handleSort}
                    defaultDir="asc"
                  />
                </th>
                <th className="px-4 py-3">
                  <SortableHeader
                    column="balance"
                    label="Balance"
                    sortBy={sortBy}
                    sortDir={sortDir}
                    onSort={handleSort}
                    defaultDir="desc"
                  />
                </th>
                <th className="px-4 py-3">
                  <SortableHeader
                    column="joined"
                    label="Joined"
                    sortBy={sortBy}
                    sortDir={sortDir}
                    onSort={handleSort}
                    defaultDir="desc"
                  />
                </th>
                <th className="px-4 py-3">
                  <SortableHeader
                    column="lastLogin"
                    label="Last Login"
                    sortBy={sortBy}
                    sortDir={sortDir}
                    onSort={handleSort}
                    defaultDir="desc"
                  />
                </th>
                <th className="px-4 py-3">
                  <SortableHeader
                    column="withdraw"
                    label="Withdraw"
                    sortBy={sortBy}
                    sortDir={sortDir}
                    onSort={handleSort}
                    defaultDir="asc"
                  />
                </th>
                <th className="px-4 py-3">
                  <SortableHeader
                    column="waitlist"
                    label="Waitlist"
                    sortBy={sortBy}
                    sortDir={sortDir}
                    onSort={handleSort}
                    defaultDir="asc"
                  />
                </th>
                <th className="px-4 py-3">
                  <SortableHeader
                    column="city"
                    label="City"
                    sortBy={sortBy}
                    sortDir={sortDir}
                    onSort={handleSort}
                    defaultDir="asc"
                  />
                </th>
                <th className="px-4 py-3">
                  <SortableHeader
                    column="state"
                    label="State"
                    sortBy={sortBy}
                    sortDir={sortDir}
                    onSort={handleSort}
                    defaultDir="asc"
                  />
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
                  onOpenAddBalance={setBalanceModalAccount}
                  onOpenUnlockModules={setUnlockModalAccount}
                  unlockMessage={unlockMessages[account.id]}
                  onOpenEditNodes={setEditNodesAccount}
                  onOpenAddNode={setAddNodeAccount}
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
                  onOpenAddBalance={setBalanceModalAccount}
                  onOpenUnlockModules={setUnlockModalAccount}
                  unlockMessage={unlockMessages[account.id]}
                  onOpenEditNodes={setEditNodesAccount}
                  onOpenAddNode={setAddNodeAccount}
                />
              ))}
              {accounts.length === 0 && (
                <tr>
                  <td colSpan={12} className="px-4 py-6 text-center text-xs text-[#707070]">
                    {searchTerm ? "No customers match your search." : "No accounts yet."}
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

      {balanceModalAccount && (
        <BalanceModal
          account={balanceModalAccount}
          onClose={() => setBalanceModalAccount(null)}
          onSubmitted={() => {
            setBalanceModalAccount(null);
            loadAccounts();
          }}
        />
      )}
      {unlockModalAccount && (
        <UnlockAllModal
          account={unlockModalAccount}
          onClose={() => setUnlockModalAccount(null)}
          onSubmitted={(message) => {
            const targetId = unlockModalAccount.id;
            setUnlockModalAccount(null);
            setUnlockMessages((prev) => ({ ...prev, [targetId]: message || "Modules unlocked." }));
            loadAccounts();
          }}
        />
      )}
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
      {editNodesAccount && (
        <EditNodePopup
          account={editNodesAccount}
          onClose={() => setEditNodesAccount(null)}
          onChanged={loadAccounts}
        />
      )}
      {addNodeAccount && (
        <AddNodePopup
          account={addNodeAccount}
          onClose={() => setAddNodeAccount(null)}
          onAdded={() => {
            setAddNodeAccount(null);
            loadAccounts();
          }}
        />
      )}
    </div>
  );
}
