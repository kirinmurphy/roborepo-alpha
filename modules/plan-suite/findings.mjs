// The catalog of every problem plan-doc validation can report, and the constructor that builds
// one. A finding is the normalized, structured form of what used to be a bare warning string:
// a stable code the UI and tests can branch on, plain-language text for a human, and an
// imperative resolution describing the fix.
//
// Findings flow unchanged from here into plan.validation.findings, the LIFECYCLE_REQUIREMENTS
// 422 body, and the generated repair prompt — one source of truth for all three, so a rule's
// wording can never drift between the portal, the API, and the prompt an agent receives.
//
// TO ADD A RULE: add an entry here, then emit it from the appropriate validator. `message` is
// either a string or a function of ({ count, meta }) when it needs to interpolate.
//
// `kind` groups findings by where they come from:
//   schema       — frontmatter fields the plan-suite contract requires
//   structure    — required document sections (see section-synonyms.mjs)
//   lifecycle    — rules that apply only to specific destination lifecycles
//   parse        — malformed frontmatter that prevented clean reading
//   relationship — cross-plan problems (duplicate ids, dangling dependencies)
//
// `severity` is display and prompt-ordering metadata only: "blocking" findings sort first and
// are introduced to an agent as the ones to fix first. It does NOT gate lifecycle moves — the
// destination gate is advisory and a user can always proceed via "Move anyway".

