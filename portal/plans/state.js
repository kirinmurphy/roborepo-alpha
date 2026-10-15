// Filter state, matching, sorting, and facet counts — no DOM here. app.js owns wiring DOM events
// to this module's functions; templates.js owns turning its output into markup.

export const LIFECYCLE_LABELS = {
  active: "Active",
  backlog: "Backlog",
  completed: "Completed",
  archived: "Archived",
  unclassified: "Unclassified",
};

export const FILTER_IDS = [
  "search",
  "priority",
  "blocked",
  "readiness",
  "review",
  "health",
];

export const FILTER_DEFAULTS = {
  search: "",
  priority: "all",
  blocked: "all",
  readiness: "all",
  review: "all",
  health: "all",
};

export const FILTER_LABELS = {
  priority: "priority",
  blocked: "blocked",
  readiness: "readiness",
  review: "review",
  health: "health",
};

export const FILTER_OPTION_DEFS = {
  priority: () => [
    ["all", "all priority"],
    ...["high", "medium", "low", "none"].map((v) => [v, v]),
  ],
  blocked: () => [
    ["all", "all blockers"],
    ["blocked", "blocked"],
    ["unblocked", "unblocked"],
  ],
  readiness: () => [
    ["all", "all readiness"],
    ["ready", "ready"],
    ["draft", "draft"],
  ],
  review: () => [
    ["all", "all review"],
    ...["never-reviewed", "current", "possibly-stale", "unknown"].map((v) => [
      v,
      v,
    ]),
  ],
  health: () => [
    ["all", "all health"],
    ["warnings", "has warnings"],
    ["valid", "valid"],
  ],
};

// Per-field predicates keyed by filter id, each taking the field's current filter value.
// Shared by filteredPlans() (applies all fields) and optionCounts() (applies all fields except
// the one being counted, for facet-style "N remaining if you pick this" counts).
export const FIELD_MATCHERS = {
  priority: (record, value) =>
    value === "all" || record.plan.priority === value,
  blocked: (record, value) => {
    if (value === "blocked") return record.plan.blockers.length > 0;
    if (value === "unblocked") return record.plan.blockers.length === 0;
    return true;
  },
  readiness: (record, value) =>
    value === "all" || record.plan.readiness === value,
  review: (record, value) =>
    value === "all" || record.plan.reviewState === value,
  health: (record, value) => {
    if (value === "warnings") return record.plan.validation.warnings.length > 0;
    if (value === "valid") return record.plan.validation.warnings.length === 0;
    return true;
  },
  search: (record, value) => {
    const q = value.toLowerCase().trim();
    if (!q) return true;
    const plan = record.plan;
    return [
      plan.title,
      plan.id,
      plan.relativePath,
      plan.nextAction,
      record.repository.name,
      ...plan.blockers,
      ...plan.validation.warnings,
    ]
      .join(" ")
      .toLowerCase()
      .includes(q);
  },
};

export function optionLabel(snapshot, id, value) {
  const def = FILTER_OPTION_DEFS[id](snapshot).find(
    ([optValue]) => optValue === value,
  );
  return def ? def[1] : value;
}

export function matchesFilters(record, filters, excludeId) {
  for (const id of FILTER_IDS) {
    if (id === excludeId) continue;
    if (!FIELD_MATCHERS[id](record, filters[id])) return false;
  }
  return true;
}

export function filteredPlans(plans, filters) {
  return plans
    .filter((record) => matchesFilters(record, filters, null))
    .sort(planSort);
}

// Facet-style counts: for `id`, how many plans would match each candidate value in `values` if
// every OTHER active filter stayed as-is. Excludes `id` itself so picking an option doesn't
// shrink its own count relative to the other options.
export function optionCounts(id, values, plans, filters) {
  const pool = plans.filter((record) => matchesFilters(record, filters, id));
  const counts = new Map();
  for (const value of values) {
    counts.set(
      value,
      value === "all"
        ? pool.length
        : pool.filter((record) => FIELD_MATCHERS[id](record, value)).length,
    );
  }
  return counts;
}

