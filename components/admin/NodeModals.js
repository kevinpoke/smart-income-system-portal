"use client";

import { useEffect, useRef, useState } from "react";
import { GhostButton, AccentButton } from "@/components/ui/Primitives";
import NodeTierBadge from "@/components/ui/NodeTierBadge";
import { NODE_TIERS, TIER_KEYS } from "@/lib/nodeTiers";
import { formatCurrency, centsToDollars } from "@/lib/mockData";
import { Trash2 } from "lucide-react";

// Edit Node popup: lists every owned Node for one customer account, each
// with its own tier <select> + Save button scoped to that single Node
// (never a page-wide "save all" -- editing one Node's tier must never
// touch any other Node's row, matching the PATCH route's
// `WHERE id = ? AND account_id = ?` scoping in lib/ownedNodes.js
// updateOwnedNodeTier()).
//
// Rendered at the page level (app/(portal)/admin/page.js), outside the
// <table>/<tbody> -- never as a direct child of a <tr>, matching the
// same hydration-safety pattern already used for every other modal in
// this file (Balance/Unlock/Broadcast/CreateUser).
export function EditNodePopup({ account, onClose, onChanged }) {
  const [nodes, setNodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [savingNodeId, setSavingNodeId] = useState(null);
  const [pendingTiers, setPendingTiers] = useState({});
  const [removingNodeId, setRemovingNodeId] = useState(null);

  async function loadNodes() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/accounts/${account.id}/nodes`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Unable to load Nodes.");
        return;
      }
      setNodes(data.nodes || []);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // fetch-on-mount, same pattern as every other admin data-loading
    // effect in this app (see lib/useAccount.js).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadNodes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.id]);

  async function handleSave(node) {
    const newTier = pendingTiers[node.id] ?? node.tierKey;
    if (newTier === node.tierKey) return; // no-op, nothing changed for this row
    setSavingNodeId(node.id);
    setError("");
    try {
      const res = await fetch(`/api/admin/accounts/${account.id}/nodes/${node.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: newTier }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Unable to update Node tier.");
        return;
      }
      await loadNodes();
      onChanged();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSavingNodeId(null);
    }
  }

  // Admin-only Remove Node: requires an explicit confirmation before
  // firing the DELETE request (per spec: "require a clear confirmation
  // before removal"), shows a per-row pending state while the request is
  // in flight (disables both the Save and Remove controls for that row
  // so a double-click can't fire two overlapping removal requests for
  // the same Node), and on success reloads this popup's Node list AND
  // notifies the parent (onChanged -> loadAccounts()) so the User
  // Management row's Node column/count refreshes too -- "refresh the
  // popup and User Management row after success."
  async function handleRemove(node) {
    const confirmed = window.confirm(
      `Remove Node #${node.displayNodeId} for ${account.email}? This stops all future earnings for this Node but keeps its earnings history intact. This cannot be undone.`
    );
    if (!confirmed) return;
    setRemovingNodeId(node.id);
    setError("");
    try {
      const res = await fetch(`/api/admin/accounts/${account.id}/nodes/${node.id}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Unable to remove Node.");
        return;
      }
      await loadNodes();
      onChanged();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setRemovingNodeId(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
    >
      {/* max-h + overflow-y-auto: keeps the modal usable on short/mobile
          viewports by scrolling ITS OWN content instead of overflowing
          the screen -- same "centered, internally scrolling" pattern as
          the existing ProfileModal. */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-white/10 bg-[#1E1E1E] p-6"
      >
        <h3 className="mb-1 text-base font-bold text-white">Edit Nodes</h3>
        <p className="mb-4 text-xs text-[#707070]">{account.email}</p>

        {error && (
          <div className="mb-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</div>
        )}

        {loading ? (
          <div className="py-6 text-center text-xs text-[#707070]">Loading Nodes…</div>
        ) : nodes.length === 0 ? (
          <div className="py-6 text-center text-xs text-[#707070]">
            This account has no Nodes yet.
          </div>
        ) : (
          <div className="space-y-3">
            {nodes.map((node) => {
              const pendingTier = pendingTiers[node.id] ?? node.tierKey;
              const changed = pendingTier !== node.tierKey;
              return (
                <div
                  key={node.id}
                  className="rounded-xl border border-white/10 bg-white/[0.03] p-3"
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div>
                      <div className="font-mono text-xs text-white">#{node.displayNodeId}</div>
                      <div className="text-[10px] text-[#707070]">
                        Started {new Date(node.createdAt).toLocaleDateString()}
                        {node.isPrimary ? " · Primary" : ""}
                      </div>
                    </div>
                    <NodeTierBadge tierKey={node.tierKey} tier={node.tier} />
                  </div>
                  <div className="mb-2 text-[10px] text-[#707070]">
                    Current rate: {formatCurrency(centsToDollars(node.earningRateCents))}/mo
                  </div>
                  <div className="flex items-center gap-2">
                    <select
                      value={pendingTier}
                      onChange={(e) =>
                        setPendingTiers((prev) => ({ ...prev, [node.id]: e.target.value }))
                      }
                      aria-label={`Tier for Node ${node.displayNodeId}`}
                      disabled={removingNodeId === node.id}
                      className="flex-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-white outline-none focus:ring-1 focus:ring-[#32B5FF] disabled:opacity-50"
                    >
                      {TIER_KEYS.map((key) => (
                        <option key={key} value={key}>
                          {NODE_TIERS[key].displayName}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => handleSave(node)}
                      disabled={!changed || savingNodeId === node.id || removingNodeId === node.id}
                      className="rounded-lg bg-[#32B5FF]/20 px-3 py-1.5 text-xs font-semibold text-[#32B5FF] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {savingNodeId === node.id ? "Saving…" : "Save"}
                    </button>
                    {/* Node removal (User Management -> Remove Node):
                        admin-only, requires confirmation (see
                        handleRemove above), shows a pending state, and
                        is disabled while a save is also in flight for
                        this same row so the two actions can never race
                        against each other. */}
                    <button
                      type="button"
                      onClick={() => handleRemove(node)}
                      disabled={savingNodeId === node.id || removingNodeId === node.id}
                      aria-label={`Remove Node ${node.displayNodeId} for ${account.email}`}
                      title="Remove Node"
                      className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-red-500/15 text-red-400 hover:bg-red-500/25 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {removingNodeId === node.id ? (
                        <span className="text-[10px] font-semibold">…</span>
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-4">
          <GhostButton type="button" onClick={onClose} className="w-full">
            Close
          </GhostButton>
        </div>
      </div>
    </div>
  );
}

// Add Node popup: tier selection + Confirm. Generates a fresh
// requestKey the moment the popup mounts (i.e. once per genuinely NEW
// popup open -- the ref is created fresh every time this component is
// mounted, since the parent only renders it when `addNodeModalAccount`
// is set) so a double-click retry of the SAME submission reuses the
// SAME requestKey and is caught by the server's node_add_requests
// idempotency table, while opening a brand new popup (even for the same
// account) always gets a fresh key.
export function AddNodePopup({ account, onClose, onAdded }) {
  const [tierKey, setTierKey] = useState("standard");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const requestKeyRef = useRef(null);
  function getRequestKey() {
    if (!requestKeyRef.current) {
      requestKeyRef.current = `nodeadd_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    }
    return requestKeyRef.current;
  }

  async function handleConfirm() {
    if (submitting) return; // client-side guard against a double-click while a request
    // is already in flight; the SERVER's node_add_requests UNIQUE
    // constraint remains the authoritative source of truth for
    // idempotency even if this guard is somehow bypassed (e.g. two
    // separate tabs).
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/accounts/${account.id}/nodes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: tierKey, requestKey: getRequestKey() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Unable to add Node.");
        return;
      }
      onAdded();
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
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl border border-white/10 bg-[#1E1E1E] p-6"
      >
        <h3 className="mb-1 text-base font-bold text-white">Add Node</h3>
        <p className="mb-4 text-xs text-[#707070]">{account.email}</p>

        <div className="space-y-2">
          {TIER_KEYS.map((key) => {
            const tier = NODE_TIERS[key];
            const selected = tierKey === key;
            return (
              <label
                key={key}
                className={`flex cursor-pointer items-center justify-between rounded-xl border px-3.5 py-2.5 text-sm transition ${
                  selected
                    ? "border-[#32B5FF]/60 bg-[#32B5FF]/10"
                    : "border-white/10 bg-white/5 hover:bg-white/[0.07]"
                }`}
              >
                <span className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="add-node-tier"
                    value={key}
                    checked={selected}
                    onChange={() => setTierKey(key)}
                    className="h-3.5 w-3.5 accent-[#32B5FF]"
                  />
                  <NodeTierBadge tierKey={key} tier={tier.displayName} />
                </span>
                <span className="font-mono text-xs text-[#B0B0B0]">
                  {formatCurrency(tier.minCents / 100)}–{formatCurrency(tier.maxCents / 100)}/mo
                </span>
              </label>
            );
          })}
        </div>

        {error && (
          <div className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</div>
        )}

        <div className="mt-4 flex gap-2">
          <GhostButton type="button" onClick={onClose} disabled={submitting} className="flex-1">
            Cancel
          </GhostButton>
          <AccentButton type="button" onClick={handleConfirm} disabled={submitting} className="flex-1">
            {submitting ? "Adding…" : "Confirm"}
          </AccentButton>
        </div>
      </div>
    </div>
  );
}
