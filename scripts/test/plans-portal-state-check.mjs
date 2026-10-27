#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  isVisible,
  replaceRecord,
  filteredListActionFor,
  matchesFilters,
  resolveBlockers,
  resolveBlocking,
  mergedPlanBranches,
  taskProgressDisplay,
  completionRatio,
  activeCompletionSort,
  sortForLifecycle,
  planSort,
  FILTER_DEFAULTS,
  FILTER_IDS,
  FILTER_OPTION_DEFS,
  lifecycleFromSearchParams,
} from "../../portal/plans/state.js";
import { isLifecycle, lifecycleActions, lifecycleLabel, lifecycleTabs, setLifecycleModel, showsPriority } from "../../portal/plans/lifecycle.js";
import { primaryPlanAction, recommendedPlanCommand } from "../../portal/plans/plan-actions.js";
import { LIFECYCLE_MODEL, lifecycleProjection } from "../../modules/plan-suite/lifecycle-manifest.mjs";

// Pure mutation-orchestration
// helpers (isVisible, replaceRecord, filteredListActionFor) have no DOM dependency, so this test
// drives them directly the same way telemetry-portal-state-check.mjs exercises telemetry's URL
// state helpers — no browser needed.

testLifecycleMoveMakesVisibleCardInvisible();
testPriorityChangeUnderMatchingFilterMakesInvisible();
testPriorityChangeUnderAllKeepsVisible();
testRecordNotPreviouslyVisibleStaysInvisible();
testReplaceRecordSwapsOldKeyForNew();
testReplaceRecordLeavesOtherRecordsUntouched();
testFilteredListActionForLifecycleReturnsNull();
testFilteredListActionForPriorityWhenFilterMatchesPreviousValue();
testFilteredListActionForPriorityNullWhenFilterDoesNotMatch();
testFilteredListActionForUnrelatedPropertyReturnsNull();
testResolveBlockersResolvesMatchingId();
testResolveBlockersMarksUnresolvedId();
testResolveBlockersScopedToSameRepository();
testResolveBlockingFindsReverseReferences();
testResolveBlockingEmptyWhenNoId();
testResolveBlockingExcludesSelf();
testMergedPlanBranchesOnlyIncludesLandedActivePlans();
testTaskProgressDisplayByLifecycleAndProgress();
testCompletionRatioIsNullWithoutTasks();
testActiveSortOrdersMostCompleteFirst();
testActiveSortSinksUnstartedAndUntrackedToTheBottom();
testActiveSortFallsBackToPlanSortOnTies();
testSortForLifecycleOnlyChangesActive();
testLifecycleModelComesFromTheSnapshot();
testRecommendedCommandFollowsTheLifecycle();
testFilterNamesNeverReadAsLifecycleOrApproval();
console.log("ok: plans portal state checks passed");

// The portal holds no lifecycle list of its own: everything below comes from the projection the
// server publishes in the plans snapshot, built from the same manifest the domain module reads.
function testLifecycleModelComesFromTheSnapshot() {
  setLifecycleModel(null);
  assert.equal(lifecycleFromSearchParams(new URLSearchParams("lifecycle=review")), "active", "before a snapshot, every tab falls back");
  assert.equal(lifecycleLabel("review"), "review", "an id stands in for its label until the model arrives");
  assert.deepEqual(lifecycleActions("review"), []);

  setLifecycleModel(JSON.parse(JSON.stringify(lifecycleProjection(LIFECYCLE_MODEL))));
  assert.equal(lifecycleFromSearchParams(new URLSearchParams("lifecycle=review")), "review");
  assert.equal(lifecycleFromSearchParams(new URLSearchParams("lifecycle=nonsense")), "active");
  assert.deepEqual(lifecycleTabs().filter((tab) => !tab.secondary).map((tab) => tab.id), ["backlog", "ready", "active", "review"], "Ready and Review are primary tabs");
  assert.deepEqual(lifecycleTabs().filter((tab) => tab.secondary).map((tab) => tab.id), ["completed", "archived", "unclassified"]);
  assert.equal(lifecycleLabel("ready"), "Ready");
  assert.ok(isLifecycle("unclassified"));
  assert.equal(showsPriority("review"), true);
  assert.equal(showsPriority("completed"), false);
  assert.deepEqual(lifecycleActions("review").map((action) => action.label), ["Review", "Fix findings", "Close after merge", "Archive"]);
}

