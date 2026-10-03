// AI Sales rule-builder UI pieces: structured rule tree (ruleTree) editor
// + Seconds/Minutes/Hours/Days timing, replacing the old flat ALL/ANY
// editor. Client tree uses { conditionIndex } leaves (same convention the
// server accepts for create/update -- see lib/automationDefinitions.js
// resolveRuleTreeIndexesToIds) plus a UI-only `_id` on every node for
// React keys, stripped before POST/PATCH.

export const TRIGGER_LABELS = {
  JOIN_WAITLIST: "Join Waitlist",
  WATCH_MODULE: "Watch Module",
  AFTER_ISP_SETUP: "After ISP Setup",
  FIRST_LOGIN: "After First Login",
  EACH_LOGIN: "After Each Login",
  SUPPORT_TAG_ADDED: "Support Tag Added",
  MESSAGE_READ: "When Message Read",
  DID_NOT_JOIN_WAITLIST: "Did Not Join Waitlist",
};

// User-facing operator labels -> canonical backend op (lib/ruleTree.js
// GROUP_OPERATORS). Several labels map to the same backend op by design
// (e.g. "And" and "All Of" are both ALL_OF-family -- AND itself IS a
// valid distinct backend op, kept separate from ALL_OF per the backend's
// own alias set).
export const OPERATOR_OPTIONS = [
  { value: "AND", label: "And (all true)" },
  { value: "OR", label: "Or (any true)" },
  { value: "ALL_OF", label: "All Of" },
  { value: "ANY_OF", label: "Any Of" },
  { value: "AT_LEAST_ONE_OF", label: "At Least One Of" },
  { value: "NONE_OF", label: "None Of" },
  { value: "NEITHER_NOR", label: "Neither...Nor" },
  { value: "EITHER_OR", label: "Either...Or (exactly one)" },
  { value: "DOES_NOT_HAVE", label: "Does Not Have" },
  { value: "BUT_NOT", label: "But Not (last condition excluded)" },
];

export const MAX_RULE_TREE_DEPTH = 5;

let uiIdCounter = 0;
function nextUiId() {
  uiIdCounter += 1;
  return `ui_${uiIdCounter}_${Date.now().toString(36)}`;
}

export function emptyCondition(triggerType = "JOIN_WAITLIST") {
  return { triggerType, triggerConfig: {} };
}

// --- Client tree helpers (conditionIndex-addressed, UI-only _id) --------

export function newLeafNode(conditionIndex) {
  return { _id: nextUiId(), conditionIndex };
}

export function newGroupNode(op = "AND", children = []) {
  return { _id: nextUiId(), op, children };
}

export function isLeafNode(node) {
  return node && typeof node.conditionIndex === "number";
}

export function isGroupNode(node) {
  return node && typeof node.op === "string" && Array.isArray(node.children);
}

// Strips _id (UI-only) recursively before sending to the server.
export function stripUiIds(node) {
  if (isLeafNode(node)) {
    return { conditionIndex: node.conditionIndex };
  }
  if (isGroupNode(node)) {
    return { op: node.op, children: node.children.map(stripUiIds) };
  }
  return node;
}

// Adds a UI-only _id to every node of a tree loaded from the server
// (conditionId-addressed -- see below for the id->index remap).
function addUiIds(node) {
  if (!node) return node;
  if (typeof node.conditionId === "string") {
    return { _id: nextUiId(), conditionId: node.conditionId };
  }
  if (typeof node.op === "string" && Array.isArray(node.children)) {
    return { _id: nextUiId(), op: node.op, children: node.children.map(addUiIds) };
  }
  return node;
}

// Converts a server tree (conditionId leaves) into a client tree
// (conditionIndex leaves, matching the `conditions` array order) so a
// loaded automation can be edited with the exact same index-addressed
// representation a brand-new rule uses. `conditions` here is the
// workflow's own getAutomationConditions() rows (already in `position`
// order, which IS the index order the server itself used to build
// rule_tree_json).
export function serverTreeToClientTree(serverTree, conditions) {
  const idToIndex = new Map(conditions.map((c, i) => [c.id, i]));
  function convert(node) {
    if (typeof node.conditionId === "string") {
      const idx = idToIndex.get(node.conditionId);
      return newLeafNode(idx != null ? idx : 0);
    }
    if (typeof node.op === "string" && Array.isArray(node.children)) {
      return { _id: nextUiId(), op: node.op, children: node.children.map(convert) };
    }
    return newLeafNode(0);
  }
  return convert(addUiIds(serverTree));
}

