"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { GlassCard, SectionTitle, Badge, AccentButton, GhostButton } from "@/components/ui/Primitives";
import { Settings, ChevronRight, Plus, X } from "lucide-react";
import {
  TRIGGER_LABELS,
  OPERATOR_OPTIONS,
  MAX_RULE_TREE_DEPTH,
  emptyCondition,
  newLeafNode,
  newGroupNode,
  isLeafNode,
  isGroupNode,
  stripUiIds,
  serverTreeToClientTree,
  buildDefaultTree,
  removeNodeById,
  replaceNodeById,
  validateClientTree,
  naturalUnitFor,
  unitToSeconds,
} from "@/lib/ruleBuilderUi";

const PERIOD_OPTIONS = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "last3", label: "Last 3 Days" },
  { value: "last7", label: "Last 7 Days" },
  { value: "last30", label: "Last 30 Days" },
  { value: "last60", label: "Last 60 Days" },
  { value: "last90", label: "Last 90 Days" },
  { value: "alltime", label: "All Time" },
  { value: "custom", label: "Custom" },
];

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

// Timing input: value + Seconds/Minutes/Hours/Days unit, backed by
// delaySeconds truth (see lib/ruleBuilderUi naturalUnitFor/unitToSeconds).
function useTimingInput(initialDelaySeconds) {
  const initial = naturalUnitFor(initialDelaySeconds ?? 0);
  const [amount, setAmount] = useState(String(initial.value));
  const [unit, setUnit] = useState(initial.unit);
  function toDelaySeconds() {
    return unitToSeconds(amount, unit);
  }
  return { amount, setAmount, unit, setUnit, toDelaySeconds };
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
          <option value="seconds">Seconds</option>
          <option value="minutes">Minutes</option>
          <option value="hours">Hours</option>
          <option value="days">Days</option>
        </select>
      </label>
    </div>
  );
}

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

// One leaf condition's trigger-specific config fields.
function ConditionConfig({ condition, onChange, workflows, excludeKey, tags, tagsLoading }) {
  function setConfig(patch) {
    onChange({ ...condition, triggerConfig: { ...condition.triggerConfig, ...patch } });
  }
  if (condition.triggerType === "WATCH_MODULE") {
    return (
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
    );
  }
  if (condition.triggerType === "SUPPORT_TAG_ADDED") {
    return (
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
    );
  }
  if (condition.triggerType === "MESSAGE_READ") {
    return (
      <MessageReadSourceSelect
        workflows={workflows}
        excludeKey={excludeKey}
        value={condition.triggerConfig.sourceAutomationKey || ""}
        onChange={(sourceAutomationKey) => setConfig({ sourceAutomationKey })}
      />
    );
  }
  return null; // FIRST_LOGIN/EACH_LOGIN/JOIN_WAITLIST/AFTER_ISP_SETUP/DID_NOT_JOIN_WAITLIST: no config.
}

// Leaf row inside the rule tree.
function RuleConditionRow({ node, condition, onUpdateCondition, onRemove, canRemove, workflows, excludeKey, tags, tagsLoading }) {
  function setTriggerType(triggerType) {
    onUpdateCondition({ triggerType, triggerConfig: {} });
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
            onClick={() => onRemove(node._id)}
            title="Remove"
            className="rounded-lg border border-white/10 p-2 text-[#B0B0B0] hover:text-red-400"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <ConditionConfig
        condition={condition}
        onChange={onUpdateCondition}
        workflows={workflows}
        excludeKey={excludeKey}
        tags={tags}
        tagsLoading={tagsLoading}
      />
    </div>
  );
}