function testRecommendedCommandFollowsTheLifecycle() {
  setLifecycleModel(lifecycleProjection(LIFECYCLE_MODEL));
  const plan = (lifecycle, extra = {}) => ({ ...record({ lifecycle }).plan, ...extra });
  const tasks = (total, complete) => ({ taskCounts: { total, complete, remaining: total - complete } });

  for (const extra of [{}, { readiness: "draft" }, { blockers: ["external"] }]) {
    assert.deepEqual(primaryPlanAction(plan("backlog", extra)), { command: "plan-promote", label: "Promote" });
    assert.deepEqual(primaryPlanAction(plan("ready", extra)), { command: "plan-execute", label: "Start" });
  }
  assert.equal(primaryPlanAction(plan("active", { reviewState: "current", ...tasks(3, 1) })), null, "unfinished work has no primary action");
  for (const reviewState of ["never-reviewed", "possibly-stale"]) {
    assert.equal(primaryPlanAction(plan("active", { reviewState, ...tasks(3, 1) })), null, `${reviewState} plans have no primary action`);
    assert.equal(recommendedPlanCommand(plan("active", { reviewState, ...tasks(3, 1) })), null, "freshness never recommends plan-write");
  }
  assert.equal(primaryPlanAction(plan("active", tasks(3, 3))), null, "checked tasks alone do not establish execution completion");
  assert.equal(recommendedPlanCommand(plan("active", { ...tasks(3, 2), notTestedOpen: 1 })), null, "execution must reach the review lifecycle first");
  assert.equal(recommendedPlanCommand(plan("active", { ...tasks(3, 3), blockers: ["x"] })), null, "a blocked plan has no recommendation");

  assert.deepEqual(primaryPlanAction(plan("review", { qa: { openFindings: 2, decision: "" } })), { command: "plan-review", label: "Review" }, "open findings are fixed by /plan-review in its own session");
  assert.deepEqual(primaryPlanAction(plan("review", { qa: { openFindings: 0, decision: "approved" } })), { command: "plan-close", label: "Close after merge" });
  assert.deepEqual(primaryPlanAction(plan("review", { qa: { openFindings: 0, decision: "" } })), { command: "plan-review", label: "Review" });
  assert.equal(primaryPlanAction(plan("review", { blockers: ["external"] })), null, "blocked plans have no primary action");
  assert.equal(primaryPlanAction(plan("active", { qa: { decision: "approved" }, ...tasks(3, 3) })), null, "approval does not bypass the execution lifecycle");
  assert.equal(primaryPlanAction(plan("completed")), null);
  assert.equal(primaryPlanAction(plan("archived")), null);
}

// Structure and plan freshness used to be shown as "ready"/"draft" and as a "review" state, which a
// reader would take for the Ready and Review lifecycles or for a human's approval.
function testFilterNamesNeverReadAsLifecycleOrApproval() {
  assert.ok(!FILTER_IDS.includes("readiness") && !FILTER_IDS.includes("review"));
  for (const id of ["structure", "freshness"]) {
    for (const [, label] of FILTER_OPTION_DEFS[id]()) {
      assert.doesNotMatch(label, /\bready\b|\breview(ed)?\b|approv/i, `${id} option "${label}" must not read as a lifecycle or an approval`);
    }
  }
}

function record({ key = "k1", lifecycle = "backlog", priority = "high", id = "plan-1", repositoryId = "r1", blockers = [], taskCounts = { total: 0, complete: 0, remaining: 0 } } = {}) {
  return {
    key,
    mtimeMs: 1,
    repository: { id: repositoryId, name: "repo" },
    plan: {
      id,
      title: "Plan " + id,
      lifecycle,
      priority,
      relativePath: `docs/plans/${lifecycle}/${id}.md`,
      nextAction: "",
      blockers,
      dependencies: [],
      related: [],
      reviewedCommit: "",
      reviewState: "never-reviewed",
      modifiedAt: new Date().toISOString(),
      gitStatus: null,
      taskCounts,
      headings: [],
      excerpt: "",
      validation: { valid: true, warnings: [] },
    },
  };
}