// Builds a default tree (ALL_OF wrapping every condition in order) --
// used both for a brand-new automation and as the fallback when loading
// a legacy row that has no ruleTree yet (triggerMatchMode/conditions
// only).
export function buildDefaultTree(conditionCount, triggerMatchMode = "all") {
  const op = triggerMatchMode === "any" ? "ANY_OF" : "ALL_OF";
  return newGroupNode(
    op,
    Array.from({ length: conditionCount }, (_, i) => newLeafNode(i))
  );
}

// Removes a node (by _id) anywhere in the tree. Returns null if the
// WHOLE tree was removed (caller must handle -- a rule can never save
// with an empty tree).
export function removeNodeById(node, targetId) {
  if (node._id === targetId) return null;
  if (!isGroupNode(node)) return node;
  const nextChildren = node.children
    .map((c) => removeNodeById(c, targetId))
    .filter((c) => c !== null);
  return { ...node, children: nextChildren };
}

// Replaces a node (by _id) anywhere in the tree with `replacement`.
export function replaceNodeById(node, targetId, replacement) {
  if (node._id === targetId) return replacement;
  if (!isGroupNode(node)) return node;
  return { ...node, children: node.children.map((c) => replaceNodeById(c, targetId, replacement)) };
}

// Depth of the tree rooted at `node` (a lone leaf is depth 1, same
// counting convention as lib/ruleTree.js validateRuleTreeShape).
export function treeDepth(node) {
  if (isLeafNode(node)) return 1;
  if (!isGroupNode(node) || node.children.length === 0) return 1;
  return 1 + Math.max(...node.children.map(treeDepth));
}

// Collects every conditionIndex referenced in the tree (for validating
// "every added condition must be used" + computing which index a newly
// added condition row should get).
export function collectIndexes(node, out = []) {
  if (isLeafNode(node)) {
    out.push(node.conditionIndex);
    return out;
  }
  if (isGroupNode(node)) {
    for (const c of node.children) collectIndexes(c, out);
  }
  return out;
}

// Client-side best-effort validation mirroring the server's own checks
// (lib/automationDefinitions.js validateRuleTree) -- never a full
// reimplementation (cycle/self-reference detection stays server-only),
// just the obvious UX-blocking cases so a submit doesn't round-trip for
// something cheaply catchable here: empty groups, BUT_NOT/DOES_NOT_HAVE
// arity, unused condition rows, zero event-type conditions.
export function validateClientTree(tree, conditions) {
  function walk(node, depth) {
    if (isLeafNode(node)) return null;
    if (!isGroupNode(node)) return "Malformed rule node.";
    if (node.children.length === 0) return "A rule group cannot be empty.";
    if (node.op === "DOES_NOT_HAVE" && node.children.length !== 1) {
      return '"Does Not Have" requires exactly one condition.';
    }
    if (node.op === "BUT_NOT" && node.children.length < 2) {
      return '"But Not" requires at least two conditions.';
    }
    for (const c of node.children) {
      const err = walk(c, depth + 1);
      if (err) return err;
    }
    return null;
  }
  const shapeErr = walk(tree, 1);
  if (shapeErr) return shapeErr;

  const depth = treeDepth(tree);
  if (depth > MAX_RULE_TREE_DEPTH) return `Rule nesting is too deep (max ${MAX_RULE_TREE_DEPTH} levels).`;

  const used = new Set(collectIndexes(tree));
  for (let i = 0; i < conditions.length; i++) {
    if (!used.has(i)) return "Every added condition must be used somewhere in the rule.";
  }

  const eventIndexes = conditions
    .map((c, i) => (c.triggerType !== "DID_NOT_JOIN_WAITLIST" ? i : null))
    .filter((i) => i !== null);
  const eventUsed = eventIndexes.some((i) => used.has(i));
  if (!eventUsed) {
    return "At least one event-based condition (not just Did Not Join Waitlist) is required.";
  }
  return null;
}

// --- Timing: delaySeconds <-> natural unit display ----------------------

export function naturalUnitFor(delaySeconds) {
  if (delaySeconds == null) return { value: 0, unit: "seconds" };
  if (delaySeconds !== 0 && delaySeconds % 86400 === 0) return { value: delaySeconds / 86400, unit: "days" };
  if (delaySeconds !== 0 && delaySeconds % 3600 === 0) return { value: delaySeconds / 3600, unit: "hours" };
  if (delaySeconds !== 0 && delaySeconds % 60 === 0) return { value: delaySeconds / 60, unit: "minutes" };
  return { value: delaySeconds, unit: "seconds" };
}

export function unitToSeconds(value, unit) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const mult = { seconds: 1, minutes: 60, hours: 3600, days: 86400 }[unit] || 1;
  return Math.round(n * mult);
}
