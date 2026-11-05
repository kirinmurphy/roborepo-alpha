#!/usr/bin/env node
// Backlog ordering: the pure grouping and order calculations over every dependency shape the UI
// contract names, then the registry's read, write, and refusal rules against real files, and the
// `roborepo plans order place` command and validation gates in a real Git repository.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deriveGroups, findDependencyCycles, proposeOrder } from "../../modules/plan-suite/backlog-order.mjs";
import { buildBacklogIndex, placePlan, readOrderRegistry, saveNamespaceOrder, setNamespacePinned } from "../../modules/plan-suite/backlog-registry.mjs";
import { readProjectNamespaces, resolvePlanNamespace, validatePlanNaming } from "../../modules/plan-suite/naming.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const NS = "agents";

// A plan shaped as the calculations read it. deps are its depends_on ids.
function plan(id, deps = [], overrides = {}) {
  return { id, namespace: NS, lifecycle: "backlog", dependencies: deps, relativePath: `docs/plans/backlog/agents-${id}.md`, title: `Plan ${id}`, ...overrides };
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

// ---- Files: a real repository ----
const root = fs.mkdtempSync(path.join(os.tmpdir(), "backlog-order-"));
const run = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const roborepo = (cwd, ...args) => spawnSync(path.join(repoRoot, "bin", "roborepo"), ["plans", ...args], { cwd, encoding: "utf8", env: { ...process.env, ROBOREPO_STATE_ROOT: path.join(root, "state"), HOME: root } });
function document({ id, deps = [], title = id }) {
  return `---\nid: ${id}\nnext_action: Do it\ndepends_on: [${deps.join(", ")}]\n---\n\n# ${title}\n\n## Summary\n\nx\n\n## Goals\n\nx\n\n## Context\n\nx\n\n## Proposed design\n\nx\n\n## Validation\n\nx\n`;
}
try {
  const repo = path.join(root, "repo");
  const write = (relative, content) => {
    fs.mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true });
    fs.writeFileSync(path.join(repo, relative), content);
  };
  const config = (namespaces) => write("docs/plans/plans-config.json", JSON.stringify({ schemaVersion: 1, namespaces }));
  fs.mkdirSync(repo);
  run(repo, "init", "-q", "-b", "main");
  run(repo, "config", "user.email", "t@example.com");
  run(repo, "config", "user.name", "t");
  config({ agents: "x", other: "y" });
  write("docs/plans/backlog/agents-a.md", document({ id: "aaaaaa11" }));
  write("docs/plans/backlog/agents-b.md", document({ id: "bbbbbb22", deps: ["aaaaaa11"] }));
  write("docs/plans/backlog/agents-x.md", document({ id: "xxxxxx33" }));
  write("docs/plans/backlog/other-q.md", document({ id: "qqqqqq44" }));
  write("docs/plans/backlog/nosuch-z.md", document({ id: "zzzzzz55" }));
  write("docs/plans/active/agents-gone.md", document({ id: "gggggg66" }));
  run(repo, "add", ".");
  run(repo, "commit", "-qm", "seed");
  const orderFile = path.join(repo, "docs/plans/plans-order.json");

  // Records as the CLI and the portal read them.
  const records = async () => {
    const { primaryCheckoutRecords } = await import("../../modules/plan-suite/repository-validation.mjs");
    return primaryCheckoutRecords(fs.realpathSync(repo));
  };
  const indexed = async () => buildBacklogIndex(fs.realpathSync(repo), await records());
  const realRepo = fs.realpathSync(repo);
  const viewOf = (index, namespace) => index.namespaces.find((view) => view.namespace === namespace);

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
  const saved = saveNamespaceOrder({ root: realRepo, records: await records(), namespace: "agents", order: ["xxxxxx33", "aaaaaa11", "bbbbbb22"], revision });
  assert.deepEqual(saved.order, ["xxxxxx33", "aaaaaa11", "bbbbbb22"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(orderFile, "utf8")), { schemaVersion: 1, namespaces: { agents: ["xxxxxx33", "aaaaaa11", "bbbbbb22"] } });
  assert.deepEqual(fs.readdirSync(path.dirname(orderFile)).filter((name) => name.includes("tmp")), [], "no temp file is left behind");
  assert.throws(() => saveNamespaceOrder({ root: realRepo, records: [], namespace: "agents", order: [], revision }), { code: "STALE_ORDER" }, "an old revision is refused");
  index = await indexed();
  assert.deepEqual(viewOf(index, "agents").ordered.map((block) => block.ids), [["xxxxxx33"], ["aaaaaa11", "bbbbbb22"]]);
  assert.deepEqual(viewOf(index, "agents").needsPrioritization, []);

  // Returning a plan takes it out of the file and back to Needs prioritization, and only when named.
  const beforeReturn = viewOf(index, "agents").revision;
  const beforeReturnRecords = await records();
  assert.throws(() => saveNamespaceOrder({ root: realRepo, records: beforeReturnRecords, namespace: "agents", order: ["aaaaaa11", "bbbbbb22"], revision: beforeReturn }), { code: "INVALID_CHANGE" }, "an unnamed omission is still refused");
  assert.throws(() => saveNamespaceOrder({ root: realRepo, records: beforeReturnRecords, namespace: "agents", order: ["aaaaaa11", "bbbbbb22"], unprioritized: "xxxxxx33", revision: beforeReturn }), { code: "INVALID_CHANGE" });
  saveNamespaceOrder({ root: realRepo, records: await records(), namespace: "agents", order: ["aaaaaa11", "bbbbbb22"], unprioritized: ["xxxxxx33"], revision: beforeReturn });
  assert.deepEqual(JSON.parse(fs.readFileSync(orderFile, "utf8")).namespaces.agents, ["aaaaaa11", "bbbbbb22"]);
  index = await indexed();
  assert.deepEqual(viewOf(index, "agents").needsPrioritization.map((block) => block.ids), [["xxxxxx33"]]);
  saveNamespaceOrder({ root: realRepo, records: await records(), namespace: "agents", order: ["xxxxxx33", "aaaaaa11", "bbbbbb22"], revision: viewOf(index, "agents").revision });
  index = await indexed();

  // A dependency edit changes the revision, regroups on read, and writes nothing.
  const before = fs.readFileSync(orderFile, "utf8");
  write("docs/plans/backlog/agents-x.md", document({ id: "xxxxxx33", deps: ["bbbbbb22"] }));
  index = await indexed();
  assert.deepEqual(viewOf(index, "agents").ordered.map((block) => block.ids), [["aaaaaa11", "bbbbbb22", "xxxxxx33"]], "the new edge regroups the effective order");
  assert.deepEqual(viewOf(index, "agents").moves.map((move) => move.kind), ["moved"], "and the move is visible");
  assert.notEqual(viewOf(index, "agents").revision, revision);
  assert.equal(fs.readFileSync(orderFile, "utf8"), before, "read purity: the registry is untouched");
  write("docs/plans/backlog/agents-x.md", document({ id: "xxxxxx33" }));

  // A plan outside Backlog is pruned at the next write; an unknown id and another namespace stay.
  fs.writeFileSync(orderFile, JSON.stringify({ schemaVersion: 1, namespaces: {
    agents: ["gggggg66", "ghost123", "xxxxxx33", "aaaaaa11", "bbbbbb22", "zzzzzz55"],
    removed: ["kept1234"],
  } }));
  index = await indexed();
  assert.deepEqual(index.findings.map((item) => item.code).sort(), ["ORDER_UNAPPROVED_NAMESPACE", "ORDER_UNKNOWN_PLAN"], "unknown ids and unapproved namespaces are findings; a plan outside Backlog is not");
  assert.deepEqual(viewOf(index, "agents").moves, [], "an ignored id is not a move");
  saveNamespaceOrder({ root: realRepo, records: await records(), namespace: "agents", order: ["aaaaaa11", "bbbbbb22", "xxxxxx33"], revision: viewOf(index, "agents").revision });
  assert.deepEqual(JSON.parse(fs.readFileSync(orderFile, "utf8")).namespaces, {
    agents: ["aaaaaa11", "bbbbbb22", "xxxxxx33", "ghost123", "zzzzzz55"],
    removed: ["kept1234"],
  }, "pruned the active plan; preserved the unknown id, the unnamespaced plan, and the other namespace");

  // Pins lift a namespace above alphabetical order, first pinned first, and leave every order alone.
  const orderBeforePins = JSON.parse(fs.readFileSync(orderFile, "utf8")).namespaces;
  setNamespacePinned({ root: realRepo, namespace: "other", pinned: true });
  index = await indexed();
  assert.deepEqual(index.namespaces.map((view) => [view.namespace, view.pinned]), [["other", true], ["agents", false]], "a pinned namespace comes first");
  setNamespacePinned({ root: realRepo, namespace: "agents", pinned: true });
  setNamespacePinned({ root: realRepo, namespace: "agents", pinned: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(orderFile, "utf8")).pinned, ["other", "agents"], "pinning twice records it once, in pin order");
  assert.deepEqual((await indexed()).namespaces.map((view) => view.namespace), ["other", "agents"], "pin order beats alphabetical");
  assert.deepEqual(JSON.parse(fs.readFileSync(orderFile, "utf8")).namespaces, orderBeforePins, "pinning changes no plan's order");
  assert.throws(() => setNamespacePinned({ root: realRepo, namespace: "nonsense", pinned: true }), /not an approved namespace/);
  // A Save keeps the pins.
  index = await indexed();
  saveNamespaceOrder({ root: realRepo, records: await records(), namespace: "agents", order: ["aaaaaa11", "bbbbbb22", "xxxxxx33"], revision: viewOf(index, "agents").revision });
  assert.deepEqual(JSON.parse(fs.readFileSync(orderFile, "utf8")).pinned, ["other", "agents"], "a Save preserves pins");
  // A pin on a namespace removed from the config is ignored on read and pruned at the next write.
  const pinnedFile = JSON.parse(fs.readFileSync(orderFile, "utf8"));
  fs.writeFileSync(orderFile, JSON.stringify({ ...pinnedFile, pinned: ["gone", "agents"] }));
  const pinsRaw = fs.readFileSync(orderFile, "utf8");
  index = await indexed();
  assert.deepEqual(index.namespaces.map((view) => [view.namespace, view.pinned]), [["agents", true], ["other", false]], "a removed namespace's pin has no effect");
  assert.equal(fs.readFileSync(orderFile, "utf8"), pinsRaw, "reading does not prune");
  assert.equal(index.findings.some((item) => /gone/.test(item.message || "")), false, "a stale pin is not a finding");
  saveNamespaceOrder({ root: realRepo, records: await records(), namespace: "agents", order: ["aaaaaa11", "bbbbbb22", "xxxxxx33"], revision: viewOf(index, "agents").revision });
  assert.deepEqual(JSON.parse(fs.readFileSync(orderFile, "utf8")).pinned, ["agents"], "the next Save prunes it");
  setNamespacePinned({ root: realRepo, namespace: "agents", pinned: false });
  assert.equal("pinned" in JSON.parse(fs.readFileSync(orderFile, "utf8")), false, "with no pins the key is left out");
  fs.writeFileSync(orderFile, JSON.stringify({ schemaVersion: 1, pinned: "agents", namespaces: {} }));
  assert.equal(readOrderRegistry(realRepo).state, "invalid", "a malformed pin list is an invalid registry");
  assert.throws(() => setNamespacePinned({ root: realRepo, namespace: "agents", pinned: true }), /was not overwritten/);
  fs.writeFileSync(orderFile, `${JSON.stringify({ schemaVersion: 1, namespaces: orderBeforePins }, null, 2)}\n`);

  // An invalid order is refused and writes nothing.
  index = await indexed();
  assert.throws(() => saveNamespaceOrder({ root: realRepo, records: [], namespace: "other", order: [], revision: "x" }), { code: "STALE_ORDER" });
  const held = fs.readFileSync(orderFile, "utf8");
  const current = await records();
  assert.throws(() => saveNamespaceOrder({ root: realRepo, records: current, namespace: "agents", order: ["bbbbbb22", "aaaaaa11", "xxxxxx33"], revision: viewOf(index, "agents").revision }), /prerequisite/);
  assert.equal(fs.readFileSync(orderFile, "utf8"), held);

  // A failed write reaches the browser, so it carries the code and never an absolute path, and it
  // leaves neither a temp file nor a changed registry. Stubbed because a root user ignores file modes.
  const realRename = fs.renameSync;
  fs.renameSync = () => {
    throw Object.assign(new Error(`EACCES: permission denied, rename '${orderFile}'`), { code: "EACCES" });
  };
  try {
    assert.throws(() => saveNamespaceOrder({ root: realRepo, records: current, namespace: "agents", order: ["xxxxxx33", "aaaaaa11", "bbbbbb22"], revision: viewOf(index, "agents").revision }), (err) => {
      assert.equal(err.code, "ORDER_WRITE_FAILED");
      assert.equal(err.status, 500);
      assert.equal(err.message, "docs/plans/plans-order.json could not be written (EACCES).");
      return true;
    });
  } finally {
    fs.renameSync = realRename;
  }
  assert.deepEqual(fs.readdirSync(path.dirname(orderFile)).filter((name) => name.includes("tmp")), [], "a failed write removes its temp file");
  assert.equal(fs.readFileSync(orderFile, "utf8"), held, "a failed write leaves the registry as it was");

  // An unparseable registry reads as unprioritized and refuses every write.
  fs.writeFileSync(orderFile, "{ not json");
  index = await indexed();
  assert.equal(index.registry.state, "invalid");
  assert.deepEqual(viewOf(index, "agents").ordered, []);
  assert.equal(viewOf(index, "agents").writable, false);
  assert.ok(index.findings.some((item) => item.code === "INVALID_ORDER_REGISTRY"));
  assert.throws(() => saveNamespaceOrder({ root: realRepo, records: current, namespace: "agents", order: [], revision: viewOf(index, "agents").revision }), /was not overwritten/);
  assert.equal(fs.readFileSync(orderFile, "utf8"), "{ not json", "the file a person can repair is left alone");
  fs.writeFileSync(orderFile, JSON.stringify({ schemaVersion: 2, namespaces: {} }));
  assert.equal(readOrderRegistry(realRepo).state, "invalid", "an unknown schema is not guessed at");
  fs.rmSync(orderFile);

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
  write("docs/plans/backlog/agents-c.md", document({ id: "cccccc77", deps: ["bbbbbb22"] }));
  const attached = place("cccccc77", "--bottom");
  assert.equal(attached.placed, "attached");
  assert.equal(attached.ignoredPosition, "bottom", "a dependent stays with its group whatever the flag says");
  assert.deepEqual(JSON.parse(fs.readFileSync(orderFile, "utf8")).namespaces.agents, ["aaaaaa11", "bbbbbb22", "cccccc77", "xxxxxx33"]);
  fs.rmSync(path.join(repo, "docs/plans/backlog/agents-c.md"));
  const refused = roborepo(repo, "order", "place", "zzzzzz55", "--top");
  assert.equal(refused.status, 1, "a plan with no namespace cannot be ordered");
  assert.match(refused.stderr, /no approved namespace/);
  assert.equal(roborepo(repo, "order", "place", "aaaaaa11", "--top", "--bottom").status, 2);
  const beforeTransition = fs.readFileSync(orderFile, "utf8");

  // A broken graph: the finding blocks validation, and every write to that namespace is refused.
  const unbroken = fs.readFileSync(orderFile, "utf8");
  write("docs/plans/backlog/agents-cycle-one.md", document({ id: "cycle111", deps: ["cycle222"] }));
  write("docs/plans/backlog/agents-cycle-two.md", document({ id: "cycle222", deps: ["cycle111"] }));
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
    assert.throws(() => saveNamespaceOrder({ root: realRepo, records: lockedRecords, namespace: "agents", order: [], revision: viewOf(lockedIndex, "agents").revision }), /needs repair before/, `${label}: Save is refused`);
    assert.equal(fs.readFileSync(orderFile, "utf8"), unbroken, `${label}: nothing is written`);
  };
  await assertLocked("a cycle");
  fs.rmSync(path.join(repo, "docs/plans/backlog/agents-cycle-one.md"));
  fs.rmSync(path.join(repo, "docs/plans/backlog/agents-cycle-two.md"));
  write("docs/plans/backlog/agents-missing.md", document({ id: "miss1111", deps: ["nosuchid"] }));
  await assertLocked("a missing prerequisite");
  fs.rmSync(path.join(repo, "docs/plans/backlog/agents-missing.md"));

  // A plan that exists only in a linked worktree ranks like any other, and its place is stored in the
  // primary checkout, never in the worktree it was run from.
  const linked = path.join(root, "linked");
  run(repo, "worktree", "add", "-q", "-b", "feat/linked", linked);
  fs.writeFileSync(path.join(linked, "docs/plans/backlog/agents-new.md"), document({ id: "nnnnnn88" }));
  const fromWorktree = roborepo(linked, "order", "place", "nnnnnn88", "--bottom", "--json");
  assert.equal(fromWorktree.status, 0, fromWorktree.stdout + fromWorktree.stderr);
  assert.ok(JSON.parse(fs.readFileSync(orderFile, "utf8")).namespaces.agents.includes("nnnnnn88"), "written to the primary checkout");
  assert.equal(fs.existsSync(path.join(linked, "docs/plans/plans-order.json")), false, "not to the worktree");
  run(repo, "worktree", "remove", "--force", linked);
  fs.writeFileSync(orderFile, beforeTransition);

  // Naming gates: validate exits 1, promote refuses, and the file stays visible.
  const validated = roborepo(repo, "validate", "--json");
  assert.equal(validated.status, 1);
  const report = JSON.parse(validated.stdout);
  assert.ok(report.plans.find((item) => item.id === "zzzzzz55").findings.some((item) => item.code === "UNKNOWN_PLAN_NAMESPACE"));
  const promote = roborepo(repo, "promote", "zzzzzz55", "--json");
  assert.equal(promote.status, 1);
  assert.ok(JSON.parse(promote.stdout).error.findings.some((item) => item.code === "UNKNOWN_PLAN_NAMESPACE"), "promote refuses a bad prefix");

  // Start applies the same gate, to a plan that reached Ready with a bad name.
  write("docs/plans/ready/nosuch-ready.md", document({ id: "yyyyyy99" }));
  run(repo, "add", "docs/plans/ready/nosuch-ready.md");
  run(repo, "commit", "-qm", "misnamed ready plan");
  const gateTree = path.join(root, "gate-tree");
  run(repo, "worktree", "add", "-q", "-b", "feat/gate", gateTree);
  const started = roborepo(repo, "start", "yyyyyy99", "--worktree", "gate-tree", "--json");
  assert.equal(started.status, 1);
  assert.ok(JSON.parse(started.stdout).error.findings.some((item) => item.code === "UNKNOWN_PLAN_NAMESPACE"), "start refuses a bad prefix");

  // A transition commits only the plan's paths and leaves the registry for the next write.
  write("docs/plans/backlog/agents-a.md", document({ id: "aaaaaa11" }));
  const promoted = roborepo(repo, "promote", "aaaaaa11", "--json");
  assert.equal(promoted.status, 0, promoted.stdout + promoted.stderr);
  assert.deepEqual(run(repo, "show", "--no-renames", "--name-only", "--format=", "HEAD").trim().split("\n").sort(), ["docs/plans/backlog/agents-a.md", "docs/plans/ready/agents-a.md"]);
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

  write("docs/plans/plans-config.json", "{ nope");
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
  const configFile = path.join(repo, "docs/plans/plans-config.json");
  fs.rmSync(configFile);
  fs.mkdirSync(configFile);
  assert.equal(readProjectNamespaces(realRepo).error, "EISDIR");
  fs.rmdirSync(configFile);
  write("docs/plans/plans-config.json", "{ nope");
  const orderBeforeLoop = fs.readFileSync(orderFile, "utf8");
  fs.rmSync(orderFile);
  fs.symlinkSync(orderFile, orderFile);
  assert.deepEqual(readOrderRegistry(realRepo), { state: "invalid", namespaces: {}, pinned: [], raw: "", error: "ELOOP" });
  fs.rmSync(orderFile);
  fs.writeFileSync(orderFile, orderBeforeLoop);

  // No config at all: the convention is inert.
  fs.rmSync(path.join(repo, "docs/plans/plans-config.json"));
  index = await indexed();
  assert.equal(index.config.state, "none");
  assert.equal(index.namespaces.length, 0);
  assert.deepEqual(validatePlanNaming({ filename: "whatever.md", lifecycle: "backlog", projectNamespaces: [] }), [], "no config, no per-file findings");

  // A branch switch changes the config on disk: each read follows the checked-out vocabulary, and the
  // uncommitted registry stays as it was.
  const switching = path.join(root, "switching");
  const writeSwitching = (relative, content) => {
    fs.mkdirSync(path.dirname(path.join(switching, relative)), { recursive: true });
    fs.writeFileSync(path.join(switching, relative), content);
  };
  fs.mkdirSync(switching);
  run(switching, "init", "-q", "-b", "main");
  run(switching, "config", "user.email", "t@example.com");
  run(switching, "config", "user.name", "t");
  writeSwitching("docs/plans/plans-config.json", JSON.stringify({ schemaVersion: 1, namespaces: { agents: "x" } }));
  writeSwitching("docs/plans/backlog/agents-a.md", document({ id: "aaaaaa11" }));
  writeSwitching("docs/plans/backlog/other-q.md", document({ id: "qqqqqq44" }));
  run(switching, "add", ".");
  run(switching, "commit", "-qm", "narrow config");
  run(switching, "switch", "-qc", "wider");
  writeSwitching("docs/plans/plans-config.json", JSON.stringify({ schemaVersion: 1, namespaces: { agents: "x", other: "y" } }));
  run(switching, "add", ".");
  run(switching, "commit", "-qm", "wider config");
  const registryJson = JSON.stringify({ schemaVersion: 1, namespaces: { other: ["qqqqqq44"] } });
  writeSwitching("docs/plans/plans-order.json", registryJson);
  const realSwitching = fs.realpathSync(switching);
  const indexAfterSwitch = async (branch) => {
    run(switching, "switch", "-q", branch);
    const { primaryCheckoutRecords } = await import("../../modules/plan-suite/repository-validation.mjs");
    return buildBacklogIndex(realSwitching, primaryCheckoutRecords(realSwitching));
  };
  for (let round = 0; round < 5; round += 1) {
    const narrow = await indexAfterSwitch("main");
    assert.deepEqual(narrow.namespaces.map((view) => view.namespace), ["agents"], `round ${round}: main has one namespace`);
    assert.equal(narrow.noNamespace.length, 1, `round ${round}: main has no namespace for the other plan`);
    assert.ok(narrow.findings.some((item) => item.code === "ORDER_UNAPPROVED_NAMESPACE"), `round ${round}: main reports the saved order it cannot use`);
    const wider = await indexAfterSwitch("wider");
    assert.deepEqual(wider.namespaces.map((view) => view.namespace), ["agents", "other"], `round ${round}: the branch adds a namespace`);
    assert.equal(wider.noNamespace.length, 0, `round ${round}: the branch places every plan`);
    assert.deepEqual(viewOf(wider, "other").ordered.map((block) => block.ids), [["qqqqqq44"]], `round ${round}: the saved order applies again`);
  }
  assert.equal(fs.readFileSync(path.join(switching, "docs/plans/plans-order.json"), "utf8"), registryJson, "switching branches writes nothing to the registry");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("backlog order: gallery, registry, command, and gates ok");
