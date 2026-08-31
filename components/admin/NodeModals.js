"use client";

import { useEffect, useRef, useState } from "react";
import { GhostButton, AccentButton, Badge } from "@/components/ui/Primitives";
import NodeTierBadge from "@/components/ui/NodeTierBadge";
import { NODE_TIERS, TIER_KEYS, tierKeyToBridgeDisplayName } from "@/lib/nodeTiers";
import { formatCurrency, centsToDollars } from "@/lib/mockData";
import { formatAdminDate } from "@/lib/adminTime";
import { Trash2 } from "lucide-react";

// Edit Bridge popup: lists every owned Bridge for one customer account,
// each with its own tier <select> + Save button scoped to that single
// Bridge (never a page-wide "save all" -- editing one Bridge's tier must
// never touch any other Bridge's row, matching the PATCH route's
// `WHERE id = ? AND account_id = ?` scoping in lib/ownedNodes.js
// updateOwnedNodeTier()). Tier <select> OPTION LABELS show the new
// customer/admin-facing Bridge names ("Bridge"/"Golden Bridge"/"XI
// Bridge") via tierKeyToBridgeDisplayName() -- their underlying
// `value`/tierKey attributes remain "standard"/"super"/"nova" unchanged,
// per spec section 7.
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
        setError(data.error || "Unable to load Bridges.");
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
        setError(data.error || "Unable to update Bridge tier.");
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

  // Admin-only Remove Bridge: requires an explicit confirmation before
  // firing the DELETE request (per spec: "require a clear confirmation
  // before removal"), shows a per-row pending state while the request is
  // in flight (disables both the Save and Remove controls for that row
  // so a double-click can't fire two overlapping removal requests for
  // the same Bridge), and on success reloads this popup's Bridge list
  // AND notifies the parent (onChanged -> loadAccounts()) so the User
  // Management row's Bridge column/count refreshes too -- "refresh the
  // popup and User Management row after success."
  async function handleRemove(node) {
    const confirmed = window.confirm(
      `Remove Bridge #${node.displayNodeId} for ${account.email}? This stops all future earnings for this Bridge but keeps its earnings history intact. This cannot be undone.`
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
        setError(data.error || "Unable to remove Bridge.");
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
        <h3 className="mb-1 text-base font-bold text-white">Edit Bridges</h3>
        <p className="mb-4 text-xs text-[#707070]">{account.email}</p>

        {error && (
          <div className="mb-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</div>
        )}

        {loading ? (
          <div className="py-6 text-center text-xs text-[#707070]">Loading Bridges…</div>
        ) : nodes.length === 0 ? (
          <div className="py-6 text-center text-xs text-[#707070]">
            This account has no Bridges yet.
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
                        Started {formatAdminDate(node.createdAt)}
                        {node.isPrimary ? " · Primary" : ""}
                      </div>
                    </div>
                    {/* ISP support controls + special bridges batch: one of
                        the four EXACT special Bridges always shows its OWN
                        catalog display name ("Golden Bridge"/"IX Bridge"),
                        never the generic internal tier badge -- see
                        lib/specialBridges.js for why "IX" (not "XI") is
                        required here specifically. */}
                    {node.isSpecialBridge ? (
                      <Badge tone="accent" className="text-xs">
                        {node.specialBridgeDisplayName}
                      </Badge>
                    ) : (
                      <NodeTierBadge tierKey={node.tierKey} tier={node.tier} />
                    )}
                  </div>
                  <div className="mb-2 text-[10px] text-[#707070]">
                    Current rate: {formatCurrency(centsToDollars(node.earningRateCents))}/mo
                  </div>
                  <div className="flex items-center gap-2">
                    {/* Special Bridges have a FIXED catalog identity (exact
                        Bridge ID/type per spec) -- their tier is never
                        admin-editable via this generic tier <select>, only
                        removable via the same mechanism every other Bridge
                        uses (spec section 17). */}
                    {node.isSpecialBridge ? (
                      <div className="flex-1 rounded-lg border border-white/10 bg-white/[0.02] px-2.5 py-1.5 text-[11px] text-[#707070]">
                        Special Bridge — tier is fixed
                      </div>
                    ) : (
                      <>
                        <select
                          value={pendingTier}
                          onChange={(e) =>
                            setPendingTiers((prev) => ({ ...prev, [node.id]: e.target.value }))
                          }
                          aria-label={`Tier for Bridge ${node.displayNodeId}`}
                          disabled={removingNodeId === node.id}
                          className="flex-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-white outline-none focus:ring-1 focus:ring-[#32B5FF] disabled:opacity-50"
                        >
                          {TIER_KEYS.map((key) => (
                            <option key={key} value={key}>
                              {tierKeyToBridgeDisplayName(key)}
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
                      </>
                    )}
                    {/* Bridge removal (User Management -> Remove Bridge):
                        admin-only, requires confirmation (see
                        handleRemove above), shows a pending state, and
                        is disabled while a save is also in flight for
                        this same row so the two actions can never race
                        against each other. Works identically for
                        special Bridges -- same mechanism, per spec
                        section 17 ("do not create a second independent
                        removal system") -- removal frees the exact
                        Bridge ID for reassignment (see
                        lib/ownedNodes.js#removeOwnedNode /
                        assignSpecialBridge's active-only uniqueness
                        check). */}
                    <button
                      type="button"
                      onClick={() => handleRemove(node)}
                      disabled={savingNodeId === node.id || removingNodeId === node.id}
                      aria-label={`Remove Bridge ${node.displayNodeId} for ${account.email}`}
                      title="Remove Bridge"
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

// Add Bridge popup: tier selection + Confirm, PLUS (ISP support controls
// + special bridges batch) an admin-only "Special Bridge" mode that lets
// the admin assign one of the four EXACT catalog Bridges (Golden
// #284373, IX #841837/#952341/#934211 -- see lib/specialBridges.js)
// instead of the normal random-rate Standard/Golden/XI roll. Generates a
// fresh requestKey the moment the popup mounts (i.e. once per genuinely
// NEW popup open -- the ref is created fresh every time this component
// is mounted, since the parent only renders it when `addNodeModalAccount`
// is set) so a double-click retry of the SAME submission reuses the
// SAME requestKey and is caught by the server's node_add_requests
// idempotency table, while opening a brand new popup (even for the same
// account) always gets a fresh key.
export function AddNodePopup({ account, onClose, onAdded }) {
  const [mode, setMode] = useState("standard"); // "standard" | "special"
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

  // Special Bridges tab state: the four-item catalog + live assignment
  // status, fetched from the admin-only GET /api/admin/accounts/[id]/
  // special-bridge route (which itself does not depend on `account` --
  // it reflects GLOBAL assignment status across every customer -- but is
  // scoped under this account's popup for a consistent admin UX).
  const [specialBridges, setSpecialBridges] = useState([]);
  const [specialLoading, setSpecialLoading] = useState(true);
  const [selectedBridgeId, setSelectedBridgeId] = useState(null);

  async function loadSpecialBridges() {
    setSpecialLoading(true);
    try {
      const res = await fetch(`/api/admin/accounts/${account.id}/special-bridge`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (res.ok) {
        setSpecialBridges(data.bridges || []);
        // Default-select the first still-available bridge, if any.
        const firstAvailable = (data.bridges || []).find((b) => !b.assignedToAccountId);
        setSelectedBridgeId(firstAvailable?.id ?? null);
      }
    } catch {
      // non-fatal; the Special Bridge tab just shows an empty/error state
    } finally {
      setSpecialLoading(false);
    }
  }

  useEffect(() => {
    if (mode === "special" && specialBridges.length === 0) {
      // fetch-on-first-open-of-tab, same pattern as every other
      // fetch-on-mount effect in this codebase (see lib/useAccount.js) --
      // loadSpecialBridges() itself calls setState, but only inside an
      // async callback after the fetch resolves, never synchronously
      // within this effect body.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      loadSpecialBridges();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  async function handleConfirm() {
    if (submitting) return; // client-side guard against a double-click while a request
    // is already in flight; the SERVER's node_add_requests UNIQUE
    // constraint remains the authoritative source of truth for
    // idempotency even if this guard is somehow bypassed (e.g. two
    // separate tabs).
    setSubmitting(true);
    setError("");
    try {
      let res;
      if (mode === "special") {
        if (!selectedBridgeId) {
          setError("Select a special Bridge to assign.");
          return;
        }
        res = await fetch(`/api/admin/accounts/${account.id}/special-bridge`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bridgeId: selectedBridgeId }),
        });
      } else {
        res = await fetch(`/api/admin/accounts/${account.id}/nodes`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tier: tierKey, requestKey: getRequestKey() }),
        });
      }
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Unable to add Bridge.");
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
        <h3 className="mb-1 text-base font-bold text-white">Add Bridge</h3>
        <p className="mb-4 text-xs text-[#707070]">{account.email}</p>

        <div className="mb-4 flex gap-1.5 rounded-xl bg-white/5 p-1">
          <button
            type="button"
            onClick={() => setMode("standard")}
            disabled={submitting}
            className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              mode === "standard" ? "bg-[#32B5FF] text-[#06121a]" : "text-[#B0B0B0] hover:text-white"
            }`}
          >
            Standard
          </button>
          <button
            type="button"
            onClick={() => setMode("special")}
            disabled={submitting}
            className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              mode === "special" ? "bg-[#32B5FF] text-[#06121a]" : "text-[#B0B0B0] hover:text-white"
            }`}
          >
            Special Bridge
          </button>
        </div>

        {mode === "standard" && (
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
                    <NodeTierBadge tierKey={key} tier={tierKeyToBridgeDisplayName(key)} />
                  </span>
                  <span className="font-mono text-xs text-[#B0B0B0]">
                    {formatCurrency(tier.minCents / 100)}–{formatCurrency(tier.maxCents / 100)}/mo
                  </span>
                </label>
              );
            })}
          </div>
        )}

        {mode === "special" && (
          <div className="space-y-2">
            {specialLoading ? (
              <div className="py-4 text-center text-xs text-[#707070]">Loading special Bridges…</div>
            ) : (
              specialBridges.map((b) => {
                const selected = selectedBridgeId === b.id;
                const taken = Boolean(b.assignedToAccountId);
                return (
                  <label
                    key={b.id}
                    className={`flex cursor-pointer items-center justify-between rounded-xl border px-3.5 py-2.5 text-sm transition ${
                      taken
                        ? "cursor-not-allowed border-white/5 bg-white/[0.02] opacity-50"
                        : selected
                          ? "border-[#32B5FF]/60 bg-[#32B5FF]/10"
                          : "border-white/10 bg-white/5 hover:bg-white/[0.07]"
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="add-special-bridge"
                        value={b.id}
                        checked={selected}
                        disabled={taken}
                        onChange={() => setSelectedBridgeId(b.id)}
                        className="h-3.5 w-3.5 accent-[#32B5FF]"
                      />
                      <span className="text-xs font-semibold text-white">
                        {b.displayName} #{b.id}
                      </span>
                      {taken && (
                        <Badge tone="default" className="px-1.5 py-0 text-[9px]">
                          Assigned{b.assignedToAccountEmail ? ` · ${b.assignedToAccountEmail}` : ""}
                        </Badge>
                      )}
                    </span>
                    <span className="font-mono text-xs text-[#B0B0B0]">
                      ~{formatCurrency(centsToDollars(b.baseEstMonthlyCents))}/mo
                    </span>
                  </label>
                );
              })
            )}
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
            onClick={handleConfirm}
            disabled={submitting || (mode === "special" && !selectedBridgeId)}
            className="flex-1"
          >
            {submitting ? "Adding…" : "Confirm"}
          </AccentButton>
        </div>
      </div>
    </div>
  );
}
