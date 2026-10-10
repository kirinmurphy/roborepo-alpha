#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  isVisible,
  replaceRecord,
  filteredListActionFor,
  matchesFilters,
  resolveBlockers,
  resolveBlocking,
  lifecycleFindingGroups,
  canRepairLifecycleError,
  taskProgressDisplay,
  completionRatio,
  isNotStarted,
  activeCompletionSort,
  completionBadgeColor,
  sortForLifecycle,
  planSort,
  FILTER_DEFAULTS,
} from "../../portal/plans/state.js";

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
testFilteredListActionForLifecycleWhenFilterMatchesPreviousValue();
testFilteredListActionForLifecycleNullWhenFilterDoesNotMatch();
testFilteredListActionForPriorityWhenFilterMatchesPreviousValue();
testFilteredListActionForPriorityNullWhenFilterDoesNotMatch();
testFilteredListActionForUnrelatedPropertyReturnsNull();
testResolveBlockersResolvesMatchingId();
testResolveBlockersMarksUnresolvedId();
testResolveBlockersScopedToSameRepository();
testResolveBlockingFindsReverseReferences();
testResolveBlockingEmptyWhenNoId();
testResolveBlockingExcludesSelf();
testFindingGroupsPartitionWithoutLoss();
testFindingGroupsFallBackToDetailStrings();
testFindingGroupsHandleAnErrorWithNeither();
testEveryDisplayedFindingAppearsInTheRepairPrompt();
testCanRepairRequiresANonEmptyPrompt();
testLifecycleOptionsAreNeverDisabled();
testTaskProgressDisplayByLifecycleAndProgress();
testCompletionRatioIsNullWithoutTasks();
testNotStartedCoversNoTasksAndNoneComplete();
testActiveSortOrdersMostCompleteFirst();
testActiveSortSinksUnstartedAndUntrackedToTheBottom();
testActiveSortFallsBackToPlanSortOnTies();
testSortForLifecycleOnlyChangesActive();
testCompletionBadgeRampEndpointsAndBands();
testCompleteStateSuppressesTheNextAction();
console.log("ok: plans portal state (mutation orchestration helpers) checks passed");

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

function testFilteredListActionForLifecycleWhenFilterMatchesPreviousValue() {
  const change = { property: "lifecycle", previousValue: "backlog", newValue: "active" };
  const state = { selectedLifecycle: "backlog", filters: { ...FILTER_DEFAULTS } };
  const action = filteredListActionFor(change, state);
  assert.ok(action, "expected an action when the current lifecycle tab equals change.previousValue");
  assert.equal(action.type, "lifecycle");
  assert.equal(action.value, "active");
}

function testFilteredListActionForLifecycleNullWhenFilterDoesNotMatch() {
  const change = { property: "lifecycle", previousValue: "backlog", newValue: "active" };
  const state = { selectedLifecycle: "completed", filters: { ...FILTER_DEFAULTS } };
  assert.equal(filteredListActionFor(change, state), null, "no action expected when the current tab does not match previousValue");
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

// --- lifecycle readiness errors ---------------------------------------------------------------

// The dialog renders these two groups and nothing else, so a finding that falls out of both would
// silently never reach the user.
function testFindingGroupsPartitionWithoutLoss() {
  const err = {
    findings: [
      { code: "UNCHECKED_REQUIRED_TASKS", message: "3 remain.", severity: "blocking" },
      { code: "MISSING_VERIFICATION", message: "No verification.", severity: "advisory" },
      { code: "NEXT_ACTION_REMAINS", message: "Still has next_action.", severity: "blocking" },
    ],
  };
  const { blocking, advisory } = lifecycleFindingGroups(err);
  assert.equal(blocking.length + advisory.length, err.findings.length,
    "every finding lands in exactly one group — the dialog shows nothing else");
  assert.deepEqual(blocking.map((item) => item.code), ["UNCHECKED_REQUIRED_TASKS", "NEXT_ACTION_REMAINS"],
    "blocking findings keep their original relative order");
  assert.deepEqual(advisory.map((item) => item.code), ["MISSING_VERIFICATION"],
    "advisory findings are separated out rather than dropped");
}

// Older routes and non-plans domain errors still send plain strings; those must render too.
function testFindingGroupsFallBackToDetailStrings() {
  const { blocking, advisory } = lifecycleFindingGroups({ details: ["Something is wrong.", "So is this."] });
  assert.equal(blocking.length, 2, "detail strings are shown rather than discarded when findings are absent");
  assert.equal(advisory.length, 0, "unclassified detail strings default to the must-fix group");
  assert.equal(blocking[0].message, "Something is wrong.", "the string becomes the finding's message");
}

function testFindingGroupsHandleAnErrorWithNeither() {
  const { blocking, advisory } = lifecycleFindingGroups({ message: "boom" });
  assert.deepEqual([blocking, advisory], [[], []], "an error with no findings or details renders no list at all");
}

// "Copies a prompt matching the current findings" — the actual invariant behind
// that check, testable here even though the clipboard call itself is not.
function testEveryDisplayedFindingAppearsInTheRepairPrompt() {
  const err = {
    findings: [
      { code: "UNCHECKED_REQUIRED_TASKS", message: "3 required tasks remain unchecked.", severity: "blocking" },
      { code: "MISSING_VERIFICATION", message: "Missing Verification section.", severity: "advisory" },
    ],
    repair: {
      prompt: [
        "/plan-write",
        "1. 3 required tasks remain unchecked.",
        "2. Missing Verification section.",
      ].join("\n"),
    },
  };
  const { blocking, advisory } = lifecycleFindingGroups(err);
  for (const item of [...blocking, ...advisory]) {
    assert.ok(err.repair.prompt.includes(item.message),
      `the copied prompt must describe every finding on screen; missing: ${item.code}`);
  }
}

function testCanRepairRequiresANonEmptyPrompt() {
  assert.equal(canRepairLifecycleError({ repair: { prompt: "/plan-write" } }), true,
    "a usable prompt enables the copy button");
  assert.equal(canRepairLifecycleError({ repair: { prompt: "" } }), false,
    "an empty prompt must not offer a copy button that yields nothing");
  assert.equal(canRepairLifecycleError({ details: ["x"] }), false,
    "errors without a repair descriptor (stale, collision) offer no prompt");
  assert.equal(canRepairLifecycleError(undefined), false, "a missing error is not repairable");
}

// Lifecycle options stay selectable until the server rejects a submitted
// move, so a stale browser snapshot can never pre-empt the authoritative finding set. Nothing
// disables them today; this asserts it stays that way, since the regression would be invisible
// in every other test here.
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
  assert.equal(display("backlog", partial), "bar", "started work is not the default anywhere");
  assert.equal(display("backlog", done), "complete");

  assert.equal(display("active", none), "bar", "active always shows progress, even with no tasks");
  assert.equal(display("active", unstarted), "bar");
  assert.equal(display("active", partial), "bar");
  assert.equal(display("active", done), "complete");

  assert.equal(display("completed", none), "none");
  assert.equal(display("completed", partial), "bar", "a completed plan with open tasks must not look finished");
  assert.equal(display("completed", done), "complete");

  assert.equal(display("archived", partial), "bar");
  assert.equal(display("archived", none), "none");
}

