#!/usr/bin/env node
// The Backlog view model the browser runs: directory counts, the URL level, and draft moves.
import assert from "node:assert/strict";
import {
  NO_NAMESPACE,
  createDraft,
  dropBlock,
  hrefWithNamespace,
  isActionEnabled,
  isDraftDirty,
  moveBlock,
  namespaceDirectory,
  namespaceFromSearch,
  nextUp,
  openPrerequisites,
  orderedIds,
  repositoryDirectory,
} from "../../portal/plans/backlog-model.js";

const block = (...ids) => ({ ids, keys: ids.map((id) => `k-${id}`) });
const view = {
  namespace: "portal",
  revision: "r1",
  ordered: [block("A", "B", "C"), block("X")],
  needsPrioritization: [block("N")],
  unrankable: [],
};

// URL level.
assert.equal(namespaceFromSearch("?lifecycle=backlog&namespace=portal"), "portal");
assert.equal(namespaceFromSearch("?lifecycle=backlog"), null);
assert.equal(hrefWithNamespace("/plans?lifecycle=backlog&repo=r", "portal"), "/plans?lifecycle=backlog&repo=r&namespace=portal");
assert.equal(hrefWithNamespace("/plans?namespace=portal&repo=r", null), "/plans?repo=r");

// Directory counts measure plans, not groups, and narrow with filters.
const entry = { repositoryId: "r1", name: "one", urlKey: "one", namespaces: [view], noNamespace: ["bad"] };
const empty = { repositoryId: "r2", name: "two", urlKey: "two", namespaces: [], noNamespace: [] };
const all = new Set(["k-A", "k-B", "k-C", "k-X", "k-N", "bad"]);
assert.deepEqual(repositoryDirectory([entry, empty], all), [
  { repositoryId: "r1", name: "one", urlKey: "one", planCount: 6, unprioritizedCount: 1 },
], "only repos with Backlog plans, counting plans and unprioritized plans");
assert.deepEqual(repositoryDirectory([entry], new Set(["k-A"])).map((row) => row.planCount), [1], "filters narrow the counts");
assert.deepEqual(repositoryDirectory([entry], new Set()), [], "a repo with no matching plan drops out");
assert.deepEqual(namespaceDirectory(entry, all), [
  { namespace: "portal", planCount: 5, unprioritizedCount: 1 },
  { namespace: NO_NAMESPACE, planCount: 1, unprioritizedCount: 0 },
], "No namespace comes last");
assert.deepEqual(namespaceDirectory(entry, new Set(["k-N"])).map((row) => row.namespace), ["portal"], "No namespace shows only when plans land there");

// Drafts start clean and only ever move whole blocks.
const draft = createDraft(view);
assert.equal(isDraftDirty(draft), false);
assert.equal(isDraftDirty(null), false);
assert.deepEqual(orderedIds(moveBlock(draft, "ordered", 1, "top")), ["X", "A", "B", "C"], "a row moves past a whole group");
assert.deepEqual(orderedIds(moveBlock(draft, "ordered", 0, "down")), ["X", "A", "B", "C"]);
assert.deepEqual(orderedIds(moveBlock(draft, "ordered", 1, "up")), ["X", "A", "B", "C"]);
assert.deepEqual(orderedIds(moveBlock(draft, "ordered", 0, "bottom")), ["X", "A", "B", "C"]);
assert.equal(isDraftDirty(moveBlock(draft, "ordered", 1, "top")), true);

// Placement empties Needs prioritization into the draft and stays draft-only.
const placedTop = moveBlock(draft, "needs", 0, "place-top");
assert.deepEqual(orderedIds(placedTop), ["N", "A", "B", "C", "X"]);
assert.deepEqual(placedTop.needs, [], "the plan leaves Needs prioritization immediately");
assert.equal(isDraftDirty(placedTop), true);
assert.deepEqual(orderedIds(moveBlock(draft, "needs", 0, "bottom")), ["A", "B", "C", "X", "N"]);
assert.deepEqual(draft.needs.length, 1, "the original draft is never mutated");

// Disabled states.
assert.equal(isActionEnabled("ordered", "top", 0, 2), false);
assert.equal(isActionEnabled("ordered", "up", 0, 2), false);
assert.equal(isActionEnabled("ordered", "down", 0, 2), true);
assert.equal(isActionEnabled("ordered", "down", 1, 2), false);
assert.equal(isActionEnabled("ordered", "bottom", 1, 2), false);
assert.equal(isActionEnabled("ordered", "up", 1, 2), true);
assert.equal(isActionEnabled("needs", "place-top", 0, 1), true);

// Drops are block-level, counted in the list as drawn.
assert.deepEqual(orderedIds(dropBlock(draft, "ordered", 1, 0)), ["X", "A", "B", "C"]);
assert.deepEqual(orderedIds(dropBlock(draft, "ordered", 0, 2)), ["X", "A", "B", "C"]);
assert.equal(isDraftDirty(dropBlock(draft, "ordered", 0, 1)), false, "dropping a block where it sits is no change");
assert.deepEqual(orderedIds(dropBlock(draft, "needs", 0, 1)), ["A", "B", "C", "N", "X"]);

