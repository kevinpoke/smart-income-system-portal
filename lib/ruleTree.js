// RULE-BUILDER batch: structured boolean rule tree (AST) for AI Sales
// trigger conditions, replacing the old flat ALL/ANY trigger_match_mode.
//
// Tree shape (persisted as automation_definitions.rule_tree_json):
//   leaf:  { conditionId: "<automation_trigger_conditions.id>" }
//   group: { op: OP, children: [leaf|group, ...] }
//
// Canonical operators (admin-facing label -> same internal op):
//   AND              "And" connector / "All of" group           -> all children true
//   OR               "Or" connector / "Any of" group            -> >=1 child true
//   ALL_OF           alias of AND (group wording)                -> all children true
//   ANY_OF           alias of OR (group wording)                 -> >=1 child true
//   AT_LEAST_ONE_OF  alias of OR (group wording)                 -> >=1 child true
//   NONE_OF          "None of" group                             -> 0 children true
//   NEITHER_NOR      "Neither...nor" connector                   -> 0 children true (same as NONE_OF)
//   EITHER_OR        "Either...or" connector                     -> exactly 1 child true (XOR)
//   DOES_NOT_HAVE    unary negative predicate                    -> child is false (exactly 1 child)
//   BUT_NOT          "But not" connector                         -> AND(children[0..n-2]) AND NOT(children[n-1])
//
// A condition can be an EVENT condition (has one-or-more timestamped
// occurrences per account: FIRST_LOGIN, EACH_LOGIN, WATCH_MODULE,
// MESSAGE_READ, SUPPORT_TAG_ADDED, JOIN_WAITLIST) or a STATE condition
// (a pure boolean with no occurrence timestamp, re-evaluated fresh every
// time it's checked: DID_NOT_JOIN_WAITLIST). See automationEvaluator.js
// for the resolvers.

export const GROUP_OPERATORS = [
  "AND",
  "OR",
  "ALL_OF",
  "ANY_OF",
  "AT_LEAST_ONE_OF",
  "NONE_OF",
  "NEITHER_NOR",
  "EITHER_OR",
  "DOES_NOT_HAVE",
  "BUT_NOT",
];

const ALL_LIKE = new Set(["AND", "ALL_OF"]);
const ANY_LIKE = new Set(["OR", "ANY_OF", "AT_LEAST_ONE_OF"]);
const NONE_LIKE = new Set(["NONE_OF", "NEITHER_NOR"]);

export const MAX_RULE_TREE_DEPTH = 5;

export function isLeaf(node) {
  if (!node || typeof node !== "object" || node.op) return false;
  return typeof node.conditionId === "string" || typeof node.conditionIndex === "number";
}

export function isGroup(node) {
  return node && typeof node === "object" && typeof node.op === "string" && Array.isArray(node.children);
}

// Returns the leaf's addressing key -- conditionId (persisted tree) or
// conditionIndex (tree being validated/resolved before ids exist).
// Every other function below (collectConditionIds, evaluateRuleTreeBoolean,
// computeAnchorCandidates) is keyed generically off this so the SAME code
// works for both index-addressed and id-addressed trees.
function leafKey(node) {
  return typeof node.conditionId === "string" ? node.conditionId : node.conditionIndex;
}

// Converts a tree built with { conditionIndex } leaves (position in the
// flat conditions[] array being created/replaced -- used by the client
// and by create/update before condition rows have real ids yet) into one
// with { conditionId } leaves, using the just-inserted id at each index.
// Returns null if any index is out of range.
export function resolveRuleTreeIndexesToIds(node, idsByIndex) {
  if (isLeaf(node)) {
    if (typeof node.conditionId === "string") return { conditionId: node.conditionId };
    const id = idsByIndex[node.conditionIndex];
    if (!id) return null;
    return { conditionId: id };
  }
  if (!isGroup(node)) return null;
  const children = [];
  for (const child of node.children) {
    const resolved = resolveRuleTreeIndexesToIds(child, idsByIndex);
    if (!resolved) return null;
    children.push(resolved);
  }
  return { op: node.op, children };
}