export function planSort(a, b) {
  const priority = { high: 0, medium: 1, low: 2, none: 3 };
  const activeBlocked =
    (b.plan.lifecycle === "active" && b.plan.blockers.length ? 1 : 0) -
    (a.plan.lifecycle === "active" && a.plan.blockers.length ? 1 : 0);
  return (
    activeBlocked ||
    (priority[a.plan.priority] ?? 3) - (priority[b.plan.priority] ?? 3) ||
    Date.parse(b.plan.modifiedAt) - Date.parse(a.plan.modifiedAt) ||
    a.plan.title.localeCompare(b.plan.title)
  );
}

// --- active-only completion ordering --------------------------------------------------------
// The Active tab sorts by how finished a plan is; every other lifecycle keeps planSort. Progress
// is only meaningful where work is in flight — ordering Backlog or Archived by completion would
// rank plans on a dimension their lifecycle already answers.

// Fraction complete in [0, 1], or null when the plan has no checkboxes at all. Null is not zero:
// "nothing done" and "nothing tracked" are different claims, and only the first is a real 0%.
export function completionRatio(plan) {
  const { total, complete } = plan.taskCounts;
  return total > 0 ? complete / total : null;
}

// Most complete first; un-started plans (including untracked 0/0) sink to the bottom as one group.
// Ties fall through to planSort so priority, recency, and title still break them the usual way.
export function activeCompletionSort(a, b) {
  const ratioA = completionRatio(a.plan);
  const ratioB = completionRatio(b.plan);
  // null (no checklist) sorts with 0% rather than ahead of it — an untracked plan is not progress.
  const rank = (ratio) => (ratio === null ? -1 : ratio);
  return rank(ratioB) - rank(ratioA) || planSort(a, b);
}

// The comparator for a lifecycle: completion ordering on Active, the shared sort everywhere else.
export function sortForLifecycle(lifecycle) {
  return lifecycle === "active" ? activeCompletionSort : planSort;
}

export function repositoryContext(record) {
  return `Review the plan at \`${record.plan.relativePath}\` in this repository.\n\nFocus on:\n- the current next action\n- unresolved tasks\n- blockers\n- whether the plan still matches the implementation\n\nDo not assume the document is current. Verify relevant claims against the repository.`;
}

export function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleString();
}

// How a plan's task progress should be displayed: "progress", "complete", or "none".
//
// Progress is worth showing whenever it says something the lifecycle does not already imply.
// Nothing started in backlog is the default state of everything in backlog, so a 0% ring there is
// noise; started work is not the default anywhere, and neither is a finished task list. Active
// always shows progress because progress is the point of the lifecycle, even at 0%.
//
// A finished list gets a badge rather than a full ring: a 100% ring reads as "in progress, at the
// end", which is a different claim than "done".
//
// Reads `complete` rather than `remaining`: Home's overview plans carry only total and complete.
export function taskProgressDisplay(plan) {
  const { total = 0, complete = 0 } = plan.taskCounts || {};
  if (total > 0 && complete >= total) return "complete";
  if (complete > 0) return "progress";
  return plan.lifecycle === "active" ? "progress" : "none";
}

// Active plans whose worktree has merged, keyed by plan key, each with the branch it merged into
// (null when Runtime did not say). The same join Home draws from its overview: a plan matched to a
// checkout (`checkoutRootId`) whose worktree Runtime reports as landed.
export function mergedPlanBranches(overview) {
  const merged = new Map();
  for (const repository of overview?.repositories || []) {
    const checkouts = new Map((repository.domains?.runtime?.data?.checkouts || []).map((checkout) => [checkout.rootId, checkout]));
    for (const plan of repository.domains?.plans?.data?.active || []) {
      const checkout = plan.checkoutRootId ? checkouts.get(plan.checkoutRootId) : null;
      if (checkout?.worktreeState === "landed") merged.set(plan.key, { into: checkout.mergedInto || null });
    }
  }
  return merged;
}

