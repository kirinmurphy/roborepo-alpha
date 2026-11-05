#!/usr/bin/env node
// The Backlog view model the browser runs: directory counts, the URL level, and draft moves.
import assert from "node:assert/strict";
import {
  isUnblocked,
  NO_NAMESPACE,
  createDraft,
  dependencyTree,
  dependentsOf,
  dropBlock,
  repositoryOptions,
  returnBlock,
  unprioritizedIds,
  hrefWithNamespace,
  isActionEnabled,
  isDraftDirty,
  moveBlock,
  namespaceDirectory,
  namespaceFromSearch,
  namespaceOptions,
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
// A waits on nothing, B and C wait on A, X has a blocker, N and the misfiled plan are free.
const directoryRecord = (key, id, dependencies = [], blockers = []) => ({
  key,
  repository: { id: "r1", repositoryId: "r1" },
  plan: { id, lifecycle: "backlog", title: id, dependencies, blockers },
});
const directoryRecords = [
  directoryRecord("k-A", "A"),
  directoryRecord("k-B", "B", ["A"]),
  directoryRecord("k-C", "C", ["A"]),
  directoryRecord("k-X", "X", [], [{ text: "waiting" }]),
  directoryRecord("k-N", "N"),
  directoryRecord("bad", "bad"),
];
assert.deepEqual(repositoryDirectory([entry, empty], all, directoryRecords), [
  { repositoryId: "r1", name: "one", urlKey: "one", planCount: 6, readyCount: 1, unprioritizedCount: 1 },
], "only repos with Backlog plans, counting plans, ready plans, and unprioritized plans");
assert.deepEqual(repositoryDirectory([entry], new Set(["k-A"]), directoryRecords).map((row) => row.planCount), [1], "filters narrow the counts");
assert.deepEqual(repositoryDirectory([entry], new Set(["k-B", "k-N"]), directoryRecords).map((row) => row.readyCount), [0], "a waiting plan and an unranked free one are not ready");
assert.deepEqual(repositoryDirectory([entry], new Set(["k-A", "k-N"]), directoryRecords).map((row) => row.readyCount), [1], "filters narrow the ready count");
assert.deepEqual(repositoryDirectory([entry], new Set(), directoryRecords), [], "a repo with no matching plan drops out");
assert.deepEqual(namespaceDirectory(entry, all, directoryRecords), [
  { namespace: "portal", pinned: false, planCount: 5, readyCount: 1, unprioritizedCount: 1 },
  { namespace: NO_NAMESPACE, planCount: 1, readyCount: 0, unprioritizedCount: 0 },
], "No namespace comes last");
assert.deepEqual(namespaceDirectory(entry, new Set(["k-N"]), directoryRecords).map((row) => row.namespace), ["portal"], "No namespace shows only when plans land there");

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

// Returning a block: to the top of the queue, by the control or the drop zone, whole, and undoable.
const returned = returnBlock(draft, 0);
assert.deepEqual(orderedIds(returned), ["X"]);
assert.deepEqual(returned.needs[0].ids, ["A", "B", "C"], "it leads Needs prioritization");
assert.deepEqual(moveBlock(draft, "ordered", 0, "return"), returned);
assert.deepEqual(unprioritizedIds(returned), ["A", "B", "C"], "Save names what left the order");
assert.equal(isDraftDirty(returned), true);
assert.equal(isActionEnabled("ordered", "return", 0, 1), true, "a lone last block can still return");
assert.equal(isActionEnabled("ordered", "return", 1, 2), true);
assert.deepEqual(unprioritizedIds(moveBlock(draft, "needs", 0, "place-top")), [], "a newly placed plan is not returning");

// What archiving a plan releases: unfinished plans in this repo that name it, as a dependency or a blocker.
const dependentRecord = (id, lifecycle, dependencies, repository = "r1", blockers = []) => ({ key: `k-${id}`, repository: { id: repository }, plan: { id, lifecycle, title: id, dependencies, blockers } });
const dependentPool = [
  dependentRecord("A", "backlog", []),
  dependentRecord("B", "backlog", ["A"]),
  dependentRecord("later", "active", ["B"]),
  dependentRecord("done", "completed", ["A"]),
  dependentRecord("gone", "archived", ["A"]),
  dependentRecord("elsewhere", "backlog", ["A"], "r2"),
  dependentRecord("held", "ready", [], "r1", ["A"]),
];
assert.deepEqual(dependentsOf(dependentPool[0], dependentPool).map((record) => record.plan.id), ["B", "held"]);

// The repo breadcrumb's choices: sorted, names told apart, never the All repos entry.
assert.deepEqual(repositoryOptions([{ urlKey: "b", name: "Beta" }, { urlKey: "a", name: "Alpha" }]), [["a", "Alpha"], ["b", "Beta"]]);
assert.deepEqual(repositoryOptions([{ urlKey: "x", name: "Same" }, { urlKey: "y", name: "Same" }]).map(([, label]) => label), ["Same (x)", "Same (y)"]);
assert.deepEqual(repositoryOptions(undefined), []);
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
const statusOf = (dependencies) => openPrerequisites(planRecord("self", "agents", "backlog", dependencies), records)
  .map((item) => `${item.namespace ? `${item.namespace}/` : ""}${item.label}: ${item.status}`);
assert.deepEqual(statusOf(["ranked"]), ["strategy/ranked: Backlog"], "a prerequisite still in Backlog names it too");
assert.deepEqual(statusOf(["local"]), ["agents/local: Backlog"]);
assert.deepEqual(statusOf(["working"]), ["agents/working: Active"]);
assert.deepEqual(statusOf(["done"]), []);
assert.deepEqual(statusOf(["retired"]), ["agents/retired: Archived"]);
assert.deepEqual(statusOf(["elsewhere"]), ["elsewhere: not found"], "another repo's plan with that id does not count");

// A plan waiting on Active work is blocked, and still counts for Next up because that work is underway.
const waiting = planRecord("waiting", "ingest", "backlog", ["working"]);
const held = planRecord("held", "ingest", "backlog", ["ranked"]);
const free = planRecord("free", "knowledge", "backlog");
const unblockedRecords = [...records, waiting, held, free];
const ingestView = (keys, pending = []) => ({ namespace: "ingest", ordered: keys.map((key) => ({ keys: [key] })), needsPrioritization: pending.map((key) => ({ keys: [key] })), unrankable: [] });
assert.equal(isUnblocked(waiting, unblockedRecords), false, "a prerequisite in Active blocks");
assert.equal(isUnblocked(free, unblockedRecords), true);
assert.equal(isUnblocked(planRecord("after-done", "agents", "backlog", ["done"]), unblockedRecords), true, "a completed prerequisite does not block");
assert.equal(namespaceDirectory({ namespaces: [ingestView([waiting.key])], noNamespace: [] }, new Set([waiting.key]), unblockedRecords)[0].readyCount, 0, "the lone waiting plan is not counted as ready");
assert.deepEqual(nextUp({ namespaces: [ingestView([waiting.key])] }, unblockedRecords, new Set([waiting.key])).map((record) => record.key), [waiting.key], "work underway still leaves it next");
assert.deepEqual(nextUp({ namespaces: [ingestView([held.key])] }, unblockedRecords, new Set([held.key])), [], "a prerequisite still in Backlog keeps it out of Next up");
// Directory order carries through, so the namespaces the server pins first lead both lists.
const knowledgeView = { ...ingestView([free.key]), namespace: "knowledge", pinned: true };
const pinnedEntry = { namespaces: [knowledgeView, ingestView([waiting.key])], noNamespace: [] };
const pinnedKeys = new Set([free.key, waiting.key]);
assert.deepEqual(nextUp(pinnedEntry, unblockedRecords, pinnedKeys).map((record) => record.key), [free.key, waiting.key], "a pinned namespace leads Next up");
assert.deepEqual(namespaceDirectory(pinnedEntry, pinnedKeys, unblockedRecords).map((row) => [row.namespace, row.pinned]), [["knowledge", true], ["ingest", false]], "and the namespace list");

// The dependency tree: implied prerequisites collapse, and a plan with several real ones nests under
// the last to finish and names the rest.
const treeOf = (keys, dependencies) => {
  const plans = new Map(keys.map((key) => [key, { plan: { id: key, dependencies: dependencies[key] || [] } }]));
  return dependencyTree(keys, plans).map((row) => [row.key, row.parentKey, row.alsoNeeds.join(), row.lines.join(" ")]);
};
assert.deepEqual(treeOf(["A", "B"], { B: ["A"] }), [["A", null, "", ""], ["B", "A", "", "elbow"]], "a chain nests");
assert.deepEqual(treeOf(["A"], {}), [["A", null, "", ""]], "a lone plan is a root");
assert.deepEqual(treeOf(["A", "B", "C", "D", "E"], { C: ["A", "B"], D: ["A"], E: ["A", "C"] }), [
  ["A", null, "", ""],
  ["D", "A", "", "elbow"],
  ["B", null, "", ""],
  ["C", "B", "A", "elbow"],
  ["E", "C", "", "blank elbow"],
], "E's link to A is implied through C, C keeps both prerequisites, and each subtree stays together");
assert.deepEqual(treeOf(["A", "B", "C", "D"], { B: ["A"], C: ["B"], D: ["A"] }).map((row) => row[3]), ["", "tee", "pipe elbow", "elbow"], "a guide continues past a child while a sibling is still to come");
assert.deepEqual(treeOf(["A", "B", "C"], { B: ["A"], C: ["A"] }).map((row) => row[0]), ["A", "B", "C"], "siblings keep their saved order");
assert.deepEqual(treeOf(["A", "C", "B"], { B: ["A"], C: ["A"] }).map((row) => row[0]), ["A", "C", "B"], "whichever order was saved");
assert.deepEqual(treeOf(["A", "B", "P", "C", "U", "X"], { B: ["A"], C: ["A"], P: ["B"], U: ["C"], X: ["P", "U"] }).map((row) => row[0]), ["A", "B", "P", "C", "U", "X"], "a plan waits below all its prerequisites");
assert.deepEqual(treeOf(["A", "B"], { A: ["B"], B: ["A"] }).map((row) => row[0]), ["A", "B"], "a cycle's plans stay visible");
assert.deepEqual(namespaceOptions(entry), [["portal", "PORTAL"], [NO_NAMESPACE, "No namespace"]], "the breadcrumb offers each level the directory does");

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