const DEFS = {
  // --- schema ---------------------------------------------------------------------------------
  MISSING_TITLE: {
    kind: "schema",
    severity: "advisory",
    message: "Missing H1 title.",
    resolution: "Add a single `# Title` heading at the top of the document body.",
  },
  MISSING_ID: {
    kind: "schema",
    severity: "blocking",
    message: "Missing frontmatter id.",
    resolution: "Add `id: <lowercase-slug>` to the frontmatter; keep it stable across moves.",
  },
  MISSING_PRIORITY: {
    kind: "schema",
    severity: "advisory",
    message: "Missing frontmatter priority.",
    resolution: "Add `priority: high`, `medium`, `low`, or `none` to the frontmatter.",
  },
  INVALID_PRIORITY: {
    kind: "schema",
    severity: "advisory",
    message: "Priority must be high, medium, low, or none.",
    resolution: "Replace the `priority` value with one of the four allowed values.",
  },
  // The three naming rules below are emitted by naming.mjs, which scopes them to backlog and
  // active. They stay advisory: a filename is safe to change while a plan is still being worked,
  // but once it is completed or archived, inbound links outweigh the convention.
  INVALID_PLAN_FILENAME: {
    kind: "schema",
    severity: "advisory",
    message: ({ meta }) => `Filename is not \`<namespace>-<slug>.md\`: ${meta.filename}.`,
    resolution: "Rename the file to lowercase-hyphenated `<namespace>-<slug>.md`. The `id` never changes with it.",
  },
  UNKNOWN_PLAN_NAMESPACE: {
    kind: "schema",
    severity: "advisory",
    message: ({ meta }) => `Unknown plan namespace: ${meta.namespace}.`,
    resolution: "Use a universal namespace or one declared in `docs/plans/plans-config.json`, or add the namespace to that config first.",
  },
  FORBIDDEN_PLAN_FILENAME_SUFFIX: {
    kind: "schema",
    severity: "advisory",
    message: ({ meta }) => `Filename encodes a lifecycle, status, date, or version: -${meta.suffix}.`,
    resolution: "Drop the suffix. Lifecycle is the folder and status is frontmatter; filenames get linked to and these change.",
  },

  // --- structure ------------------------------------------------------------------------------
  MISSING_SUMMARY: {
    kind: "structure",
    severity: "advisory",
    message: "Missing Summary section.",
    resolution: "Add a `## Summary` section describing what this plan does.",
  },
  MISSING_GOALS: {
    kind: "structure",
    severity: "advisory",
    message: "Missing Goals or desired outcome section.",
    resolution: "Add a `## Goals` section listing the outcomes this plan must achieve.",
  },
  MISSING_CONTEXT: {
    kind: "structure",
    severity: "advisory",
    message: "Missing Current state or Context section.",
    resolution: "Add a `## Context` section describing the current behavior this plan changes.",
  },
  MISSING_DESIGN: {
    kind: "structure",
    severity: "advisory",
    message: "Missing proposed design or implementation approach.",
    resolution: "Add a `## Proposed Design` or `## Implementation Plan` section.",
  },
  MISSING_CRITERIA: {
    kind: "structure",
    severity: "advisory",
    message: "Missing Validation or acceptance criteria.",
    resolution: "Add a `## Validation` or `## Acceptance Criteria` section stating how completion is verified.",
  },

  // --- lifecycle ------------------------------------------------------------------------------
  UNCLASSIFIED_LOCATION: {
    kind: "lifecycle",
    severity: "blocking",
    message: "Plan file is unclassified; move it into a lifecycle folder.",
    resolution: "Move the file into `docs/plans/backlog`, `active`, `completed`, or `archived`.",
  },
  MISSING_NEXT_ACTION: {
    kind: "lifecycle",
    severity: "blocking",
    message: "Missing next_action for actionable lifecycle.",
    resolution: "Set `next_action` in the frontmatter to the next concrete task.",
  },
  MISSING_IMPLEMENTATION_CONTEXT: {
    kind: "lifecycle",
    severity: "blocking",
    message: "Missing implementation context for an active plan.",
    resolution: "Add a `## Proposed Design` or `## Implementation Plan` section before starting work.",
  },
  MISSING_SUCCESS_CRITERIA: {
    kind: "lifecycle",
    severity: "blocking",
    message: "Missing success criteria for an active plan.",
    resolution: "Add a `## Validation` or `## Acceptance Criteria` section before starting work.",
  },
  EMPTY_BLOCKER_ENTRY: {
    kind: "lifecycle",
    severity: "blocking",
    message: "blocked_by lists a blocker with no value.",
    resolution: "Remove the empty `blocked_by` entry or replace it with a real plan id.",
  },
  UNCHECKED_REQUIRED_TASKS: {
    kind: "lifecycle",
    severity: "blocking",
    message: "Completed plan has unchecked tasks.",
    resolution: "Complete or remove the remaining required tasks.",
  },
  NEXT_ACTION_REMAINS: {
    kind: "lifecycle",
    severity: "blocking",
    message: "Completed plan still has next_action.",
    resolution: "Finish the action or clear `next_action`.",
  },
  BLOCKERS_REMAIN: {
    kind: "lifecycle",
    severity: "blocking",
    message: "Completed plan still has blockers.",
    resolution: "Resolve the blockers or clear `blocked_by`.",
  },
  UNCONFIRMED_NOT_TESTED: {
    kind: "lifecycle",
    severity: "advisory",
    message: ({ count }) => `${count} unconfirmed Not tested entr${count === 1 ? "y" : "ies"}.`,
    resolution: "Confirm each entry by hand and check it off, or delete it with the reason recorded in the plan's `## Decision Log`.",
  },
  MISSING_VERIFICATION: {
    kind: "lifecycle",
    severity: "advisory",
    message: "Missing Verification section describing evidence or a stated limitation.",
    resolution: "Add a `## Verification` section recording evidence, or state the limitation explicitly.",
  },
  ARCHIVED_NEXT_ACTION: {
    kind: "lifecycle",
    severity: "advisory",
    message: "Archived plan still has next_action.",
    resolution: "Clear `next_action` — archived plans are not actionable.",
  },

  // --- parse ----------------------------------------------------------------------------------
  MISSING_FRONTMATTER: {
    kind: "parse",
    severity: "blocking",
    message: "Missing frontmatter.",
    resolution: "Add a `---` frontmatter block at the very top of the file with at least `id` and `priority`.",
  },
  UNCLOSED_FRONTMATTER: {
    kind: "parse",
    severity: "blocking",
    message: "Unclosed frontmatter.",
    resolution: "Add the closing `---` line that ends the frontmatter block.",
  },
  UNSUPPORTED_FRONTMATTER_SYNTAX: {
    kind: "parse",
    severity: "advisory",
    message: ({ meta }) => `Unsupported frontmatter syntax on line ${meta.line}.`,
    resolution: "Rewrite the line as `key: value`, or as a `  - item` entry under a list field.",
  },
  DUPLICATE_FRONTMATTER_KEY: {
    kind: "parse",
    severity: "advisory",
    message: ({ meta }) => `Duplicate frontmatter key: ${meta.key}.`,
    resolution: "Remove the repeated key so only one definition remains.",
  },
  NON_ARRAY_FIELD: {
    kind: "parse",
    severity: "advisory",
    message: ({ meta }) => `${meta.key} must be an array.`,
    resolution: "Rewrite the value as a block list (`  - item` on following lines) or as `[]`.",
  },
  // Distinct from the schema-level INVALID_PRIORITY: this one is raised while reading frontmatter
  // and names the offending value, where INVALID_PRIORITY states the contract during destination
  // validation. Both can appear on the same document.
  INVALID_PRIORITY_VALUE: {
    kind: "parse",
    severity: "advisory",
    message: ({ meta }) => `Invalid priority: ${meta.value}.`,
    resolution: "Use one of: `high`, `medium`, `low`, `none`.",
  },
  INVALID_ID: {
    kind: "parse",
    severity: "advisory",
    message: ({ meta }) => `Invalid id: ${meta.value}.`,
    resolution: "Use a short lowercase base36 id of 6-8 characters, e.g. `a3f9c2k1`.",
  },
  // LEGACY(slug-ids): informational only. Reports which id convention a plan uses, so this measures
  // composition rather than outstanding work — a slug id is valid permanently and must not be
  // rewritten, because inbound references resolve against it.
  LEGACY_SLUG_ID: {
    kind: "parse",
    severity: "advisory",
    message: ({ meta }) => `Legacy slug id: ${meta.value}.`,
    resolution: "Valid, and safe to leave. New plans use a short base36 id; changing an existing id breaks every `related` and `depends_on` pointing at it.",
  },
  DOCUMENT_TOO_LARGE: {
    kind: "parse",
    severity: "advisory",
    message: "Document is over 1 MiB and was not parsed.",
    resolution: "Split the document or move reference material into a separate file.",
  },
  DOCUMENT_TOO_LARGE_TO_RENDER: {
    kind: "parse",
    severity: "advisory",
    message: "Document is over 1 MiB and was not rendered or embedded in prompts.",
    resolution: "Split the document or move reference material into a separate file.",
  },

  // --- relationship ---------------------------------------------------------------------------
  DUPLICATE_PLAN_ID: {
    kind: "relationship",
    severity: "blocking",
    message: ({ meta }) => `Duplicate plan id: ${meta.id}.`,
    resolution: "Give one of the plans a different `id`; ids must be unique within a repository.",
  },
  SELF_DEPENDENCY: {
    kind: "relationship",
    severity: "advisory",
    message: "Plan depends on itself.",
    resolution: "Remove the plan's own id from `depends_on`.",
  },
  DEPENDENCY_NOT_FOUND: {
    kind: "relationship",
    severity: "advisory",
    message: ({ meta }) => `Dependency not found: ${meta.dependency}.`,
    resolution: "Correct the id in `depends_on`, or remove it if that plan no longer exists.",
  },
  RELATED_NOT_FOUND: {
    kind: "relationship",
    severity: "advisory",
    message: ({ meta }) => `Related plan not found: ${meta.related}.`,
    resolution: "Correct the id in `related`, or remove it if that plan no longer exists.",
  },
  BLOCKER_NOT_FOUND: {
    kind: "relationship",
    severity: "advisory",
    message: ({ meta }) => `Blocker not found: ${meta.blocker}.`,
    resolution: "Correct the id in `blocked_by`, or remove it if that plan no longer exists.",
  },
};