function testLifecycleMoveMakesVisibleCardInvisible() {
  const r = record({ lifecycle: "backlog" });
  const before = isVisible(r, "backlog", FILTER_DEFAULTS);
  const moved = record({ ...r, lifecycle: "active" });
  moved.plan.lifecycle = "active";
  const after = isVisible(moved, "backlog", FILTER_DEFAULTS);
  assert.equal(before, true, "expected the original record visible on the backlog tab");
  assert.equal(after, false, "expected the moved record invisible on the backlog tab");
}

function testPriorityChangeUnderMatchingFilterMakesInvisible() {
  const filters = { ...FILTER_DEFAULTS, priority: "high" };
  const r = record({ priority: "high" });
  assert.equal(isVisible(r, "backlog", filters), true);
  const changed = record({ priority: "low" });
  assert.equal(isVisible(changed, "backlog", filters), false, "priority filter=high must exclude a record now priority=low");
}

function testPriorityChangeUnderAllKeepsVisible() {
  const filters = { ...FILTER_DEFAULTS, priority: "all" };
  const changed = record({ priority: "low" });
  assert.equal(isVisible(changed, "backlog", filters), true, "priority filter=all must keep any priority visible");
}

function testRecordNotPreviouslyVisibleStaysInvisible() {
  // A record already excluded by lifecycle tab before a priority change stays excluded after —
  // there is no removal to notify about (the doc: "a record not previously visible does not
  // generate a removal toast").
  const filters = { ...FILTER_DEFAULTS };
  const r = record({ lifecycle: "active" });
  const wasVisible = isVisible(r, "backlog", filters);
  assert.equal(wasVisible, false);
  const changed = record({ lifecycle: "active", priority: "low" });
  const nowVisible = isVisible(changed, "backlog", filters);
  assert.equal(nowVisible, false);
}

function testReplaceRecordSwapsOldKeyForNew() {
  const original = record({ key: "old-key" });
  const updated = record({ key: "new-key" });
  const plans = [record({ key: "other" }), original];
  const replaced = replaceRecord(plans, "old-key", updated);
  assert.equal(replaced.length, 2);
  assert.equal(replaced.find((item) => item.key === "new-key"), updated, "returned old key must be replaced by the new key exactly once");
  assert.equal(replaced.some((item) => item.key === "old-key"), false, "the stale old key must no longer be present");
}

function testReplaceRecordLeavesOtherRecordsUntouched() {
  const other = record({ key: "other" });
  const plans = [other, record({ key: "target" })];
  const replaced = replaceRecord(plans, "target", record({ key: "target-v2" }));
  assert.equal(replaced[0], other, "an unrelated record must be returned as the same reference, not rebuilt");
}

function testFilteredListActionForLifecycleReturnsNull() {
  const change = { property: "lifecycle", previousValue: "backlog", newValue: "active" };
  const state = { selectedLifecycle: "backlog", filters: { ...FILTER_DEFAULTS } };
  assert.equal(filteredListActionFor(change, state), null,
    "lifecycle changes happen through plan-suite commands, not the page's mutation toast");
}

function testFilteredListActionForPriorityWhenFilterMatchesPreviousValue() {
  const change = { property: "priority", previousValue: "high", newValue: "low" };
  const state = { selectedLifecycle: "backlog", filters: { ...FILTER_DEFAULTS, priority: "high" } };
  const action = filteredListActionFor(change, state);
  assert.ok(action);
  assert.equal(action.type, "priority");
  assert.equal(action.value, "low");
}

function testFilteredListActionForPriorityNullWhenFilterDoesNotMatch() {
  const change = { property: "priority", previousValue: "high", newValue: "low" };
  const state = { selectedLifecycle: "backlog", filters: { ...FILTER_DEFAULTS, priority: "all" } };
  assert.equal(filteredListActionFor(change, state), null);
}

function testFilteredListActionForUnrelatedPropertyReturnsNull() {
  const change = { property: "unknown", previousValue: "x", newValue: "y" };
  const state = { selectedLifecycle: "backlog", filters: { ...FILTER_DEFAULTS } };
  assert.equal(filteredListActionFor(change, state), null);
}

