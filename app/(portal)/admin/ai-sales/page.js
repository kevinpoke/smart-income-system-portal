"use client";

import { useCallback, useEffect, useState } from "react";
import { GlassCard, SectionTitle, Badge, AccentButton, GhostButton } from "@/components/ui/Primitives";
import { Settings, ChevronRight } from "lucide-react";

const TRIGGER_LABELS = {
  JOIN_WAITLIST: "Join Waitlist",
  WATCH_MODULE: "Watch Module",
  AFTER_ISP_SETUP: "After ISP Setup",
  FIRST_LOGIN: "First Login",
  EACH_LOGIN: "Each Login",
  SUPPORT_TAG_ADDED: "Support Tag Added",
};

function RuleEditor({ workflow, onClose, onSaved }) {
  const [triggerType, setTriggerType] = useState(workflow.triggerType);
  const [module, setModule] = useState(workflow.triggerConfig?.module || 1);
  const [tagName, setTagName] = useState(workflow.triggerConfig?.tagName || "");
  const [delayHours, setDelayHours] = useState(workflow.delayHours);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSave() {
    setError("");
    setSaving(true);
    try {
      const triggerConfig =
        triggerType === "WATCH_MODULE"
          ? { module: Number(module) }
          : triggerType === "SUPPORT_TAG_ADDED"
            ? { tagName: tagName.trim() }
            : {};
      const res = await fetch(`/api/admin/ai-sales/${workflow.key}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rule: { triggerType, triggerConfig, timingDirection: "after", delayHours: Number(delayHours) },
        }),
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
        className="w-full max-w-md rounded-2xl border border-white/10 bg-[#1E1E1E] p-6"
      >
        <h3 className="mb-4 text-base font-bold text-white">Edit Rule — {workflow.name}</h3>
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs text-[#B0B0B0]">Trigger</span>
            <select
              value={triggerType}
              onChange={(e) => setTriggerType(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white"
            >
              {Object.entries(TRIGGER_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {triggerType === "WATCH_MODULE" && (
            <label className="block">
              <span className="mb-1 block text-xs text-[#B0B0B0]">Module</span>
              <select
                value={module}
                onChange={(e) => setModule(e.target.value)}
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
          {triggerType === "SUPPORT_TAG_ADDED" && (
            <label className="block">
              <span className="mb-1 block text-xs text-[#B0B0B0]">Tag name</span>
              <input
                type="text"
                value={tagName}
                onChange={(e) => setTagName(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white"
              />
            </label>
          )}
          <label className="block">
            <span className="mb-1 block text-xs text-[#B0B0B0]">Send AFTER (whole hours)</span>
            <input
              type="number"
              min="0"
              step="1"
              value={delayHours}
              onChange={(e) => setDelayHours(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white"
            />
          </label>
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
        <h3 className="mb-1 text-base font-bold text-white">{workflow.name}</h3>
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

export default function AiSalesPage() {
  const [workflows, setWorkflows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingMessage, setEditingMessage] = useState(null);
  const [editingRule, setEditingRule] = useState(null);

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

  return (
    <div className="space-y-6">
      <SectionTitle
        eyebrow="Automation"
        title="AI Sales"
        subtitle="Automated support/sales message workflows. Analytics shown here are identical to Admin Analytics — same underlying functions."
      />
      <div className="space-y-3">
        {workflows.map((w) => (
          <GlassCard key={w.key} className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setEditingMessage(w)}
                  className="flex items-center gap-1 text-sm font-semibold text-white hover:text-[#32B5FF]"
                >
                  {w.name}
                  <ChevronRight className="h-4 w-4" />
                </button>
                <Badge tone={w.enabled ? "success" : "default"}>{w.enabled ? "Enabled" : "Disabled"}</Badge>
                <span className="text-[11px] text-[#707070]">
                  {TRIGGER_LABELS[w.triggerType] || w.triggerType} → after {w.delayHours}h
                </span>
              </div>
              <div className="flex items-center gap-2">
                {w.analytics && (
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
        <MessageEditor
          workflow={editingMessage}
          onClose={() => setEditingMessage(null)}
          onSaved={load}
        />
      )}
      {editingRule && (
        <RuleEditor workflow={editingRule} onClose={() => setEditingRule(null)} onSaved={load} />
      )}
    </div>
  );
}
