#!/usr/bin/env node
// Backlog ordering: the pure grouping and order calculations over every dependency shape the UI
// contract names, then the registry's read, write, and refusal rules against real files, and the
// `roborepo plans order place` command and validation gates in a real Git repository.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { deriveGroups, findDependencyCycles, proposeOrder } from "../../modules/plan-suite/backlog-order.mjs";
import { buildBacklogIndex, placePlan, readOrderRegistry, saveNamespaceOrder, setNamespacePinned } from "../../modules/plan-suite/backlog-registry.mjs";
import { buildRepositoryPlanSnapshot } from "../../modules/plan-suite/index.mjs";
import { readProjectNamespaces, resolvePlanNamespace, validatePlanNaming } from "../../modules/plan-suite/naming.mjs";
import { repositoryBaseBranch } from "../../modules/plan-suite/plan-git.mjs";
import { locateStore } from "../../modules/plan-suite/plan-store.mjs";
import { createPlanFixture } from "./lib/plan-git-fixture.mjs";

const NS = "agents";

// A plan shaped as the calculations read it. deps are its depends_on ids.
function plan(id, deps = [], overrides = {}) {
  return { id, namespace: NS, lifecycle: "backlog", dependencies: deps, relativePath: `plans/backlog/agents-${id}.md`, title: `Plan ${id}`, ...overrides };
}
function groupsOf(plans) {
  return deriveGroups(plans).groups.map((group) => group.ids);
}
function orderOf(saved, plans, change = null) {
  return proposeOrder(saved, deriveGroups(plans).groups, change).order;
}

// ---- The three-plan gallery, T0 to T5, and the larger shapes ----
{
  assert.deepEqual(groupsOf([plan("A"), plan("B"), plan("C")]), [["A"], ["B"], ["C"]], "T0: no edges, no groups");
  assert.deepEqual(groupsOf([plan("A"), plan("B", ["A"]), plan("C")]), [["A", "B"], ["C"]], "T1: one edge leaves C out");
  assert.deepEqual(groupsOf([plan("A"), plan("B", ["A"]), plan("C", ["B"])]), [["A", "B", "C"]], "T2: chain");
  assert.deepEqual(groupsOf([plan("A"), plan("B", ["A"]), plan("C", ["A"])]), [["A", "B", "C"]], "T3: fork");
  assert.deepEqual(groupsOf([plan("A"), plan("B"), plan("C", ["A", "B"])]), [["A", "B", "C"]], "T4: join");
  assert.deepEqual(groupsOf([plan("A"), plan("B", ["A"]), plan("C", ["A", "B"])]), [["A", "B", "C"]], "T5: triangle");

  const diamond = [plan("A"), plan("B", ["A"]), plan("C", ["A"]), plan("D", ["B", "C"])];
  assert.deepEqual(orderOf(["A", "C", "B", "D"], diamond), ["A", "C", "B", "D"], "G1: independent siblings keep their saved order");
  const branch = [plan("A"), plan("B", ["A"]), plan("C", ["B"]), plan("D", ["B"])];
  assert.deepEqual(orderOf(["A", "B", "C", "D"], branch), ["A", "B", "C", "D"], "G2: branch in the middle");
  assert.deepEqual(groupsOf([plan("A"), plan("B", ["A"]), plan("C"), plan("D", ["C"])]), [["A", "B"], ["C", "D"]], "G3: disconnected chains stay separate");
  const many = [plan("A"), plan("B"), plan("D", ["A", "B"]), plan("E", ["D"]), plan("F", ["D"]), plan("G", ["E", "F"])];
  assert.deepEqual(orderOf(["G"], many), ["A", "B", "D", "E", "F", "G"], "G5: a many-to-many graph sorts topologically");
  assert.equal(groupsOf(many).length, 1, "G5: one group");
}

// ---- Leaving Backlog: L1, L2, and the linear remainder ----
{
  const left = { lifecycle: "active" };
  const fork = [plan("A", [], left), plan("B", ["A"]), plan("C", ["A"])];
  assert.deepEqual(groupsOf(fork), [["B"], ["C"]], "L1: an out-of-Backlog prerequisite joins nothing");
  assert.deepEqual(orderOf(["A", "C", "B"], fork), ["C", "B"], "L1: survivors keep their relative rank");
  const triangle = [plan("A", [], left), plan("B", ["A"]), plan("C", ["A", "B"])];
  assert.deepEqual(groupsOf(triangle), [["B", "C"]], "L2: a direct edge keeps the group");
  const chain = [plan("A", [], left), plan("B", ["A"]), plan("C", ["B"])];
  assert.deepEqual(groupsOf(chain), [["B", "C"]], "the linear remainder stays together");
  assert.deepEqual(groupsOf([plan("B", ["A"]), plan("A", [], { lifecycle: "completed" }), plan("C", ["B"], {})]), [["B", "C"]]);
  assert.deepEqual(deriveGroups(fork).missing, [], "a prerequisite outside Backlog is not missing");
}

// ---- A self-reference: invalid, with its own finding, but no reason to lock the namespace ----
{
  const derived = deriveGroups([plan("A", ["A"]), plan("B", ["A"])]);
  assert.deepEqual(derived.groups.map((group) => group.ids), [["A", "B"]], "the self-edge adds nothing to the group");
  assert.deepEqual(derived.groups[0].edges, [["A", "B"]]);
  assert.deepEqual(derived.cycles, [], "a self-reference is not reported as a cycle");
  assert.deepEqual(derived.missing, [], "and is not reported as missing");
  assert.deepEqual(orderOf(["A", "B"], [plan("A", ["A"]), plan("B", ["A"])]), ["A", "B"], "so its namespace stays orderable");
}