// Prerequisites: scoped to the repo, completed ones gone, and a position only for another namespace.
const repository = { id: "hash", repositoryId: "r" };
const planRecord = (id, namespace, lifecycle, dependencies = [], blockers = []) => ({
  key: `k-${id}`,
  repository,
  plan: { id, namespace, lifecycle, title: id, dependencies, blockers },
});
const records = [
  planRecord("ranked", "strategy", "backlog"),
  planRecord("sibling", "strategy", "backlog"),
  planRecord("unranked", "strategy", "backlog"),
  planRecord("local", "agents", "backlog"),
  planRecord("working", "agents", "active"),
  planRecord("done", "agents", "completed"),
  planRecord("retired", "agents", "archived"),
  { ...planRecord("elsewhere", "agents", "completed"), key: "k-other-repo", repository: { id: "other" } },
];
const strategyView = {
  namespace: "strategy",
  ordered: [block("sibling"), block("ranked")],
  needsPrioritization: [block("unranked")],
  unrankable: [],
};
const backlogEntries = [{ repositoryId: "r", namespaces: [strategyView] }];
const statusOf = (dependencies) => openPrerequisites(planRecord("self", "agents", "backlog", dependencies), records, backlogEntries)
  .map((item) => `${item.namespace ? `${item.namespace}/` : ""}${item.label}: ${item.status}`);
assert.deepEqual(statusOf(["ranked"]), ["strategy/ranked: Backlog, position 2"]);
assert.deepEqual(
  openPrerequisites(planRecord("self", "agents", "backlog", ["misfiled"]), [...records, planRecord("misfiled", null, "backlog")], backlogEntries).map((item) => item.status),
  ["Backlog, not prioritized"],
  "a prerequisite in No namespace is not in this namespace's list and has no order",
);
const linkedStrategyView = { ...strategyView, ordered: [block("sibling", "unranked"), block("ranked")] };
assert.deepEqual(
  openPrerequisites(planRecord("self", "agents", "backlog", ["ranked"]), records, [{ repositoryId: "r", namespaces: [linkedStrategyView] }]).map((item) => item.status),
  ["Backlog, position 2"],
  "a position counts blocks, as Ordering numbers them, not plans",
);
assert.deepEqual(statusOf(["unranked"]), ["strategy/unranked: Backlog, not prioritized"]);
assert.deepEqual(statusOf(["local"]), ["agents/local: Backlog"]);
assert.deepEqual(statusOf(["working"]), ["agents/working: Active"]);
assert.deepEqual(statusOf(["done"]), []);
assert.deepEqual(statusOf(["retired"]), ["agents/retired: Archived"]);
assert.deepEqual(statusOf(["elsewhere"]), ["elsewhere: not found"], "another repo's plan with that id does not count");

// Next up: each namespace's highest-ranked plan, never an unranked one, and never one held up by
// Backlog, a blocker, or a missing or archived prerequisite.
const nextRecords = [
  planRecord("heldByBacklog", "agents", "backlog", ["free"]),
  planRecord("blocked", "agents", "backlog", [], ["upstream"]),
  planRecord("afterWork", "agents", "backlog", ["working", "done"]),
  planRecord("free", "agents", "backlog"),
  planRecord("missing", "ingest", "backlog", ["nowhere"]),
  planRecord("afterRetired", "ingest", "backlog", ["retired"]),
  planRecord("unrankedFree", "strategy", "backlog"),
  planRecord("working", "agents", "active"),
  planRecord("done", "agents", "completed"),
  planRecord("retired", "agents", "archived"),
];
const nextEntry = {
  namespaces: [
    { namespace: "agents", ordered: [block("heldByBacklog"), block("blocked"), block("afterWork"), block("free")], needsPrioritization: [], unrankable: [] },
    { namespace: "ingest", ordered: [block("missing")], needsPrioritization: [block("afterRetired")], unrankable: [] },
    { namespace: "strategy", ordered: [], needsPrioritization: [block("unrankedFree")], unrankable: [] },
  ],
};
const allKeys = new Set(nextRecords.map((record) => record.key));
assert.deepEqual(nextUp(nextEntry, nextRecords, allKeys).map((record) => record.plan.id), ["afterWork"]);
assert.deepEqual(nextUp(nextEntry, nextRecords, new Set(["k-free"])).map((record) => record.plan.id), ["free"], "filters narrow the candidates");
assert.deepEqual(nextUp(nextEntry, nextRecords, new Set(["k-unrankedFree"])), [], "an unranked plan is never next");

console.log("backlog model: directory, URL level, draft moves, prerequisites, and Next up ok");