// Validates tree shape/operators/depth/arity. Does NOT check that
// conditionIds exist -- caller cross-checks those against the actual
// condition row set (see validateRuleTree in automationDefinitions.js).
export function validateRuleTreeShape(node, depth = 1) {
  if (depth > MAX_RULE_TREE_DEPTH) return "Rule nesting is too deep (max 5 levels).";
  if (isLeaf(node)) return null;
  if (!isGroup(node)) return "Malformed rule node.";
  if (!GROUP_OPERATORS.includes(node.op)) return `Invalid rule operator: ${node.op}`;
  if (!Array.isArray(node.children) || node.children.length === 0) {
    return "A rule group cannot be empty.";
  }
  if (node.op === "DOES_NOT_HAVE" && node.children.length !== 1) {
    return "\"Does Not Have\" requires exactly one condition.";
  }
  if (node.op === "BUT_NOT" && node.children.length < 2) {
    return "\"But Not\" requires at least two conditions.";
  }
  for (const child of node.children) {
    const err = validateRuleTreeShape(child, depth + 1);
    if (err) return err;
  }
  return null;
}

// Collects every leaf addressing key (conditionId or conditionIndex)
// referenced anywhere in the tree.
export function collectConditionIds(node, out = []) {
  if (isLeaf(node)) {
    out.push(leafKey(node));
    return out;
  }
  if (isGroup(node)) {
    for (const child of node.children) collectConditionIds(child, out);
  }
  return out;
}

// Detects a condition referencing itself as a group (defensive -- rule
// trees are plain data, this guards against a conditionId pointing back
// into a structure that contains it, which should never happen given the
// leaf/group shape but is checked anyway per spec's validation list).
export function hasDuplicateLeaf(node, seen = new Set()) {
  if (isLeaf(node)) {
    return false; // duplicates of the SAME leaf id across branches are allowed (e.g. reused in both AND/OR) -- not a cycle.
  }
  if (isGroup(node)) {
    for (const child of node.children) {
      if (hasDuplicateLeaf(child, seen)) return true;
    }
  }
  return false;
}

// ---- Boolean evaluation (given a map of conditionId -> boolean) ---------

export function evaluateRuleTreeBoolean(node, truthByConditionId) {
  if (isLeaf(node)) {
    return Boolean(truthByConditionId.get(leafKey(node)));
  }
  const vals = node.children.map((c) => evaluateRuleTreeBoolean(c, truthByConditionId));
  return evaluateOp(node.op, vals);
}

function evaluateOp(op, vals) {
  const trueCount = vals.filter(Boolean).length;
  if (ALL_LIKE.has(op)) return vals.every(Boolean);
  if (ANY_LIKE.has(op)) return trueCount >= 1;
  if (NONE_LIKE.has(op)) return trueCount === 0;
  if (op === "EITHER_OR") return trueCount === 1;
  if (op === "DOES_NOT_HAVE") return !vals[0];
  if (op === "BUT_NOT") {
    const negative = vals[vals.length - 1];
    const positives = vals.slice(0, -1);
    return positives.every(Boolean) && !negative;
  }
  throw new Error(`Unknown rule operator: ${op}`);
}