// --- lifecycle tab <-> URL state -----------------------------------------------------------
// The selected lifecycle tab is serialized into `?lifecycle=` so the tab survives a refresh and
// participates in back/forward navigation (unlike telemetry's filters, which intentionally use
// replaceState — lifecycle tab switches are meant to be real history stops).

const LIFECYCLE_QUERY_KEY = "lifecycle";
const VALID_LIFECYCLES = new Set([...Object.keys(LIFECYCLE_LABELS)]);

export function lifecycleFromSearchParams(params, fallback = "active") {
  const value = params.get(LIFECYCLE_QUERY_KEY);
  return value && VALID_LIFECYCLES.has(value) ? value : fallback;
}

export function urlForLifecycle(lifecycle) {
  const params = new URLSearchParams(location.search);
  params.set(LIFECYCLE_QUERY_KEY, lifecycle);
  return `${location.pathname}?${params.toString()}`;
}

// --- mutation orchestration helpers ---------------------------------------------------------
// Pure functions the app.js mutation orchestrator uses to decide what a successful priority change
// should do to the visible list and which outcome surface (if any) to show.

// A record is visible when it's on the currently selected lifecycle tab AND matches every active
// filter. Used both before a mutation (to know if a toast/dialog needs to explain a disappearance)
// and after (to know whether the mutated record is still on screen).
export function isVisible(record, selectedLifecycle, filters) {
  return record.plan.lifecycle === selectedLifecycle && matchesFilters(record, filters, null);
}

// Replaces the record at `oldKey` with `newRecord` in a plans array, returning a new array. The
// server returns a whole rebuilt record (new mtime, revalidated fields), so the old one is swapped
// out rather than patched field by field.
export function replaceRecord(plans, oldKey, newRecord) {
  return plans.map((record) => (record.key === oldKey ? newRecord : record));
}

// Determines whether the passive toast's "View {value} plans" filtered-list shortcut should
// appear: only when the specific filter dimension that changed currently equals the *previous*
// value (i.e. the mutation is what caused the plan to leave that filtered view). Returns a
// descriptor the toast controller can render, or null when the shortcut doesn't apply.
export function filteredListActionFor(change, state) {
  if (change.property === "priority") {
    if (state.filters.priority !== change.previousValue) return null;
    return { type: "priority", value: change.newValue, label: `View ${change.newValue} priority plans` };
  }
  return null;
}

// --- blocker/blocking resolution -------------------------------------------------------------
// Resolved live from the current snapshot on every call (not cached on the record) so a mutation
// that only rebuilds one record (see updatePlanPriority) never leaves stale
// blocker/blocking data behind — the next render always recomputes from state.snapshot.plans.
// Plan ids are only unique within one repository (see modules/plan-suite/index.mjs's
// relationshipWarnings), so matches are scoped to the same repository.id as the referencing plan.

// Every blocked_by id, resolved to its plan record when one exists in the same repository.
// Unresolvable ids (typo, wrong repo, deleted plan) come back with resolved: false and no record.
export function resolveBlockers(record, allPlans) {
  return (record.plan.blockers || []).map((id) => {
    const target = allPlans.find((item) => item.plan.id === id && item.repository.id === record.repository.id);
    return target
      ? { id, title: target.plan.title, key: target.key, resolved: true }
      : { id, title: id, key: null, resolved: false };
  });
}

// The reverse of resolveBlockers: every other plan in the same repository whose blocked_by lists
// this plan's id — i.e. what this plan is currently blocking. Always resolved, since these are
// found by scanning the snapshot rather than looked up by a possibly-stale id.
export function resolveBlocking(record, allPlans) {
  if (!record.plan.id) return [];
  return allPlans
    .filter((item) =>
      item.key !== record.key &&
      item.repository.id === record.repository.id &&
      (item.plan.blockers || []).includes(record.plan.id))
    .map((item) => ({ id: item.plan.id, title: item.plan.title, key: item.key, resolved: true }));
}