// A "next up" line beside an "all tasks complete" badge is a contradiction, so the element hides
// the next-action row in exactly the state that renders the badge.
function testCompleteStateSuppressesTheNextAction() {
  const source = fs.readFileSync(new URL("../../portal/plans/elements/plan-status.js", import.meta.url), "utf8");
  assert.match(source, /\[data-slot=next-row\]"\)\.hidden = progress !== "bar"/,
    "the next-action row must be hidden whenever progress is not the in-progress bar");
  assert.match(source, /\[data-slot=complete-row\]"\)\.hidden = progress !== "complete"/);
  assert.match(source, /\[data-slot=progress-row\]"\)\.hidden = progress !== "bar"/);
}

function testLifecycleOptionsAreNeverDisabled() {
  const source = fs.readFileSync(new URL("../../portal/plans/elements/plan-status.js", import.meta.url), "utf8");
  const dropdown = source.slice(source.indexOf("renderLifecycleDropdown"));
  assert.ok(!/\bdisabled\b/.test(dropdown.slice(0, dropdown.indexOf("\n  }"))),
    "the lifecycle dropdown must never disable itself from snapshot warnings — only a submitted move may be rejected");
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

function testNotStartedCoversNoTasksAndNoneComplete() {
  assert.equal(isNotStarted(record({ taskCounts: counts(0, 0) }).plan), true, "no checklist reads as not started");
  assert.equal(isNotStarted(record({ taskCounts: counts(0, 10) }).plan), true, "zero of ten is not started");
  assert.equal(isNotStarted(record({ taskCounts: counts(1, 10) }).plan), false, "one done means started");
  assert.equal(isNotStarted(record({ taskCounts: counts(10, 10) }).plan), false);
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

function testCompletionBadgeRampEndpointsAndBands() {
  const gray = completionBadgeColor(0);
  const green = completionBadgeColor(1);
  assert.equal(completionBadgeColor(null), gray, "no checklist must read as the neutral 0% badge");
  assert.equal(completionBadgeColor(0.9), green, "90% is the first stop that looks finished");
  assert.equal(completionBadgeColor(0.95), green);
  assert.notEqual(completionBadgeColor(0.85), green,
    "85% must stay distinguishable from 100% — flooring into bands is what prevents that collision");
  assert.notEqual(completionBadgeColor(0.5), gray, "a half-done plan must not look untouched");
  assert.match(green, /^rgb\(\d+,\d+,\d+\)$/, "the badge color must be a plain rgb() string");

  // Monotonic: every 10% band must be at least as green as the one below it, never backwards.
  let previous = -1;
  for (let step = 0; step <= 10; step += 1) {
    const [r, g] = completionBadgeColor(step / 10).match(/\d+/g).map(Number);
    const greenness = g - r;
    assert.ok(greenness >= previous, `band ${step * 10}% must not regress toward gray`);
    previous = greenness;
  }
}
