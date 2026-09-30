"use client";

import { useCallback, useEffect, useState } from "react";
import { GlassCard, SectionTitle, Badge, AccentButton, GhostButton } from "@/components/ui/Primitives";
import { Settings, ChevronRight, Plus, X } from "lucide-react";

const TRIGGER_LABELS = {
  JOIN_WAITLIST: "Join Waitlist",
  WATCH_MODULE: "Watch Module",
  AFTER_ISP_SETUP: "After ISP Setup",
  FIRST_LOGIN: "After First Login",
  EACH_LOGIN: "After Each Login",
  SUPPORT_TAG_ADDED: "Support Tag Added",
  MESSAGE_READ: "When Message Read",
};

function emptyCondition(triggerType = "JOIN_WAITLIST") {
  return { triggerType, triggerConfig: {} };
}

// Shared Hours/Days timing input -- converts to/from the underlying
// delay_hours storage. Days is purely a UI convenience; internally always
// normalized to whole hours (3 Days -> 72). "0 Hours" is allowed (means
// eligible on the very next scheduler pass).
function useTimingInput(initialDelayHours) {
  const initialUnit = initialDelayHours != null && initialDelayHours % 24 === 0 && initialDelayHours > 0 ? "days" : "hours";
  const initialValue = initialUnit === "days" ? initialDelayHours / 24 : initialDelayHours ?? 0;
  const [amount, setAmount] = useState(String(initialValue));
  const [unit, setUnit] = useState(initialUnit);

  function toDelayHours() {
    const n = Number(amount);
    if (!Number.isFinite(n)) return null;
    return unit === "days" ? n * 24 : n;
  }

  return { amount, setAmount, unit, setUnit, toDelayHours };
}

function TimingFields({ timing }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <label className="block">
        <span className="mb-1 block text-xs text-[#B0B0B0]">Send After</span>
        <input
          type="number"
          min="0"
          step="1"
          value={timing.amount}
          onChange={(e) => timing.setAmount(e.target.value)}
          className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs text-[#B0B0B0]">Unit</span>
        <select
          value={timing.unit}
          onChange={(e) => timing.setUnit(e.target.value)}
          className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white"
        >
          <option value="hours">Hours</option>
          <option value="days">Days</option>
        </select>
      </label>
    </div>
  );
}