export const FINDING_CODES = Object.freeze(Object.keys(DEFS));

// Builds one finding. `count` is carried through for rules that aggregate occurrences, and `meta`
// holds code-specific structured data (the offending value, the accepted heading names, …) so
// consumers can render richer detail than the message string alone.
export function finding(code, { count, meta } = {}) {
  const def = DEFS[code];
  if (!def) throw new Error(`unknown finding code: ${code}`);
  const resolved = { code, kind: def.kind, severity: def.severity };
  resolved.message = typeof def.message === "function" ? def.message({ count, meta: meta || {} }) : def.message;
  resolved.resolution = def.resolution;
  if (count !== undefined) resolved.count = count;
  if (meta !== undefined) resolved.meta = meta;
  return resolved;
}

// The display-string projection of a finding list. plan.validation keeps this alongside the
// structured findings so the five existing string consumers (search corpus, health filter, card
// badge, drawer list, portable prompt summary) keep working untouched.
export function messagesOf(findings) {
  return findings.map((item) => item.message);
}

// Blocking findings first, original order preserved within each group — used for prompt and
// dialog ordering so the problems most worth fixing lead.
export function sortBySeverity(findings) {
  return [
    ...findings.filter((item) => item.severity === "blocking"),
    ...findings.filter((item) => item.severity !== "blocking"),
  ];
}