// ---- L3: a cross-namespace edge never merges orders ----
{
  const plans = [plan("Q", [], { namespace: "other" }), plan("B", ["Q"]), plan("X")];
  assert.deepEqual(groupsOf(plans), [["Q"], ["B"], ["X"]]);
  assert.deepEqual(deriveGroups(plans).missing, []);
}

// ---- P and M: placement and automatic merges ----
{
  assert.deepEqual(orderOf(["A", "B"], [plan("A"), plan("B", ["A"]), plan("N")]), ["A", "B"], "P1: an independent plan stays unranked");
  assert.deepEqual(orderOf(["A", "B"], [plan("A"), plan("B", ["A"]), plan("C", ["B"])]), ["A", "B", "C"], "P2: a new dependent attaches");
  assert.deepEqual(orderOf([], [plan("A"), plan("C", ["A"])]), [], "a dependent of an unranked plan stays unranked with it");
  const m1 = [plan("A"), plan("X"), plan("Y"), plan("B"), plan("C", ["A", "B"])];
  const proposal = proposeOrder(["A", "X", "Y", "B"], deriveGroups(m1).groups);
  assert.deepEqual(proposal.order, ["A", "B", "C", "X", "Y"], "M1: merges at the earliest ranked member");
  assert.deepEqual(proposal.moves.map(({ id, kind }) => [id, kind]), [["B", "moved"], ["C", "attached"]], "only what actually moved is reported");
  assert.deepEqual(orderOf(["B", "A"], [plan("A"), plan("B"), plan("C", ["A", "B"])]), ["B", "A", "C"], "independent prerequisites keep their saved order");
  assert.deepEqual(orderOf(["X", "B"], [plan("X"), plan("P"), plan("B", ["P"])]), ["X", "P", "B"], "a ranked plan keeps its rank and pulls in its unranked prerequisite");
  assert.deepEqual(orderOf(["A", "B", "X"], [plan("A"), plan("B"), plan("X")]), ["A", "B", "X"], "M2: a removed dependency keeps the rank");
  assert.deepEqual(orderOf(["A", "B", "C"], [plan("A"), plan("B", ["A"]), plan("C", ["A"]), plan("D", ["A"])]), ["A", "B", "C", "D"], "a new sibling is placed deterministically after ranked ones");
  assert.deepEqual(orderOf(["A", "B", "ghost"], [plan("A"), plan("B")]), ["A", "B"], "an unknown id is excluded");
}

// ---- E1, E2: invalid graphs ----
{
  const cycle = [plan("A", ["B"]), plan("B", ["A"]), plan("C", ["A"])];
  assert.deepEqual(findDependencyCycles(cycle), [["A", "B", "A"]]);
  const derived = deriveGroups(cycle);
  assert.deepEqual(derived.cycles, [["A", "B", "A"]]);
  assert.equal(derived.groups[0].cyclic, true);
  assert.deepEqual(proposeOrder(["A"], derived.groups).order, ["A"], "E1: a cycle never pulls unranked plans into a rank");
  assert.deepEqual(findDependencyCycles([plan("S", ["S"])]), [], "a self-reference has its own finding");
  assert.deepEqual(deriveGroups([plan("B", ["Z"]), plan("X")]).missing, [{ id: "B", dependency: "Z", namespace: NS }], "E2: a missing prerequisite is reported");
}

// ---- Changes: placement, and refusals of orders that break the rules ----
{
  const plans = [plan("A"), plan("B", ["A"]), plan("X"), plan("N")];
  const { groups } = deriveGroups(plans);
  assert.deepEqual(proposeOrder(["X"], groups, { type: "place", id: "N", position: "top" }).order, ["N", "X"]);
  assert.deepEqual(proposeOrder(["X"], groups, { type: "place", id: "B", position: "bottom" }).order, ["X", "A", "B"], "placing one member moves its whole group");
  const codes = (order) => proposeOrder(["A", "B", "X"], groups, { type: "replace", order }).findings.map((item) => item.code);
  assert.deepEqual(codes(["X", "A", "B"]), [], "a whole-group move is valid");
  assert.deepEqual(codes(["A", "N", "B", "X"]), ["ORDER_SPLITS_DEPENDENCIES"], "a split group is refused");
  assert.deepEqual(codes(["B", "A", "X"]), ["ORDER_SPLITS_DEPENDENCIES"], "an inverted prerequisite is refused");
  assert.deepEqual(codes(["A", "B"]), ["ORDER_DROPS_PLANS"], "a ranked plan cannot silently become unranked");
  const returning = (order, unprioritized) => proposeOrder(["A", "B", "X"], groups, { type: "replace", order, unprioritized });
  assert.deepEqual(returning(["A", "B"], ["X"]).findings, [], "a named plan may return to unprioritized");
  assert.deepEqual(returning(["X"], ["A", "B"]).order, ["X"], "a whole group may return");
  assert.deepEqual(returning(["A", "X"], ["B"]).findings.map((item) => item.code), ["ORDER_SPLITS_DEPENDENCIES"], "part of a group cannot return alone");
  assert.deepEqual(returning(["A", "B"], ["N"]).findings.map((item) => item.code), ["ORDER_DROPS_PLANS"], "naming another plan does not excuse dropping this one");
  assert.deepEqual(codes(["A", "B", "X", "ghost"]), ["ORDER_UNKNOWN_PLANS"]);
  assert.deepEqual(codes(["A", "B", "X", "X"]), ["ORDER_REPEATS_PLANS"]);
}