function useSupportTags() {
  const [tags, setTags] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/admin/support/tags", { cache: "no-store" });
        const data = await res.json();
        if (!cancelled) setTags(data.tags || []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return { tags, loading };
}

// Every OTHER automation, sorted by message_code, for the MESSAGE_READ
// source dropdown -- dynamically built from live data, never hardcoded.
// `excludeKey` (the automation currently being created/edited) is left
// out client-side purely for UX; the server independently rejects
// self-reference regardless of what the client sends.
function MessageReadSourceSelect({ workflows, excludeKey, value, onChange }) {
  const options = workflows
    .filter((w) => w.key !== excludeKey)
    .slice()
    .sort((a, b) => (a.messageCode || 0) - (b.messageCode || 0));
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-[#B0B0B0]">Message</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white"
      >
        <option value="" disabled>
          Select a message
        </option>
        {options.map((w) => (
          <option key={w.key} value={w.key}>
            {w.messageCodeLabel || `Message ${w.messageCode}`} — {w.name}
          </option>
        ))}
      </select>
    </label>
  );
}

// One condition row: trigger-type selector + its own trigger-specific
// config fields, shared between the creation form and the Rule Editor.
function ConditionRow({ condition, onChange, onRemove, canRemove, workflows, excludeKey, tags, tagsLoading }) {
  function setTriggerType(triggerType) {
    onChange({ triggerType, triggerConfig: {} });
  }
  function setConfig(patch) {
    onChange({ ...condition, triggerConfig: { ...condition.triggerConfig, ...patch } });
  }

  return (
    <div className="space-y-2 rounded-xl border border-white/10 bg-white/[0.02] p-3">
      <div className="flex items-center gap-2">
        <select
          value={condition.triggerType}
          onChange={(e) => setTriggerType(e.target.value)}
          className="flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white"
        >
          {Object.entries(TRIGGER_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        {canRemove && (
          <button
            type="button"
            onClick={onRemove}
            title="Remove"
            className="rounded-lg border border-white/10 p-2 text-[#B0B0B0] hover:text-red-400"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      {condition.triggerType === "WATCH_MODULE" && (
        <label className="block">
          <span className="mb-1 block text-xs text-[#B0B0B0]">Module</span>
          <select
            value={condition.triggerConfig.module || 1}
            onChange={(e) => setConfig({ module: Number(e.target.value) })}
            className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white"
          >
            {Array.from({ length: 10 }, (_, i) => i + 1).map((m) => (
              <option key={m} value={m}>
                Module {m}
              </option>
            ))}
          </select>
        </label>
      )}
      {condition.triggerType === "SUPPORT_TAG_ADDED" && (
        <label className="block">
          <span className="mb-1 block text-xs text-[#B0B0B0]">Tag</span>
          <select
            value={condition.triggerConfig.tagName || ""}
            onChange={(e) => setConfig({ tagName: e.target.value })}
            className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white"
          >
            <option value="" disabled>
              {tagsLoading ? "Loading tags…" : "Select a tag"}
            </option>
            {tags.map((t) => (
              <option key={t.id} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
          {!tagsLoading && tags.length === 0 && (
            <p className="mt-1 text-[11px] text-[#707070]">
              No Support Chat tags exist yet — create one in Support Chats first.
            </p>
          )}
        </label>
      )}
      {condition.triggerType === "MESSAGE_READ" && (
        <MessageReadSourceSelect
          workflows={workflows}
          excludeKey={excludeKey}
          value={condition.triggerConfig.sourceAutomationKey || ""}
          onChange={(sourceAutomationKey) => setConfig({ sourceAutomationKey })}
        />
      )}
    </div>
  );
}

// Reusable block: Trigger Logic (All/Any) + repeatable condition rows +
// "+ Add Trigger". Shared by the creation modal and the Rule Editor so
// both stay in sync with zero duplicated logic.
function ConditionsEditor({ triggerMatchMode, setTriggerMatchMode, conditions, setConditions, workflows, excludeKey, tags, tagsLoading }) {
  function updateCondition(i, next) {
    setConditions(conditions.map((c, idx) => (idx === i ? next : c)));
  }
  function removeCondition(i) {
    setConditions(conditions.filter((_, idx) => idx !== i));
  }
  function addCondition() {
    setConditions([...conditions, emptyCondition()]);
  }

  return (
    <div className="space-y-3">
      <label className="block">
        <span className="mb-1 block text-xs text-[#B0B0B0]">Trigger Logic</span>
        <select
          value={triggerMatchMode}
          onChange={(e) => setTriggerMatchMode(e.target.value)}
          className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white"
        >
          <option value="all">All Triggers</option>
          <option value="any">Any Trigger</option>
        </select>
      </label>
      <div className="space-y-2">
        <span className="block text-xs text-[#B0B0B0]">Triggers</span>
        {conditions.map((condition, i) => (
          <ConditionRow
            key={i}
            condition={condition}
            onChange={(next) => updateCondition(i, next)}
            onRemove={() => removeCondition(i)}
            canRemove={conditions.length > 1}
            workflows={workflows}
            excludeKey={excludeKey}
            tags={tags}
            tagsLoading={tagsLoading}
          />
        ))}
        <button
          type="button"
          onClick={addCondition}
          className="flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-white/20 py-2 text-xs font-medium text-[#B0B0B0] hover:border-[#32B5FF]/50 hover:text-white"
        >
          <Plus className="h-3.5 w-3.5" />
          Add Trigger
        </button>
      </div>
    </div>
  );
}

function RuleEditor({ workflow, workflows, onClose, onSaved }) {
  const [triggerMatchMode, setTriggerMatchMode] = useState(workflow.triggerMatchMode || "all");
  const [conditions, setConditions] = useState(
    workflow.conditions?.length ? workflow.conditions.map((c) => ({ triggerType: c.triggerType, triggerConfig: c.triggerConfig })) : [emptyCondition()]
  );
  const timing = useTimingInput(workflow.delayHours);
  const { tags, loading: tagsLoading } = useSupportTags();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSave() {
    setError("");
    const delayHours = timing.toDelayHours();
    if (delayHours == null || delayHours < 0) {
      setError("Enter a valid, non-negative timing value.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/ai-sales/${workflow.key}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rule: { triggerMatchMode, conditions, delayHours } }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Unable to save rule.");
        return;
      }
      onSaved(data);
      onClose();
    } catch {
      setError("Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border border-white/10 bg-[#1E1E1E] p-6"
      >
        <h3 className="mb-4 text-base font-bold text-white">
          Edit Rule — {workflow.messageCodeLabel ? `${workflow.messageCodeLabel} — ` : ""}
          {workflow.name}
        </h3>
        <div className="space-y-3">
          <ConditionsEditor
            triggerMatchMode={triggerMatchMode}
            setTriggerMatchMode={setTriggerMatchMode}
            conditions={conditions}
            setConditions={setConditions}
            workflows={workflows}
            excludeKey={workflow.key}
            tags={tags}
            tagsLoading={tagsLoading}
          />
          <TimingFields timing={timing} />
          {error && <div className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</div>}
        </div>
        <div className="mt-5 flex gap-2">
          <GhostButton onClick={onClose} className="flex-1">
            Cancel
          </GhostButton>
          <AccentButton onClick={handleSave} disabled={saving} className="flex-1">
            {saving ? "Saving…" : "Save Rule"}
          </AccentButton>
        </div>
      </div>
    </div>
  );
}

function MessageEditor({ workflow, onClose, onSaved }) {
  const [body, setBody] = useState(workflow.messageBody);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSave() {
    setError("");
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/ai-sales/${workflow.key}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageBody: body }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Unable to save message.");
        return;
      }
      onSaved(data);
      onClose();
    } catch {
      setError("Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#1E1E1E] p-6"
      >
        <h3 className="mb-1 text-base font-bold text-white">
          {workflow.messageCodeLabel ? `${workflow.messageCodeLabel} — ` : ""}
          {workflow.name}
        </h3>
        <p className="mb-3 text-xs text-[#707070]">
          Editing applies to FUTURE sends only. Already-sent messages are never resent or altered.
        </p>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={6}
          className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white"
        />
        {error && <div className="mt-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</div>}
        <div className="mt-4 flex gap-2">
          <GhostButton onClick={onClose} className="flex-1">
            Cancel
          </GhostButton>
          <AccentButton onClick={handleSave} disabled={saving} className="flex-1">
            {saving ? "Saving…" : "Save Message"}
          </AccentButton>
        </div>
      </div>
    </div>
  );
}

// New-automation creation modal. Admin never types/chooses the internal
// key or the message code -- both are always server-generated. Duplicate
// display names are allowed by design; a soft visual warning is shown
// (never blocks submission).
function CreateAutomationModal({ workflows, onClose, onCreated }) {
  const [name, setName] = useState("");
  const [messageBody, setMessageBody] = useState("");
  const [triggerMatchMode, setTriggerMatchMode] = useState("all");
  const [conditions, setConditions] = useState([emptyCondition()]);
  const [enabled, setEnabled] = useState(true);
  const timing = useTimingInput(0);
  const { tags, loading: tagsLoading } = useSupportTags();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const existingNames = workflows.map((w) => w.name);
  const nameCollision =
    name.trim().length > 0 && existingNames.some((n) => n.toLowerCase() === name.trim().toLowerCase());

  async function handleCreate() {
    setError("");
    if (!name.trim()) {
      setError("Automation name is required.");
      return;
    }
    if (!messageBody.trim()) {
      setError("Message is required.");
      return;
    }
    for (const c of conditions) {
      if (c.triggerType === "SUPPORT_TAG_ADDED" && !c.triggerConfig.tagName) {
        setError("Select an existing Support Chat tag for every Support Tag condition.");
        return;
      }
      if (c.triggerType === "MESSAGE_READ" && !c.triggerConfig.sourceAutomationKey) {
        setError("Select a source message for every When Message Read condition.");
        return;
      }
    }
    const delayHours = timing.toDelayHours();
    if (delayHours == null || delayHours < 0) {
      setError("Enter a valid, non-negative timing value.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/admin/ai-sales", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          messageBody,
          triggerMatchMode,
          conditions,
          delayHours,
          enabled,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Unable to create automation.");
        return;
      }
      onCreated();
      onClose();
    } catch {
      setError("Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-white/10 bg-[#1E1E1E] p-6"
      >
        <h3 className="mb-4 text-base font-bold text-white">New Automation</h3>
        <div className="space-y-3">
          <div className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-xs text-[#707070]">
            Message Code: <span className="text-white">Automatically assigned</span>
          </div>
          <label className="block">
            <span className="mb-1 block text-xs text-[#B0B0B0]">Automation Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Module 6 Upgrade Follow Up"
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white"
            />
            {nameCollision && (
              <p className="mt-1 text-[11px] text-amber-400">
                An automation with this name already exists — both can exist safely, but double-check this is intentional.
              </p>
            )}
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-[#B0B0B0]">Message</span>
            <textarea
              value={messageBody}
              onChange={(e) => setMessageBody(e.target.value)}
              rows={5}
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white"
            />
          </label>
          <ConditionsEditor
            triggerMatchMode={triggerMatchMode}
            setTriggerMatchMode={setTriggerMatchMode}
            conditions={conditions}
            setConditions={setConditions}
            workflows={workflows}
            excludeKey={null}
            tags={tags}
            tagsLoading={tagsLoading}
          />
          <TimingFields timing={timing} />
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-white/20 bg-white/5"
            />
            <span className="text-xs text-[#B0B0B0]">Enabled</span>
          </label>
          {error && <div className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</div>}
        </div>
        <div className="mt-5 flex gap-2">
          <GhostButton onClick={onClose} className="flex-1">
            Cancel
          </GhostButton>
          <AccentButton onClick={handleCreate} disabled={saving} className="flex-1">
            {saving ? "Creating…" : "Create Automation"}
          </AccentButton>
        </div>
      </div>
    </div>
  );
}

function triggerSummary(w) {
  const count = w.conditions?.length || 0;
  if (count <= 1) {
    const t = w.conditions?.[0]?.triggerType;
    return `${TRIGGER_LABELS[t] || t || "—"} → after ${w.delayHours}h`;
  }
  const modeLabel = w.triggerMatchMode === "any" ? "Any" : "All";
  return `${count} Triggers · ${modeLabel} → after ${w.delayHours}h`;
}

export default function AiSalesPage() {
  const [workflows, setWorkflows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingMessage, setEditingMessage] = useState(null);
  const [editingRule, setEditingRule] = useState(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/ai-sales", { cache: "no-store" });
      const data = await res.json();
      setWorkflows(data.workflows || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggleEnabled(workflow) {
    await fetch(`/api/admin/ai-sales/${workflow.key}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !workflow.enabled }),
    });
    load();
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <SectionTitle eyebrow="Automation" title="AI Sales" />
      </div>
    );
  }

  // Sorted by permanent message_code -- never created_at -- so the
  // display order never shifts as new automations are added.
  const sorted = [...workflows].sort((a, b) => (a.messageCode || 0) - (b.messageCode || 0));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle
          eyebrow="Automation"
          title="AI Sales"
          subtitle="Automated support/sales message workflows. Analytics shown here are identical to Admin Analytics — same underlying functions."
        />
        <AccentButton onClick={() => setCreating(true)} className="shrink-0">
          <Plus className="h-4 w-4" />
          New Automation
        </AccentButton>
      </div>
      {/* No hardcoded row count -- renders every row in automation_definitions,
          whether seeded/legacy or admin-created, sorted by message_code. */}
      <div className="space-y-3">
        {sorted.map((w) => (
          <GlassCard key={w.key} className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={() => setEditingMessage(w)}
                  className="flex items-center gap-1 text-sm font-semibold text-white hover:text-[#32B5FF]"
                >
                  {w.messageCodeLabel ? `${w.messageCodeLabel} — ` : ""}
                  {w.name}
                  <ChevronRight className="h-4 w-4" />
                </button>
                <Badge tone={w.enabled ? "success" : "default"}>{w.enabled ? "Enabled" : "Disabled"}</Badge>
                <span className="text-[11px] text-[#707070]">{triggerSummary(w)}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {w.analytics ? (
                  <div className="flex items-center gap-3 text-[11px] text-[#B0B0B0]">
                    <span>
                      Sent: <span className="font-semibold text-white">{w.analytics.sent}</span>
                    </span>
                    <span>
                      Replied: <span className="font-semibold text-white">{w.analytics.replied}</span>
                    </span>
                    <span>
                      Reply Rate: <span className="font-semibold text-[#32B5FF]">{w.analytics.replyRatePct}%</span>
                    </span>
                  </div>
                ) : (
                  // Admin-created automations don't yet have historical
                  // prefix-based Sent/Replied analytics (they use
                  // automation_sends, not scheduled_support_messages) --
                  // omit the metric rather than fabricate a number.
                  <span className="text-[11px] italic text-[#707070]">Analytics not yet available for custom automations</span>
                )}
                <button
                  onClick={() => setEditingRule(w)}
                  title="Edit Rule"
                  className="rounded-lg border border-white/10 p-2 text-[#B0B0B0] hover:text-white"
                >
                  <Settings className="h-4 w-4" />
                </button>
                <button
                  onClick={() => toggleEnabled(w)}
                  className="rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-[#B0B0B0] hover:text-white"
                >
                  {w.enabled ? "Disable" : "Enable"}
                </button>
              </div>
            </div>
          </GlassCard>
        ))}
      </div>

      {editingMessage && (
        <MessageEditor workflow={editingMessage} onClose={() => setEditingMessage(null)} onSaved={load} />
      )}
      {editingRule && (
        <RuleEditor workflow={editingRule} workflows={workflows} onClose={() => setEditingRule(null)} onSaved={load} />
      )}
      {creating && (
        <CreateAutomationModal workflows={workflows} onClose={() => setCreating(false)} onCreated={load} />
      )}
    </div>
  );
}