// Sanity: matchesFilters is re-exported and used by isVisible internally — confirm the import
// itself resolves (would throw at module load if state.js's exports changed shape).
assert.equal(typeof matchesFilters, "function");

function testResolveBlockersResolvesMatchingId() {
  const blocker = record({ key: "b", id: "plan-b" });
  const blocked = record({ key: "a", id: "plan-a", blockers: ["plan-b"] });
  const resolved = resolveBlockers(blocked, [blocker, blocked]);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].resolved, true);
  assert.equal(resolved[0].key, "b");
  assert.equal(resolved[0].title, "Plan plan-b");
}

function testResolveBlockersMarksUnresolvedId() {
  const blocked = record({ key: "a", id: "plan-a", blockers: ["missing-plan"] });
  const resolved = resolveBlockers(blocked, [blocked]);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].resolved, false);
  assert.equal(resolved[0].key, null);
  assert.equal(resolved[0].title, "missing-plan", "unresolved entries fall back to the raw id as display text");
}

function testResolveBlockersScopedToSameRepository() {
  // Plan ids are only unique within one repository — a same-id match in a different repository
  // must not resolve.
  const otherRepoPlan = record({ key: "other-repo-b", id: "plan-b", repositoryId: "r2" });
  const blocked = record({ key: "a", id: "plan-a", repositoryId: "r1", blockers: ["plan-b"] });
  const resolved = resolveBlockers(blocked, [otherRepoPlan, blocked]);
  assert.equal(resolved[0].resolved, false, "a same-id plan in a different repository must not resolve");
}

function testResolveBlockingFindsReverseReferences() {
  const blocker = record({ key: "b", id: "plan-b" });
  const blocked = record({ key: "a", id: "plan-a", blockers: ["plan-b"] });
  const blocking = resolveBlocking(blocker, [blocker, blocked]);
  assert.equal(blocking.length, 1);
  assert.equal(blocking[0].key, "a");
  assert.equal(blocking[0].resolved, true, "reverse-lookup entries are always resolved since they're found by scanning the snapshot");
}

function testResolveBlockingEmptyWhenNoId() {
  const noIdPlan = record({ key: "x", id: "" });
  assert.deepEqual(resolveBlocking(noIdPlan, [noIdPlan]), [], "a plan with no frontmatter id can't be referenced by others, so blocking is always empty");
}

function testResolveBlockingExcludesSelf() {
  // A plan that (incorrectly) lists its own id in blocked_by must not appear in its own Blocking list.
  const selfBlocked = record({ key: "a", id: "plan-a", blockers: ["plan-a"] });
  assert.deepEqual(resolveBlocking(selfBlocked, [selfBlocked]), []);
}

// The Plans page joins active plans with Runtime worktrees to show which work has landed.
function testMergedPlanBranchesOnlyIncludesLandedActivePlans() {
  const overview = {
    repositories: [
      {
        domains: {
          runtime: { data: { checkouts: [
            { rootId: "landed-root", worktreeState: "landed", mergedInto: "main" },
            { rootId: "open-root", worktreeState: "active" },
          ] } },
          plans: { data: {
            active: [
              { key: "landed-plan", checkoutRootId: "landed-root" },
              { key: "open-plan", checkoutRootId: "open-root" },
              { key: "unmatched-plan", checkoutRootId: "missing-root" },
            ],
            completed: [{ key: "completed-plan", checkoutRootId: "landed-root" }],
          } },
        },
      },
    ],
  };
  assert.deepEqual([...mergedPlanBranches(overview)], [["landed-plan", { into: "main" }]]);
  assert.deepEqual([...mergedPlanBranches(null)], [], "an unavailable overview has no merged plans");
}