// ---- Unrankable plans ----
{
  const derived = deriveGroups([plan(""), plan("D"), plan("D", [], { relativePath: "other.md" }), plan("OK"), plan("Z", [], { namespace: null })]);
  assert.deepEqual(derived.groups.map((group) => group.ids), [["OK"]], "no id, a duplicate id, and no namespace cannot be ranked");
  assert.equal(derived.unrankable.length, 3, "a plan with no namespace is No namespace's, not unrankable");
}

// ---- Namespace resolution: longest prefix, and cost ----
{
  const declared = ["plan", "plan-lifecycle", "usage-statusline"];
  assert.equal(resolvePlanNamespace("plan-lifecycle-foo.md", declared), "plan-lifecycle");
  assert.equal(resolvePlanNamespace("plan-foo.md", declared), "plan");
  assert.equal(resolvePlanNamespace("usage-statusline-x.md", declared), "usage-statusline");
  assert.equal(resolvePlanNamespace("cli-foo.md", declared), "cli", "universal namespaces apply once a repo has declared any");
  assert.equal(resolvePlanNamespace("cli-foo.md", []), null, "a repo with no vocabulary has no namespaces");
  assert.equal(resolvePlanNamespace("performance-budget.md", declared.concat("perf")), null, "a prefix must end at a hyphen");
  assert.equal(resolvePlanNamespace("Bad_Name.md", declared), null);
  assert.equal(resolvePlanNamespace("unknown-foo.md", declared), null);
  const start = performance.now();
  for (let index = 0; index < 5000; index += 1) resolvePlanNamespace(`plan-lifecycle-${index}-slug.md`, declared);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 250, `5000 resolutions took ${elapsed.toFixed(1)}ms`);
}

