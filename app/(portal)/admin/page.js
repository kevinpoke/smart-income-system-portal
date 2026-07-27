"use client";

import { useEffect, useMemo, useState } from "react";
import { useStore } from "@/lib/store";
import { useLiveClock } from "@/lib/useLiveClock";
import { useHasMounted } from "@/lib/useHasMounted";
import { totalEarnings } from "@/lib/earnings";
import { MODULES_META, formatCurrency, formatCompactDuration, formatCountdown } from "@/lib/mockData";
import { GlassCard, Badge, AccentButton, GhostButton } from "@/components/ui/Primitives";
import { CheckCircle2, XCircle, Mail, Send, Zap, RefreshCw, ShieldCheck } from "lucide-react";

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
// localStorage involved anywhere in this component. The full admin
// customer-management UI (search, create account, balance/multiplier
// edits, etc.) is Phase 5 scope and is intentionally not built yet.
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

function SimulatePurchaseCard() {
  const [status, setStatus] = useState("idle"); // idle | loading | success | error
  const [result, setResult] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [recentEmails, setRecentEmails] = useState([]);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const now = useLiveClock(1000);

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
    loadAccounts();
  }, []);

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
          Real Accounts (SQLite: data/auth.db)
        </h4>
        {accounts.length === 0 ? (
          <p className="text-xs text-[#707070]">No accounts created yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px] text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-[#707070]">
                  <th className="px-2 py-2">Email</th>
                  <th className="px-2 py-2">Name</th>
                  <th className="px-2 py-2">Status</th>
                  <th className="px-2 py-2">ISP Status</th>
                  <th className="px-2 py-2">Created</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => {
                  const ispMeta = ISP_STATUS_LABELS[a.ispStatus] || ISP_STATUS_LABELS.not_started;
                  return (
                    <tr key={a.id} className="border-b border-white/5 text-[#B0B0B0]">
                      <td className="px-2 py-2 font-mono text-xs text-white">{a.email}</td>
                      <td className="px-2 py-2 text-xs">{a.name}</td>
                      <td className="px-2 py-2">
                        <Badge tone={a.status.startsWith("New") ? "warning" : a.status === "Disabled" ? "danger" : "success"}>
                          {a.status}
                        </Badge>
                      </td>
                      <td className="px-2 py-2">
                        <Badge tone={ispMeta.tone}>{ispMeta.label}</Badge>
                      </td>
                      <td className="px-2 py-2 text-xs">
                        {new Date(a.createdAt).toLocaleString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <h4 className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-[#707070]">
          Email Log (outbox — "Email Sent" logic)
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

const STATUS_LABELS = {
  new: { label: "New", tone: "default" },
  isp_pending: { label: "Pending Approval", tone: "warning" },
  active: { label: "Active", tone: "success" },
};

function ModuleUnlockDropdown({ userId, currentModules }) {
  const adminUnlockModule = useStore((s) => s.adminUnlockModule);
  const [value, setValue] = useState("");

  return (
    <div className="flex items-center gap-1.5">
      <select
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-white outline-none focus:ring-1 focus:ring-[#32B5FF]"
      >
        <option value="">Select module...</option>
        {MODULES_META.map((m) => (
          <option key={m.id} value={m.id}>
            {m.id}. {m.title}
          </option>
        ))}
      </select>
      <button
        disabled={!value}
        onClick={() => {
          adminUnlockModule(userId, Number(value));
          setValue("");
        }}
        className="rounded-lg bg-[#32B5FF]/15 px-2 py-1.5 text-xs font-semibold text-[#32B5FF] disabled:opacity-30"
      >
        Unlock
      </button>
    </div>
  );
}

function IspSetupCell({ user, now }) {
  if (!user.ispSubmittedAt) {
    return <span className="text-xs text-[#707070]">Not submitted</span>;
  }
  const elapsed = now - new Date(user.ispSubmittedAt).getTime();
  const hoursElapsed = elapsed / 3600000;
  const overThreshold = hoursElapsed > 60 && user.status === "isp_pending";

  return (
    <div className="space-y-1">
      <div className="font-mono text-xs text-white">
        {formatCompactDuration(elapsed)}
      </div>
      {overThreshold && (
        <Badge tone="warning" className="text-[10px]">
          <Mail className="mr-1 h-2.5 w-2.5" /> Auto-email queued
        </Badge>
      )}
    </div>
  );
}

function ApproveRejectCell({ user }) {
  const adminApproveIsp = useStore((s) => s.adminApproveIsp);
  const adminRejectIsp = useStore((s) => s.adminRejectIsp);

  if (user.status !== "isp_pending") {
    return <span className="text-xs text-[#707070]">—</span>;
  }

  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={() => adminApproveIsp(user.id)}
        title="Send Approve Participation button now"
        className="flex items-center gap-1 rounded-lg bg-green-500/15 px-2 py-1.5 text-xs font-semibold text-green-400 hover:bg-green-500/25"
      >
        <CheckCircle2 className="h-3.5 w-3.5" /> Approve
      </button>
      <button
        onClick={() => adminRejectIsp(user.id)}
        className="flex items-center gap-1 rounded-lg bg-red-500/15 px-2 py-1.5 text-xs font-semibold text-red-400 hover:bg-red-500/25"
      >
        <XCircle className="h-3.5 w-3.5" /> Reject
      </button>
    </div>
  );
}

export default function AdminUsersPage() {
  const users = useStore((s) => s.users);
  const adminCompleteTestWithdrawal = useStore((s) => s.adminCompleteTestWithdrawal);
  const now = useLiveClock(1000);

  const rows = useMemo(() => Object.values(users), [users]);
  const hasMounted = useHasMounted();

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
      <SimulatePurchaseCard />
      <GlassCard className="overflow-hidden">
        <div className="border-b border-white/10 px-5 py-4">
          <h3 className="text-sm font-semibold text-white">User Management</h3>
          <p className="text-xs text-[#B0B0B0]">
            User name/email sourced from JVZoo purchase webhook (simulated).
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1200px] text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-[#707070]">
                <th className="px-4 py-3">User</th>
                <th className="px-4 py-3">Balance</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Join Date</th>
                <th className="px-4 py-3">Last Login</th>
                <th className="px-4 py-3">Upsells</th>
                <th className="px-4 py-3">Last Support</th>
                <th className="px-4 py-3">Unlock Module</th>
                <th className="px-4 py-3">Time Since ISP Setup</th>
                <th className="px-4 py-3">Approve/Reject</th>
                <th className="px-4 py-3">Test Withdrawal</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((user) => {
                const statusMeta = STATUS_LABELS[user.status] || STATUS_LABELS.new;
                const balance = totalEarnings(user, now);
                return (
                  <tr
                    key={user.id}
                    className="border-b border-white/5 align-top text-[#B0B0B0] hover:bg-white/[0.03]"
                  >
                    <td className="px-4 py-3">
                      <div className="font-semibold text-white">{user.name}</div>
                      <div className="text-xs text-[#707070]">{user.email}</div>
                    </td>
                    <td className="px-4 py-3 font-mono text-white">
                      {formatCurrency(balance)}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={statusMeta.tone}>{statusMeta.label}</Badge>
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {new Date(user.joinDate).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {new Date(user.lastLogin).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-xs">{user.upsellsPurchased}</td>
                    <td className="px-4 py-3 text-xs">
                      {user.lastSupportContact
                        ? new Date(user.lastSupportContact).toLocaleDateString()
                        : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <ModuleUnlockDropdown userId={user.id} currentModules={user.modules} />
                    </td>
                    <td className="px-4 py-3">
                      <IspSetupCell user={user} now={now} />
                    </td>
                    <td className="px-4 py-3">
                      <ApproveRejectCell user={user} />
                    </td>
                    <td className="px-4 py-3">
                      {user.withdrawal.testWithdrawalStatus === "requested" ? (
                        <button
                          onClick={() => adminCompleteTestWithdrawal(user.id)}
                          className="flex items-center gap-1 rounded-lg bg-[#32B5FF]/15 px-2 py-1.5 text-xs font-semibold text-[#32B5FF] hover:bg-[#32B5FF]/25"
                        >
                          <Send className="h-3.5 w-3.5" /> Mark Complete
                        </button>
                      ) : (
                        <span className="text-xs text-[#707070]">
                          {user.withdrawal.testWithdrawalStatus === "complete"
                            ? "Completed"
                            : "—"}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </GlassCard>
    </div>
  );
}