// ---- Anchor/candidate computation (event-timeline resolution) -----------
//
// `occurrencesByConditionId` maps conditionId -> array of
// { eventKey, occurredAt (ms) }, ALREADY FILTERED to one account, for
// EVENT-type conditions. STATE-type conditions are NOT present in this
// map (they have no occurrence timeline) -- they are resolved fresh via
// `stateByConditionId` (conditionId -> boolean, current truth).
//
// Returns { candidates: [{ anchorMs, keyParts: [conditionId,...] }], hasAnchor }
// `hasAnchor` is false when the tree contains no EVENT condition in an
// anchor-contributing (non-negated) position at all -- such a rule can
// never become eligible and should be rejected at validation time.
//
// Design (documented, intentionally simplified vs. a fully general
// per-branch cross-product, which would be combinatorially unsafe):
//   - AND-like / BUT_NOT positive side: each child contributes its
//     EARLIEST candidate anchor (first time it became true); the group's
//     anchor = MAX over children (all must have happened), keyParts
//     concatenated. A child with zero candidates (pure state/negated)
//     contributes nothing to the anchor but must still pass as a gate
//     check at send time (see computeGateChecks below).
//   - OR-like (OR/ANY_OF/AT_LEAST_ONE_OF/EITHER_OR): the group's
//     candidate list is the UNION of every child's candidates (each
//     occurrence is its own candidate) -- when nested inside an AND/
//     BUT_NOT-positive parent, this list collapses to its own earliest
//     entry (per the AND rule above); at the TOP level each distinct
//     candidate becomes its own eligible event (preserves repeatable-
//     trigger semantics, e.g. EACH_LOGIN, same as the pre-existing
//     system's ANY handling).
//   - NONE_OF/NEITHER_NOR/DOES_NOT_HAVE: no anchor contribution (pure
//     gate, see computeGateChecks).
export function computeAnchorCandidates(node, occurrencesByConditionId) {
  if (isLeaf(node)) {
    const occs = occurrencesByConditionId.get(leafKey(node));
    if (occs === undefined) {
      // Not present in the map at all -- a STATE-type condition (e.g.
      // DID_NOT_JOIN_WAITLIST), which has no occurrence timeline of its
      // own and never anchors a rule by itself (see automationEvaluator.js
      // -- state conditions are re-checked fresh immediately before send
      // instead). Distinct from an EVENT condition with zero occurrences
      // so far (an empty array, NOT undefined -- see below), which DOES
      // block an AND-like group from anchoring until it first occurs.
      return { candidates: [], hasAnchor: false };
    }
    if (occs.length === 0) return { candidates: [], hasAnchor: true };
    return {
      // Each occurrence's own `repeatable` flag (set by the resolver in
      // automationEvaluator.js) rides along in keyParts so a top-level
      // OR/ANY-of-non-repeatable-conditions can be collapsed to one
      // eligible event per account (matching the pre-rule-builder ANY
      // behavior) while a repeatable source (EACH_LOGIN/SUPPORT_TAG_ADDED/
      // MESSAGE_READ) keeps every distinct occurrence independently
      // eligible -- see collapseNonRepeatableCandidates below.
      candidates: occs.map((o) => ({
        anchorMs: o.occurredAt,
        keyParts: [{ eventKey: o.eventKey, repeatable: Boolean(o.repeatable) }],
      })),
      hasAnchor: true,
    };
  }

  if (NONE_LIKE.has(node.op) || node.op === "DOES_NOT_HAVE") {
    return { candidates: [], hasAnchor: false };
  }

  if (node.op === "BUT_NOT") {
    const positives = node.children.slice(0, -1);
    return reduceAllLike(positives, occurrencesByConditionId);
  }

  if (ALL_LIKE.has(node.op)) {
    return reduceAllLike(node.children, occurrencesByConditionId);
  }

  if (ANY_LIKE.has(node.op) || node.op === "EITHER_OR") {
    let candidates = [];
    let anyAnchor = false;
    for (const child of node.children) {
      const sub = computeAnchorCandidates(child, occurrencesByConditionId);
      if (sub.hasAnchor) anyAnchor = true;
      candidates = candidates.concat(sub.candidates);
    }
    // EITHER_OR (XOR) needs every individual occurrence preserved (the
    // boolean evaluator re-checks exact-one-true at send time regardless
    // of which occurrence anchored it), but a plain OR/ANY_OF/
    // AT_LEAST_ONE_OF group collapses every NON-repeatable candidate for
    // the same account down to its single earliest occurrence -- matching
    // the pre-rule-builder ANY behavior (one eligible event per account,
    // not one per satisfied condition) -- while leaving every repeatable
    // candidate (EACH_LOGIN/SUPPORT_TAG_ADDED/MESSAGE_READ) independently
    // eligible, since each of ITS occurrences is a genuinely distinct event.
    if (node.op !== "EITHER_OR") {
      candidates = collapseNonRepeatableOrCandidates(candidates);
    }
    return { candidates, hasAnchor: anyAnchor };
  }

  return { candidates: [], hasAnchor: false };
}