// ---- Files: a real repository with a plans store ----
const fx = createPlanFixture("backlog-order-");
const root = fx.tmp;
const run = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const roborepo = (cwd, ...args) => fx.roborepo(["plans", ...args], { cwd });
function document({ id, deps = [], title = id }) {
  return `---\nid: ${id}\nnext_action: Do it\ndepends_on: [${deps.join(", ")}]\n---\n\n# ${title}\n\n## Summary\n\nx\n\n## Goals\n\nx\n\n## Context\n\nx\n\n## Proposed design\n\nx\n\n## Validation\n\nx\n`;
}
// Plans are written only through commits to the plans branch, so a file edited here is committed at once.
function planStore(checkout) {
  const storeRoot = fx.storePath(checkout);
  const commit = (message) => {
    fx.git(storeRoot, "add", "-A", "--", "plans");
    if (fx.tryGit(storeRoot, "diff", "--cached", "--quiet").status !== 0) fx.git(storeRoot, "commit", "--quiet", "-m", message);
  };
  return {
    root: storeRoot,
    store: locateStore(storeRoot),
    commit,
    write: (relative, content) => {
      fs.mkdirSync(path.dirname(path.join(storeRoot, relative)), { recursive: true });
      fs.writeFileSync(path.join(storeRoot, relative), content);
      commit(`Write ${relative}`);
    },
    remove: (relative) => {
      fs.rmSync(path.join(storeRoot, relative));
      commit(`Remove ${relative}`);
    },
    records: () => buildRepositoryPlanSnapshot({ cwd: storeRoot }).plans,
    index: () => buildBacklogIndex(storeRoot, buildRepositoryPlanSnapshot({ cwd: storeRoot }).plans),
  };
}
const viewOf = (index, namespace) => index.namespaces.find((view) => view.namespace === namespace);
try {
  const repo = fx.repository("repo", {
    "plans/plans-config.json": JSON.stringify({ schemaVersion: 1, namespaces: { agents: "x", other: "y" } }),
    "plans/backlog/agents-a.md": document({ id: "aaaaaa11" }),
    "plans/backlog/agents-b.md": document({ id: "bbbbbb22", deps: ["aaaaaa11"] }),
    "plans/backlog/agents-x.md": document({ id: "xxxxxx33" }),
    "plans/backlog/other-q.md": document({ id: "qqqqqq44" }),
    "plans/backlog/nosuch-z.md": document({ id: "zzzzzz55" }),
    "plans/active/agents-gone.md": document({ id: "gggggg66" }),
  });
  const main = planStore(repo);
  const { store, write } = main;
  const realRepo = main.root;
  const config = (namespaces) => write("plans/plans-config.json", JSON.stringify({ schemaVersion: 1, namespaces }));
  const orderFile = path.join(main.root, "plans/plans-order.json");
  // `plans init` scaffolds an empty registry; the missing-file state is still readable, so start there.
  main.remove("plans/plans-order.json");
  const indexed = async () => main.index();
  const records = async () => main.records();

  // Missing file: everything is unprioritized, and a read writes nothing.
  let index = await indexed();
  assert.equal(index.registry.state, "missing");
  assert.equal(index.config.state, "declared");
  assert.deepEqual(index.namespaces.map((view) => view.namespace), ["agents", "other"]);
  assert.equal(index.noNamespace.length, 1, "an unapproved prefix lands in No namespace");
  assert.deepEqual(viewOf(index, "agents").ordered, []);
  assert.deepEqual(viewOf(index, "agents").needsPrioritization.map((block) => block.ids), [["aaaaaa11", "bbbbbb22"], ["xxxxxx33"]]);
  assert.equal(fs.existsSync(orderFile), false, "reading never creates the registry");

  // Save: atomic, whole-namespace, and refused when stale.
  const revision = viewOf(index, "agents").revision;
  const saved = await saveNamespaceOrder({ store, namespace: "agents", order: ["xxxxxx33", "aaaaaa11", "bbbbbb22"], revision });
  assert.deepEqual(saved.order, ["xxxxxx33", "aaaaaa11", "bbbbbb22"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(orderFile, "utf8")), { schemaVersion: 1, namespaces: { agents: ["xxxxxx33", "aaaaaa11", "bbbbbb22"] } });
  assert.deepEqual(fs.readdirSync(path.dirname(orderFile)).filter((name) => name.includes("tmp")), [], "no temp file is left behind");
  await assert.rejects(async () => saveNamespaceOrder({ store, namespace: "agents", order: [], revision }), { code: "STALE_ORDER" }, "an old revision is refused");
  index = await indexed();
  assert.deepEqual(viewOf(index, "agents").ordered.map((block) => block.ids), [["xxxxxx33"], ["aaaaaa11", "bbbbbb22"]]);
  assert.deepEqual(viewOf(index, "agents").needsPrioritization, []);

  // Returning a plan takes it out of the file and back to Needs prioritization, and only when named.
  const beforeReturn = viewOf(index, "agents").revision;
  const beforeReturnRecords = await records();
  await assert.rejects(async () => saveNamespaceOrder({ store, namespace: "agents", order: ["aaaaaa11", "bbbbbb22"], revision: beforeReturn }), { code: "INVALID_CHANGE" }, "an unnamed omission is still refused");
  await assert.rejects(async () => saveNamespaceOrder({ store, namespace: "agents", order: ["aaaaaa11", "bbbbbb22"], unprioritized: "xxxxxx33", revision: beforeReturn }), { code: "INVALID_CHANGE" });
  await saveNamespaceOrder({ store, namespace: "agents", order: ["aaaaaa11", "bbbbbb22"], unprioritized: ["xxxxxx33"], revision: beforeReturn });
  assert.deepEqual(JSON.parse(fs.readFileSync(orderFile, "utf8")).namespaces.agents, ["aaaaaa11", "bbbbbb22"]);
  index = await indexed();
  assert.deepEqual(viewOf(index, "agents").needsPrioritization.map((block) => block.ids), [["xxxxxx33"]]);
  await saveNamespaceOrder({ store, namespace: "agents", order: ["xxxxxx33", "aaaaaa11", "bbbbbb22"], revision: viewOf(index, "agents").revision });
  index = await indexed();

  // A dependency edit changes the revision, regroups on read, and writes nothing.
  const before = fs.readFileSync(orderFile, "utf8");
  write("plans/backlog/agents-x.md", document({ id: "xxxxxx33", deps: ["bbbbbb22"] }));
  index = await indexed();
  assert.deepEqual(viewOf(index, "agents").ordered.map((block) => block.ids), [["aaaaaa11", "bbbbbb22", "xxxxxx33"]], "the new edge regroups the effective order");
  assert.deepEqual(viewOf(index, "agents").moves.map((move) => move.kind), ["moved"], "and the move is visible");
  assert.notEqual(viewOf(index, "agents").revision, revision);
  assert.equal(fs.readFileSync(orderFile, "utf8"), before, "read purity: the registry is untouched");
  write("plans/backlog/agents-x.md", document({ id: "xxxxxx33" }));

  // A plan outside Backlog is pruned at the next write; an unknown id and another namespace stay.
  write("plans/plans-order.json", JSON.stringify({ schemaVersion: 1, namespaces: {
    agents: ["gggggg66", "ghost123", "xxxxxx33", "aaaaaa11", "bbbbbb22", "zzzzzz55"],
    removed: ["kept1234"],
  } }));
  index = await indexed();
  assert.deepEqual(index.findings.map((item) => item.code).sort(), ["ORDER_UNAPPROVED_NAMESPACE", "ORDER_UNKNOWN_PLAN"], "unknown ids and unapproved namespaces are findings; a plan outside Backlog is not");
  assert.deepEqual(viewOf(index, "agents").moves, [], "an ignored id is not a move");
  await saveNamespaceOrder({ store, namespace: "agents", order: ["aaaaaa11", "bbbbbb22", "xxxxxx33"], revision: viewOf(index, "agents").revision });
  assert.deepEqual(JSON.parse(fs.readFileSync(orderFile, "utf8")).namespaces, {
    agents: ["aaaaaa11", "bbbbbb22", "xxxxxx33", "ghost123", "zzzzzz55"],
    removed: ["kept1234"],
  }, "pruned the active plan; preserved the unknown id, the unnamespaced plan, and the other namespace");

  // Pins lift a namespace above alphabetical order, first pinned first, and leave every order alone.
  const orderBeforePins = JSON.parse(fs.readFileSync(orderFile, "utf8")).namespaces;
  await setNamespacePinned({ store, namespace: "other", pinned: true });
  index = await indexed();
  assert.deepEqual(index.namespaces.map((view) => [view.namespace, view.pinned]), [["other", true], ["agents", false]], "a pinned namespace comes first");
  await setNamespacePinned({ store, namespace: "agents", pinned: true });
  await setNamespacePinned({ store, namespace: "agents", pinned: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(orderFile, "utf8")).pinned, ["other", "agents"], "pinning twice records it once, in pin order");
  assert.deepEqual((await indexed()).namespaces.map((view) => view.namespace), ["other", "agents"], "pin order beats alphabetical");
  assert.deepEqual(JSON.parse(fs.readFileSync(orderFile, "utf8")).namespaces, orderBeforePins, "pinning changes no plan's order");
  await assert.rejects(async () => setNamespacePinned({ store, namespace: "nonsense", pinned: true }), /not an approved namespace/);
  // A Save keeps the pins.
  index = await indexed();
  await saveNamespaceOrder({ store, namespace: "agents", order: ["aaaaaa11", "bbbbbb22", "xxxxxx33"], revision: viewOf(index, "agents").revision });
  assert.deepEqual(JSON.parse(fs.readFileSync(orderFile, "utf8")).pinned, ["other", "agents"], "a Save preserves pins");
  // A pin on a namespace removed from the config is ignored on read and pruned at the next write.
  const pinnedFile = JSON.parse(fs.readFileSync(orderFile, "utf8"));
  write("plans/plans-order.json", JSON.stringify({ ...pinnedFile, pinned: ["gone", "agents"] }));
  const pinsRaw = fs.readFileSync(orderFile, "utf8");
  index = await indexed();
  assert.deepEqual(index.namespaces.map((view) => [view.namespace, view.pinned]), [["agents", true], ["other", false]], "a removed namespace's pin has no effect");
  assert.equal(fs.readFileSync(orderFile, "utf8"), pinsRaw, "reading does not prune");
  assert.equal(index.findings.some((item) => /gone/.test(item.message || "")), false, "a stale pin is not a finding");
  await saveNamespaceOrder({ store, namespace: "agents", order: ["aaaaaa11", "bbbbbb22", "xxxxxx33"], revision: viewOf(index, "agents").revision });
  assert.deepEqual(JSON.parse(fs.readFileSync(orderFile, "utf8")).pinned, ["agents"], "the next Save prunes it");
  await setNamespacePinned({ store, namespace: "agents", pinned: false });
  assert.equal("pinned" in JSON.parse(fs.readFileSync(orderFile, "utf8")), false, "with no pins the key is left out");
  write("plans/plans-order.json", JSON.stringify({ schemaVersion: 1, pinned: "agents", namespaces: {} }));
  assert.equal(readOrderRegistry(realRepo).state, "invalid", "a malformed pin list is an invalid registry");
  await assert.rejects(async () => setNamespacePinned({ store, namespace: "agents", pinned: true }), /was not overwritten/);
  write("plans/plans-order.json", `${JSON.stringify({ schemaVersion: 1, namespaces: orderBeforePins }, null, 2)}\n`);

  // An invalid order is refused and writes nothing.
  index = await indexed();
  await assert.rejects(async () => saveNamespaceOrder({ store, namespace: "other", order: [], revision: "x" }), { code: "STALE_ORDER" });
  const held = fs.readFileSync(orderFile, "utf8");
  const current = await records();
  await assert.rejects(async () => saveNamespaceOrder({ store, namespace: "agents", order: ["bbbbbb22", "aaaaaa11", "xxxxxx33"], revision: viewOf(index, "agents").revision }), /prerequisite/);
  assert.equal(fs.readFileSync(orderFile, "utf8"), held);

  // An unparseable registry reads as unprioritized and refuses every write.
  write("plans/plans-order.json", "{ not json");
  index = await indexed();
  assert.equal(index.registry.state, "invalid");
  assert.deepEqual(viewOf(index, "agents").ordered, []);
  assert.equal(viewOf(index, "agents").writable, false);
  assert.ok(index.findings.some((item) => item.code === "INVALID_ORDER_REGISTRY"));
  await assert.rejects(async () => saveNamespaceOrder({ store, namespace: "agents", order: [], revision: viewOf(index, "agents").revision }), /was not overwritten/);
  assert.equal(fs.readFileSync(orderFile, "utf8"), "{ not json", "the file a person can repair is left alone");
  write("plans/plans-order.json", JSON.stringify({ schemaVersion: 2, namespaces: {} }));
  assert.equal(readOrderRegistry(realRepo).state, "invalid", "an unknown schema is not guessed at");
  main.remove("plans/plans-order.json");

  // The command: unprioritized by default, explicit placement, automatic attachment.
  const place = (...args) => {
    const result = roborepo(repo, "order", "place", ...args, "--json");
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.equal(place("xxxxxx33").placed, "unprioritized", "an independent plan stays unprioritized");
  assert.equal(fs.existsSync(orderFile), false, "and nothing is written");
  assert.deepEqual(place("xxxxxx33", "--bottom").order, ["xxxxxx33"]);
  const placedTop = place("aaaaaa11", "--top");
  assert.deepEqual(placedTop.order, ["aaaaaa11", "bbbbbb22", "xxxxxx33"], "placing a plan brings its group");
  assert.deepEqual(placedTop.moves, [], "a move the caller asked for is not reported as automatic");
  const text = roborepo(repo, "order", "place", "aaaaaa11");
  assert.match(text.stdout, /namespace agents: already ranked\n/);
  assert.doesNotMatch(text.stdout, /automatic/);
  write("plans/backlog/agents-c.md", document({ id: "cccccc77", deps: ["bbbbbb22"] }));
  const attached = place("cccccc77", "--bottom");
  assert.equal(attached.placed, "attached");
  assert.equal(attached.ignoredPosition, "bottom", "a dependent stays with its group whatever the flag says");
  assert.deepEqual(JSON.parse(fs.readFileSync(orderFile, "utf8")).namespaces.agents, ["aaaaaa11", "bbbbbb22", "cccccc77", "xxxxxx33"]);
  main.remove("plans/backlog/agents-c.md");
  const refused = roborepo(repo, "order", "place", "zzzzzz55", "--top");
  assert.equal(refused.status, 1, "a plan with no namespace cannot be ordered");
  assert.match(refused.stderr, /no approved namespace/);
  assert.equal(roborepo(repo, "order", "place", "aaaaaa11", "--top", "--bottom").status, 2);
  const beforeTransition = fs.readFileSync(orderFile, "utf8");

  // A broken graph: the finding blocks validation, and every write to that namespace is refused.
  const unbroken = fs.readFileSync(orderFile, "utf8");
  write("plans/backlog/agents-cycle-one.md", document({ id: "cycle111", deps: ["cycle222"] }));
  write("plans/backlog/agents-cycle-two.md", document({ id: "cycle222", deps: ["cycle111"] }));
  const cycleReport = roborepo(repo, "validate", "cycle111", "--json");
  assert.equal(cycleReport.status, 1, "a dependency cycle fails validation");
  const cycleFinding = JSON.parse(cycleReport.stdout).plans[0].findings.find((item) => item.code === "DEPENDENCY_CYCLE");
  assert.equal(cycleFinding.severity, "blocking");
  assert.deepEqual(cycleFinding.meta.cycle, ["cycle111", "cycle222", "cycle111"]);
  const assertLocked = async (label) => {
    const refusedPlace = roborepo(repo, "order", "place", "xxxxxx33", "--top");
    assert.equal(refusedPlace.status, 1, `${label}: order place is refused`);
    assert.match(refusedPlace.stderr, /needs repair before/);
    const lockedIndex = await indexed();
    assert.equal(viewOf(lockedIndex, "agents").locked, true);
    const lockedRecords = await records();
    await assert.rejects(async () => saveNamespaceOrder({ store, namespace: "agents", order: [], revision: viewOf(lockedIndex, "agents").revision }), /needs repair before/, `${label}: Save is refused`);
    assert.equal(fs.readFileSync(orderFile, "utf8"), unbroken, `${label}: nothing is written`);
  };
  await assertLocked("a cycle");
  main.remove("plans/backlog/agents-cycle-one.md");
  main.remove("plans/backlog/agents-cycle-two.md");
  write("plans/backlog/agents-missing.md", document({ id: "miss1111", deps: ["nosuchid"] }));
  await assertLocked("a missing prerequisite");
  main.remove("plans/backlog/agents-missing.md");

  // A place recorded from a linked worktree is stored in the plans worktree, never in the worktree
  // it was run from.
  const linked = path.join(root, "linked");
  run(repo, "worktree", "add", "-q", "-b", "feat/linked", linked);
  const fromWorktree = roborepo(linked, "order", "place", "xxxxxx33", "--bottom", "--json");
  assert.equal(fromWorktree.status, 0, fromWorktree.stdout + fromWorktree.stderr);
  assert.ok(JSON.parse(fs.readFileSync(orderFile, "utf8")).namespaces.agents.includes("xxxxxx33"), "written to the plans worktree");
  assert.equal(fs.existsSync(path.join(linked, "plans/plans-order.json")), false, "not to the worktree");
  run(repo, "worktree", "remove", "--force", linked);
  write("plans/plans-order.json", beforeTransition);

  // Naming gates: validate exits 1, promote refuses, and the file stays visible.
  const validated = roborepo(repo, "validate", "--json");
  assert.equal(validated.status, 1);
  const report = JSON.parse(validated.stdout);
  assert.ok(report.plans.find((item) => item.id === "zzzzzz55").findings.some((item) => item.code === "UNKNOWN_PLAN_NAMESPACE"));
  const promote = roborepo(repo, "promote", "zzzzzz55", "--json");
  assert.equal(promote.status, 1);
  assert.ok(JSON.parse(promote.stdout).error.findings.some((item) => item.code === "UNKNOWN_PLAN_NAMESPACE"), "promote refuses a bad prefix");

  // Start applies the same gate, to a plan that reached Ready with a bad name.
  write("plans/ready/nosuch-ready.md", document({ id: "yyyyyy99" }));
  const gateTree = path.join(root, "gate-tree");
  run(repo, "worktree", "add", "-q", "-b", "feat/gate", gateTree);
  const started = roborepo(repo, "start", "yyyyyy99", "--worktree", "gate-tree", "--json");
  assert.equal(started.status, 1);
  assert.ok(JSON.parse(started.stdout).error.findings.some((item) => item.code === "UNKNOWN_PLAN_NAMESPACE"), "start refuses a bad prefix");

  // A transition commits only the plan's paths and leaves the registry for the next write.
  write("plans/backlog/agents-a.md", document({ id: "aaaaaa11" }));
  const promoted = roborepo(repo, "promote", "aaaaaa11", "--json");
  assert.equal(promoted.status, 0, promoted.stdout + promoted.stderr);
  assert.deepEqual(run(main.root, "show", "--no-renames", "--name-only", "--format=", "HEAD").trim().split("\n").sort(), ["plans/backlog/agents-a.md", "plans/ready/agents-a.md"]);
  assert.equal(fs.readFileSync(orderFile, "utf8"), beforeTransition, "lifecycle commits never touch the registry");
  index = await indexed();
  assert.deepEqual(viewOf(index, "agents").ordered.map((block) => block.ids), [["bbbbbb22"], ["xxxxxx33"]], "a group splits without losing its rank");

  // Namespace removed, then a malformed config: tolerant reads, strict gates.
  config({ other: "y" });
  index = await indexed();
  assert.equal(index.namespaces.some((view) => view.namespace === "agents"), false);
  assert.equal(index.noNamespace.length, 3, "plans of a removed namespace move to No namespace");
  assert.ok(index.findings.some((item) => item.code === "ORDER_UNAPPROVED_NAMESPACE"));
  assert.deepEqual(JSON.parse(fs.readFileSync(orderFile, "utf8")).namespaces.agents.length, 4, "their order is preserved");
  config({ agents: "x", other: "y" });

  write("plans/plans-config.json", "{ nope");
  assert.ok(readProjectNamespaces(realRepo).error, "malformed config is an error, not 'not configured'");
  index = await indexed();
  assert.equal(index.config.state, "invalid");
  assert.equal(index.namespaces.length, 0, "no namespace is invented");
  assert.equal(index.noNamespace.length, 4, "and no plan disappears");
  assert.ok(index.findings.some((item) => item.code === "INVALID_PLANS_CONFIG"));
  const invalidConfigValidate = roborepo(repo, "validate", "--json");
  assert.ok(JSON.parse(invalidConfigValidate.stdout).repositoryFindings.some((item) => item.code === "INVALID_PLANS_CONFIG"));
  const gated = roborepo(repo, "promote", "xxxxxx33", "--json");
  assert.equal(gated.status, 1, "promote refuses while the config cannot be read");
  const gatedStart = roborepo(repo, "start", "aaaaaa11", "--worktree", "gate-tree", "--json");
  assert.equal(gatedStart.status, 1, "start refuses while the config cannot be read");
  assert.ok(JSON.parse(gatedStart.stdout).error.findings.some((item) => item.code === "INVALID_PLANS_CONFIG"));

  // A read failure reaches /api/plans, so it carries its code and never the file's absolute path.
  const configFile = path.join(main.root, "plans/plans-config.json");
  fs.rmSync(configFile);
  fs.mkdirSync(configFile);
  assert.equal(readProjectNamespaces(realRepo).error, "EISDIR");
  fs.rmdirSync(configFile);
  write("plans/plans-config.json", "{ nope");
  const orderBeforeLoop = fs.readFileSync(orderFile, "utf8");
  fs.rmSync(orderFile);
  fs.symlinkSync(orderFile, orderFile);
  assert.deepEqual(readOrderRegistry(realRepo), { state: "invalid", namespaces: {}, pinned: [], raw: "", error: "ELOOP" });
  fs.rmSync(orderFile);
  write("plans/plans-order.json", orderBeforeLoop);

  // No config at all: the convention is inert.
  main.remove("plans/plans-config.json");
  index = await indexed();
  assert.equal(index.config.state, "none");
  assert.equal(index.namespaces.length, 0);
  assert.deepEqual(validatePlanNaming({ filename: "whatever.md", lifecycle: "backlog", projectNamespaces: [] }), [], "no config, no per-file findings");

  // Switching the code checkout between branches changes nothing a read sees: the vocabulary and the
  // order come from the plans worktree, and the registry stays as it was.
  const switching = fx.repository("switching", {
    "plans/plans-config.json": JSON.stringify({ schemaVersion: 1, namespaces: { agents: "x", other: "y" } }),
    "plans/backlog/agents-a.md": document({ id: "aaaaaa11" }),
    "plans/backlog/other-q.md": document({ id: "qqqqqq44" }),
    "plans/plans-order.json": JSON.stringify({ schemaVersion: 1, namespaces: { other: ["qqqqqq44"] } }),
  });
  const switchingStore = planStore(switching);
  const registryJson = fs.readFileSync(path.join(switchingStore.root, "plans/plans-order.json"), "utf8");
  run(switching, "branch", "wider");
  const indexAfterSwitch = (branch) => {
    run(switching, "switch", "-q", branch);
    return buildBacklogIndex(switchingStore.root, buildRepositoryPlanSnapshot({ cwd: switching }).plans);
  };
  for (let round = 0; round < 5; round += 1) {
    for (const branch of ["main", "wider"]) {
      const view = indexAfterSwitch(branch);
      assert.deepEqual(view.namespaces.map((entry) => entry.namespace), ["agents", "other"], `round ${round}, ${branch}: both namespaces are approved`);
      assert.equal(view.noNamespace.length, 0, `round ${round}, ${branch}: every plan is placed`);
      assert.deepEqual(viewOf(view, "other").ordered.map((block) => block.ids), [["qqqqqq44"]], `round ${round}, ${branch}: the saved order applies`);
    }
  }
  assert.equal(fs.readFileSync(path.join(switchingStore.root, "plans/plans-order.json"), "utf8"), registryJson, "switching branches writes nothing to the registry");

  // A namespace may be named like an Object.prototype property, and a registry that has no entry for
  // it must read as empty, not as the inherited property.
  const inherited = planStore(fx.repository("inherited", {
    "plans/plans-config.json": JSON.stringify({ schemaVersion: 1, namespaces: { constructor: "x", other: "y" } }),
    "plans/backlog/constructor-one.md": document({ id: "cccccc11" }),
    "plans/backlog/other-one.md": document({ id: "oooooo22" }),
    "plans/plans-order.json": JSON.stringify({ schemaVersion: 1, namespaces: { other: ["oooooo22"] } }),
  }));
  const inheritedIndex = inherited.index();
  const constructorView = viewOf(inheritedIndex, "constructor");
  assert.deepEqual(constructorView.ordered, [], "an inherited property is not a saved order");
  assert.deepEqual(constructorView.needsPrioritization.map((block) => block.ids), [["cccccc11"]]);
  const placedInherited = await saveNamespaceOrder({ store: inherited.store, namespace: "constructor", order: ["cccccc11"], revision: constructorView.revision });
  assert.deepEqual(placedInherited.order, ["cccccc11"], "Save writes a namespace with no entry yet");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(inherited.root, "plans/plans-order.json"), "utf8")).namespaces, { other: ["oooooo22"], constructor: ["cccccc11"] });

  // The base branch comes from the repo, never from what happens to be checked out.
  const based = path.join(root, "based");
  fs.mkdirSync(based);
  run(based, "init", "-q", "-b", "trunk");
  run(based, "config", "user.email", "t@example.com");
  run(based, "config", "user.name", "t");
  run(based, "commit", "-q", "--allow-empty", "-m", "seed");
  assert.equal(repositoryBaseBranch(based), null, "no remote default and no main or master says nothing");
  run(based, "update-ref", "refs/remotes/origin/trunk", "HEAD");
  run(based, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  run(based, "switch", "-qc", "feature");
  assert.equal(repositoryBaseBranch(based), "trunk", "the remote's default, even from another branch");
  run(based, "branch", "main");
  assert.equal(repositoryBaseBranch(based), "trunk", "the remote's default beats a local main");
  run(based, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
  assert.equal(repositoryBaseBranch(based), "main", "without one, a local main");
  run(based, "branch", "-m", "main", "master");
  assert.equal(repositoryBaseBranch(based), "master", "or a local master");

  // A draft goes stale only for what can change its own namespace's Save, and a Save keeps the rest.
  const scoped = planStore(fx.repository("scoped", {
    "plans/plans-config.json": JSON.stringify({ schemaVersion: 1, namespaces: { one: "x", two: "y" } }),
    "plans/backlog/one-a.md": document({ id: "onea1111" }),
    "plans/backlog/one-b.md": document({ id: "oneb2222" }),
    "plans/backlog/two-a.md": document({ id: "twoa3333" }),
    "plans/backlog/two-b.md": document({ id: "twob4444" }),
    "plans/plans-order.json": JSON.stringify({ schemaVersion: 1, namespaces: { one: ["onea1111", "oneb2222"], two: ["twoa3333"] } }),
  }));
  const scopedView = async (namespace) => viewOf(scoped.index(), namespace);
  const scopedFile = () => JSON.parse(fs.readFileSync(path.join(scoped.root, "plans/plans-order.json"), "utf8"));
  const draftRevision = (await scopedView("one")).revision;
  await setNamespacePinned({ store: scoped.store, namespace: "two", pinned: true });
  assert.equal((await scopedView("one")).revision, draftRevision, "pinning another namespace leaves this draft's revision alone");
  await saveNamespaceOrder({ store: scoped.store, namespace: "two", order: ["twob4444", "twoa3333"], revision: (await scopedView("two")).revision });
  assert.equal((await scopedView("one")).revision, draftRevision, "saving another namespace leaves this draft's revision alone");
  await saveNamespaceOrder({ store: scoped.store, namespace: "one", order: ["oneb2222", "onea1111"], revision: draftRevision });
  assert.deepEqual(scopedFile(), { schemaVersion: 1, pinned: ["two"], namespaces: { one: ["oneb2222", "onea1111"], two: ["twob4444", "twoa3333"] } }, "the Save keeps the other namespace's order and pin");
  await assert.rejects(async () => saveNamespaceOrder({ store: scoped.store, namespace: "one", order: [], revision: draftRevision }), { code: "STALE_ORDER" }, "a change to this namespace's own order still goes stale");
  const beforeConfig = (await scopedView("one")).revision;
  scoped.write("plans/plans-config.json", JSON.stringify({ schemaVersion: 1, namespaces: { one: "x", two: "y", three: "z" } }));
  assert.notEqual((await scopedView("one")).revision, beforeConfig, "a config edit still goes stale");
  const beforeDependency = (await scopedView("one")).revision;
  scoped.write("plans/backlog/one-a.md", document({ id: "onea1111", deps: ["oneb2222"] }));
  assert.notEqual((await scopedView("one")).revision, beforeDependency, "a dependency edit in this namespace still goes stale");
} finally {
  fx.cleanup();
}

console.log("backlog order: gallery, registry, command, and gates ok");