// One group node: operator selector + its children (recursively) + Add
// Condition / Add Group / Remove Group.
function RuleGroup({ node, depth, conditions, onAddCondition, onAddGroup, onRemoveNode, onReplaceNode, onUpdateConditionAt, canRemoveGroup, workflows, excludeKey, tags, tagsLoading }) {
  function setOp(op) {
    onReplaceNode(node._id, { ...node, op });
  }
  const atMaxDepth = depth >= MAX_RULE_TREE_DEPTH;
  const childCanRemove = node.children.length > 1 || canRemoveGroup;

  return (
    <div className="space-y-2 rounded-xl border border-white/10 bg-white/[0.015] p-3" style={{ marginLeft: depth > 1 ? 12 : 0 }}>
      <div className="flex items-center gap-2">
        <select
          value={node.op}
          onChange={(e) => setOp(e.target.value)}
          className="flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white"
        >
          {OPERATOR_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {canRemoveGroup && (
          <button
            type="button"
            onClick={() => onRemoveNode(node._id)}
            title="Remove Group"
            className="rounded-lg border border-white/10 p-2 text-[#B0B0B0] hover:text-red-400"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <div className="space-y-2 border-l border-white/10 pl-3">
        {node.children.map((child) =>
          isLeafNode(child) ? (
            <RuleConditionRow
              key={child._id}
              node={child}
              condition={conditions[child.conditionIndex] || emptyCondition()}
              onUpdateCondition={(next) => onUpdateConditionAt(child.conditionIndex, next)}
              onRemove={onRemoveNode}
              canRemove={childCanRemove}
              workflows={workflows}
              excludeKey={excludeKey}
              tags={tags}
              tagsLoading={tagsLoading}
            />
          ) : (
            <RuleGroup
              key={child._id}
              node={child}
              depth={depth + 1}
              conditions={conditions}
              onAddCondition={onAddCondition}
              onAddGroup={onAddGroup}
              onRemoveNode={onRemoveNode}
              onReplaceNode={onReplaceNode}
              onUpdateConditionAt={onUpdateConditionAt}
              canRemoveGroup={true}
              workflows={workflows}
              excludeKey={excludeKey}
              tags={tags}
              tagsLoading={tagsLoading}
            />
          )
        )}
      </div>
      <div className="flex flex-wrap gap-2 pl-3">
        <button
          type="button"
          onClick={() => onAddCondition(node._id)}
          className="flex items-center gap-1 rounded-lg border border-dashed border-white/20 px-2.5 py-1.5 text-xs font-medium text-[#B0B0B0] hover:border-[#32B5FF]/50 hover:text-white"
        >
          <Plus className="h-3.5 w-3.5" /> Add Condition
        </button>
        {!atMaxDepth && (
          <button
            type="button"
            onClick={() => onAddGroup(node._id)}
            className="flex items-center gap-1 rounded-lg border border-dashed border-white/20 px-2.5 py-1.5 text-xs font-medium text-[#B0B0B0] hover:border-[#32B5FF]/50 hover:text-white"
          >
            <Plus className="h-3.5 w-3.5" /> Add Group
          </button>
        )}
      </div>
    </div>
  );
}

// Top-level rule builder: owns the tree + the flat `conditions` array it
// addresses by index. { tree (conditionIndex leaves, _id stripped before
// submit), conditions } is the exact shape create/update expects.
function RuleBuilder({ tree, setTree, conditions, setConditions, workflows, excludeKey, tags, tagsLoading }) {
  function updateConditionAt(index, next) {
    setConditions(conditions.map((c, i) => (i === index ? next : c)));
  }

  function findNode(node, id) {
    if (node._id === id) return node;
    if (isGroupNode(node)) {
      for (const c of node.children) {
        const found = findNode(c, id);
        if (found) return found;
      }
    }
    return null;
  }
  function appendChild(groupNode, child) {
    return { ...groupNode, children: [...groupNode.children, child] };
  }

  function addCondition(parentGroupId) {
    setConditions((prev) => {
      const newIndex = prev.length;
      const leaf = newLeafNode(newIndex);
      setTree((t) => replaceNodeById(t, parentGroupId, appendChild(findNode(t, parentGroupId), leaf)));
      return [...prev, emptyCondition()];
    });
  }

  function addGroup(parentGroupId) {
    setConditions((prev) => {
      const newIndex = prev.length;
      const leaf = newLeafNode(newIndex);
      const group = newGroupNode("AND", [leaf]);
      setTree((t) => replaceNodeById(t, parentGroupId, appendChild(findNode(t, parentGroupId), group)));
      return [...prev, emptyCondition()];
    });
  }

  function removeNode(id) {
    setTree((t) => {
      const next = removeNodeById(t, id);
      return next || t; // never remove the whole tree -- root group can't remove itself
    });
  }
  function replaceNode(id, replacement) {
    setTree((t) => replaceNodeById(t, id, replacement));
  }

  return (
    <div className="space-y-2">
      <span className="block text-xs text-[#B0B0B0]">Rule</span>
      <RuleGroup
        node={tree}
        depth={1}
        conditions={conditions}
        onAddCondition={addCondition}
        onAddGroup={addGroup}
        onRemoveNode={removeNode}
        onReplaceNode={replaceNode}
        onUpdateConditionAt={updateConditionAt}
        canRemoveGroup={false}
        workflows={workflows}
        excludeKey={excludeKey}
        tags={tags}
        tagsLoading={tagsLoading}
      />
    </div>
  );
}

// Compacts `conditions`/`tree` so every conditionIndex is contiguous
// 0..n-1 in tree-traversal order, dropping any orphaned condition row.
function compactForSubmit(tree, conditions) {
  const usedOrder = [];
  function walk(node) {
    if (isLeafNode(node)) {
      if (!usedOrder.includes(node.conditionIndex)) usedOrder.push(node.conditionIndex);
      return;
    }
    if (isGroupNode(node)) node.children.forEach(walk);
  }
  walk(tree);
  const remap = new Map(usedOrder.map((oldIdx, newIdx) => [oldIdx, newIdx]));
  function remapTree(node) {
    if (isLeafNode(node)) return { ...node, conditionIndex: remap.get(node.conditionIndex) };
    return { ...node, children: node.children.map(remapTree) };
  }
  return { tree: remapTree(tree), conditions: usedOrder.map((i) => conditions[i]) };
}

function RuleEditor({ workflow, workflows, onClose, onSaved }) {
  const { tags, loading: tagsLoading } = useSupportTags();
  const initialConditions = workflow.conditions?.length
    ? workflow.conditions.map((c) => ({ triggerType: c.triggerType, triggerConfig: c.triggerConfig }))
    : [emptyCondition()];
  const [conditions, setConditions] = useState(initialConditions);
  const [tree, setTree] = useState(() => {
    if (workflow.ruleTree) {
      try {
        return serverTreeToClientTree(workflow.ruleTree, workflow.conditions || []);
      } catch {
        // fall through to legacy default below
      }
    }
    return buildDefaultTree(initialConditions.length, workflow.triggerMatchMode || "all");
  });
  const timing = useTimingInput(workflow.delaySeconds ?? (workflow.delayHours != null ? workflow.delayHours * 3600 : 0));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSave() {
    setError("");
    const delaySeconds = timing.toDelaySeconds();
    if (delaySeconds == null || delaySeconds < 0) {
      setError("Enter a valid, non-negative timing value.");
      return;
    }
    const compacted = compactForSubmit(tree, conditions);
    const clientErr = validateClientTree(compacted.tree, compacted.conditions);
    if (clientErr) {
      setError(clientErr);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/ai-sales/${workflow.key}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rule: {
            ruleTree: stripUiIds(compacted.tree),
            conditions: compacted.conditions,
            delayValue: timing.amount,
            delayUnit: timing.unit,
          },
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
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-white/10 bg-[#1E1E1E] p-6"
      >
        <h3 className="mb-4 text-base font-bold text-white">
          Edit Rule — {workflow.messageCodeLabel ? `${workflow.messageCodeLabel} — ` : ""}
          {workflow.name}
        </h3>
        <div className="space-y-3">
          <RuleBuilder
            tree={tree}
            setTree={setTree}
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

function CreateAutomationModal({ workflows, onClose, onCreated }) {
  const [name, setName] = useState("");
  const [messageBody, setMessageBody] = useState("");
  const [conditions, setConditions] = useState([emptyCondition()]);
  const [tree, setTree] = useState(() => buildDefaultTree(1, "all"));
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
    const compacted = compactForSubmit(tree, conditions);
    for (const c of compacted.conditions) {
      if (c.triggerType === "SUPPORT_TAG_ADDED" && !c.triggerConfig.tagName) {
        setError("Select an existing Support Chat tag for every Support Tag condition.");
        return;
      }
      if (c.triggerType === "MESSAGE_READ" && !c.triggerConfig.sourceAutomationKey) {
        setError("Select a source message for every When Message Read condition.");
        return;
      }
    }
    const clientErr = validateClientTree(compacted.tree, compacted.conditions);
    if (clientErr) {
      setError(clientErr);
      return;
    }
    const delaySeconds = timing.toDelaySeconds();
    if (delaySeconds == null || delaySeconds < 0) {
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
          ruleTree: stripUiIds(compacted.tree),
          conditions: compacted.conditions,
          delayValue: timing.amount,
          delayUnit: timing.unit,
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
          <RuleBuilder
            tree={tree}
            setTree={setTree}
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

function describeTree(node, conditions) {
  if (isLeafNode(node)) {
    const t = conditions[node.conditionIndex]?.triggerType;
    return TRIGGER_LABELS[t] || t || "—";
  }
  if (isGroupNode(node)) {
    const opLabel = OPERATOR_OPTIONS.find((o) => o.value === node.op)?.label || node.op;
    return `${opLabel} (${node.children.length})`;
  }
  return "—";
}

function triggerSummary(w) {
  const delaySeconds = w.delaySeconds ?? (w.delayHours != null ? w.delayHours * 3600 : 0);
  const { value, unit } = naturalUnitFor(delaySeconds);
  const unitLabel = value === 1 ? unit.slice(0, -1) : unit;
  const timingLabel = `after ${value} ${unitLabel}`;
  if (w.ruleTree && w.conditions) {
    try {
      const clientTree = serverTreeToClientTree(w.ruleTree, w.conditions);
      const conditionsForDescribe = w.conditions.map((c) => ({ triggerType: c.triggerType }));
      return `${describeTree(clientTree, conditionsForDescribe)} → ${timingLabel}`;
    } catch {
      // fall through to legacy summary below
    }
  }
  const count = w.conditions?.length || 0;
  if (count <= 1) {
    const t = w.conditions?.[0]?.triggerType;
    return `${TRIGGER_LABELS[t] || t || "—"} → ${timingLabel}`;
  }
  const modeLabel = w.triggerMatchMode === "any" ? "Any" : "All";
  return `${count} Triggers · ${modeLabel} → ${timingLabel}`;
}

// Period selector persisted in the URL query string. Boundary math stays
// entirely server-side (lib/supportAnalytics.js resolvePeriodRange,
// America/Los_Angeles) -- this only ever sends raw period/start/end.
function DateFilterBar({ period, customStart, customEnd, onChange }) {
  const [draftStart, setDraftStart] = useState(customStart);
  const [draftEnd, setDraftEnd] = useState(customEnd);
  const [rangeError, setRangeError] = useState("");

  useEffect(() => {
    // URL-driven draft sync, same pattern as AnalyticsPanel's own
    // fetch-on-mount/filter-change effect elsewhere in this app.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraftStart(customStart);
    setDraftEnd(customEnd);
  }, [customStart, customEnd]);

  function applyCustom() {
    if (!draftStart || !draftEnd) {
      setRangeError("Select both a start and end date.");
      return;
    }
    if (draftStart > draftEnd) {
      setRangeError("Start date must be on or before end date.");
      return;
    }
    setRangeError("");
    onChange("custom", draftStart, draftEnd);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {PERIOD_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => (opt.value === "custom" ? onChange("custom", draftStart, draftEnd) : onChange(opt.value))}
          className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
            period === opt.value ? "bg-[#32B5FF] text-[#06121a]" : "bg-white/5 text-[#B0B0B0] hover:bg-white/10"
          }`}
        >
          {opt.label}
        </button>
      ))}
      {period === "custom" && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="date"
            value={draftStart}
            onChange={(e) => setDraftStart(e.target.value)}
            className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-white outline-none focus:ring-1 focus:ring-[#32B5FF]"
          />
          <span className="text-[11px] text-[#707070]">to</span>
          <input
            type="date"
            value={draftEnd}
            onChange={(e) => setDraftEnd(e.target.value)}
            className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-white outline-none focus:ring-1 focus:ring-[#32B5FF]"
          />
          <button
            type="button"
            onClick={applyCustom}
            className="rounded-lg bg-[#32B5FF] px-3 py-1 text-[11px] font-semibold text-[#06121a] hover:bg-[#4dc0ff]"
          >
            Apply
          </button>
        </div>
      )}
      {rangeError && <span className="text-[11px] text-red-400">{rangeError}</span>}
    </div>
  );
}

function AiSalesPageInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const period = searchParams.get("period") || "last7";
  const customStart = searchParams.get("start") || "";
  const customEnd = searchParams.get("end") || "";

  const [workflows, setWorkflows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [editingMessage, setEditingMessage] = useState(null);
  const [editingRule, setEditingRule] = useState(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      params.set("period", period);
      if (period === "custom" && customStart && customEnd) {
        params.set("start", customStart);
        params.set("end", customEnd);
      }
      const res = await fetch(`/api/admin/ai-sales?${params.toString()}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) {
        setLoadError(data.error || "Unable to load analytics for this date range.");
        setWorkflows(data.workflows || []);
        return;
      }
      setLoadError("");
      setWorkflows(data.workflows || []);
    } finally {
      setLoading(false);
    }
  }, [period, customStart, customEnd]);

  useEffect(() => {
    load();
  }, [load]);

  function handlePeriodChange(nextPeriod, start, end) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("period", nextPeriod);
    if (nextPeriod === "custom") {
      if (start) params.set("start", start);
      if (end) params.set("end", end);
    } else {
      params.delete("start");
      params.delete("end");
    }
    router.replace(`${pathname}?${params.toString()}`);
  }

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

  // Sorted by permanent message_code -- never created_at. Never filtered
  // by date range -- only each row's own `analytics` field responds.
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

      <GlassCard className="p-3">
        <DateFilterBar period={period} customStart={customStart} customEnd={customEnd} onChange={handlePeriodChange} />
        {loadError && <div className="mt-2 text-[11px] text-red-400">{loadError}</div>}
      </GlassCard>

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

export default function AiSalesPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-6">
          <SectionTitle eyebrow="Automation" title="AI Sales" />
        </div>
      }
    >
      <AiSalesPageInner />
    </Suspense>
  );
}