// Progress is shown when it says something the lifecycle does not already imply. "Nothing started"
// is the default for backlog and for a completed plan with no task list, so it stays quiet there;
// started work and a finished list are never the default and always show.
function testTaskProgressDisplayByLifecycleAndProgress() {
  const none = { total: 0, complete: 0, remaining: 0 };
  const unstarted = { total: 12, complete: 0, remaining: 12 };
  const partial = { total: 12, complete: 5, remaining: 7 };
  const done = { total: 12, complete: 12, remaining: 0 };

  const display = (lifecycle, taskCounts) => taskProgressDisplay(record({ lifecycle, taskCounts }).plan);

  assert.equal(display("backlog", none), "none", "an empty backlog plan shows nothing");
  assert.equal(display("backlog", unstarted), "none", "unstarted backlog work is the default state");
  assert.equal(display("backlog", partial), "progress", "started work is not the default anywhere");
  assert.equal(display("backlog", done), "complete");

  assert.equal(display("active", none), "progress", "active always shows progress, even with no tasks");
  assert.equal(display("active", unstarted), "progress");
  assert.equal(display("active", partial), "progress");
  assert.equal(display("active", done), "complete");

  assert.equal(display("completed", none), "none");
  assert.equal(display("completed", partial), "progress", "a completed plan with open tasks must not look finished");
  assert.equal(display("completed", done), "complete");

  assert.equal(display("archived", partial), "progress");
  assert.equal(display("archived", none), "none");
}

// --- Active-tab completion ordering ---------------------------------------------------------
// The Active tab sorts by how finished a plan is (see state.js's activeCompletionSort). These pin
// the two distinctions that are easy to collapse by accident: null (no checklist) is not 0%, and
// the completion order must not leak into any other lifecycle.

// A function declaration, not a const arrow: the test calls at the top of this file run before
// this line is reached, and a const would still be in its temporal dead zone when they do.
function counts(complete, total) {
  return { total, complete, remaining: total - complete };
}

function testCompletionRatioIsNullWithoutTasks() {
  assert.equal(completionRatio(record({ taskCounts: counts(0, 0) }).plan), null,
    "a plan with no checkboxes has no ratio — 0/0 is untracked, not zero percent");
  assert.equal(completionRatio(record({ taskCounts: counts(0, 10) }).plan), 0);
  assert.equal(completionRatio(record({ taskCounts: counts(5, 10) }).plan), 0.5);
  assert.equal(completionRatio(record({ taskCounts: counts(9, 9) }).plan), 1);
}

function order(records) {
  return [...records].sort(activeCompletionSort).map((r) => r.plan.id);
}

function testActiveSortOrdersMostCompleteFirst() {
  const half = record({ id: "half", lifecycle: "active", taskCounts: counts(5, 10) });
  const most = record({ id: "most", lifecycle: "active", taskCounts: counts(9, 10) });
  const some = record({ id: "some", lifecycle: "active", taskCounts: counts(2, 10) });
  assert.deepEqual(order([half, some, most]), ["most", "half", "some"]);
}

function testActiveSortSinksUnstartedAndUntrackedToTheBottom() {
  const started = record({ id: "started", lifecycle: "active", taskCounts: counts(1, 10) });
  const unstarted = record({ id: "unstarted", lifecycle: "active", taskCounts: counts(0, 10) });
  const untracked = record({ id: "untracked", lifecycle: "active", taskCounts: counts(0, 0) });
  const sorted = order([untracked, unstarted, started]);
  assert.equal(sorted[0], "started", "any progress outranks none");
  // Untracked (null) must sort with 0%, never above it: an absent checklist is not achievement.
  assert.ok(sorted.indexOf("untracked") > 0, "a plan with no checklist must not lead the list");
}

function testActiveSortFallsBackToPlanSortOnTies() {
  const a = record({ id: "aaa", lifecycle: "active", priority: "low", taskCounts: counts(5, 10) });
  const b = record({ id: "bbb", lifecycle: "active", priority: "high", taskCounts: counts(5, 10) });
  assert.deepEqual(order([a, b]), ["bbb", "aaa"],
    "equal completion must defer to planSort, which ranks high priority first");
}

function testSortForLifecycleOnlyChangesActive() {
  assert.equal(sortForLifecycle("active"), activeCompletionSort);
  for (const lifecycle of ["backlog", "completed", "archived", "unclassified"]) {
    assert.equal(sortForLifecycle(lifecycle), planSort,
      `${lifecycle} must keep the shared sort — completion ordering is Active-only`);
  }
}