// Collapses candidates whose keyParts are ALL marked non-repeatable down
// to one earliest-wins entry (no accountId concept exists at this layer
// -- the caller in automationEvaluator.js only ever invokes this per
// single account, so "the account" is implicit/singular here). A
// candidate with ANY repeatable keyPart is left untouched/distinct.
function collapseNonRepeatableOrCandidates(candidates) {
  const repeatable = [];
  let nonRepeatableEarliest = null;
  for (const c of candidates) {
    const isRepeatable = c.keyParts.some((p) => p.repeatable);
    if (isRepeatable) {
      repeatable.push(c);
    } else if (!nonRepeatableEarliest || c.anchorMs < nonRepeatableEarliest.anchorMs) {
      nonRepeatableEarliest = c;
    }
  }
  return nonRepeatableEarliest ? [...repeatable, nonRepeatableEarliest] : repeatable;
}

function reduceAllLike(children, occurrencesByConditionId) {
  // Singleton AND/ALL_OF/BUT_NOT-positive-side group: "ALL of [X]" is
  // trivially equivalent to X itself -- pass its full candidate list
  // through UNCHANGED rather than collapsing to one earliest-wins
  // candidate. This matters because EVERY automation (including a
  // single-condition one) is wrapped in an ALL_OF-of-one tree (see
  // buildLegacyRuleTree/migrateLegacyRuleTrees + the rule-builder UI's
  // own default single-condition tree) -- without this passthrough, a
  // lone repeatable condition (EACH_LOGIN/SUPPORT_TAG_ADDED/MESSAGE_READ)
  // would silently lose its repeatability the moment it's the sole
  // member of an ALL_OF group, a real regression from the pre-rule-tree
  // evaluator's explicit "conditions.length === 1 -> every occurrence
  // passes through unchanged" special case. Multi-child AND/BUT_NOT
  // groups keep the deliberate earliest-per-child simplification
  // documented above computeAnchorCandidates (repeatable-AND-combination
  // anchoring is intentionally out of scope, same as the pre-existing
  // system).
  if (children.length === 1) {
    return computeAnchorCandidates(children[0], occurrencesByConditionId);
  }

  let maxAnchor = -Infinity;
  let keyParts = [];
  let anyRequiredEvent = false;
  for (const child of children) {
    const sub = computeAnchorCandidates(child, occurrencesByConditionId);
    if (!sub.hasAnchor) continue; // pure gate child, no timeline contribution
    anyRequiredEvent = true;
    if (sub.candidates.length === 0) {
      // Required event child has NEVER occurred for this account -- the
      // whole AND can never be satisfied (yet).
      return { candidates: [], hasAnchor: true };
    }
    const earliest = sub.candidates.reduce((a, b) => (a.anchorMs <= b.anchorMs ? a : b));
    if (earliest.anchorMs > maxAnchor) maxAnchor = earliest.anchorMs;
    keyParts = keyParts.concat(earliest.keyParts);
  }
  if (!anyRequiredEvent) {
    // Entire AND-like group is state/gate-only -- no anchor of its own.
    return { candidates: [], hasAnchor: false };
  }
  return { candidates: [{ anchorMs: maxAnchor, keyParts }], hasAnchor: true };
}

// ---- Gate checks (state re-evaluated fresh at send time) ----------------
//
// Walks the tree and, given the SAME boolean truth map used for full
// evaluation, simply re-runs evaluateRuleTreeBoolean. Kept as a separate
// named export so the evaluator's intent ("recheck immediately before
// send") is explicit at call sites, even though the implementation is
// identical to evaluateRuleTreeBoolean.
export function recheckRuleTreeAtSendTime(node, truthByConditionId) {
  return evaluateRuleTreeBoolean(node, truthByConditionId);
}

// ---- Migration helpers ---------------------------------------------------

// Builds a rule tree from the legacy flat {triggerMatchMode, conditionIds}
// shape. 'all' -> ALL_OF, 'any' -> ANY_OF. Single-condition automations
// still wrap in an ALL_OF group of one for a single, authoritative shape.
export function buildLegacyRuleTree(triggerMatchMode, conditionIds) {
  const op = triggerMatchMode === "any" ? "ANY_OF" : "ALL_OF";
  return { op, children: conditionIds.map((id) => ({ conditionId: id })) };
}
