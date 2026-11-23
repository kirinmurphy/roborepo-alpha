#!/usr/bin/env node
// Config page dependencies, as buildBehaviorView derives them and `roborepo config status` prints
// them: each row references its transitive requirements for the source popup, independently of
// whether they keep their own catalog rows; each row also references its direct `recommends`,
// minus packages it requires and hidden ones; dependency-only and hidden packages have no normal
// row. Workspace fixtures in a throwaway home.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repoRoot, "scripts/cli/main.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-config-deps-"));
const workspace = path.join(tmp, "workspace");
fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
fs.mkdirSync(path.join(tmp, ".codex"), { recursive: true });
fs.writeFileSync(path.join(tmp, ".claude", "settings.json"), "{}");
fs.writeFileSync(path.join(tmp, ".codex", "config.toml"), "");
const env = { ...process.env, HOME: tmp, ROBOREPO_STATE_ROOT: path.join(tmp, ".roborepo"), ROBOREPO_WORKSPACE_ROOT: workspace, SKIP_MCP: "1" };

function fixture(id, config = {}) {
  const dir = path.join(workspace, "packages", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "rules.md"), `## Deps fixture ${id}\n`);
  fs.writeFileSync(path.join(dir, "package.config.json"), JSON.stringify({
    schemaVersion: 1, id, label: `Deps ${id}`, description: "Dependency section fixture",
    resources: [{ type: "rules", harness: "claude", source: "rules.md" }],
    ...config,
    presentation: { category: "integrations", ...(config.presentation || {}) },
  }));
}

// deps-planner -> deps-review (dependency-only) -> deps-leaf (other category, transitive)
// deps-closer -> deps-review; recommends deps-companion (other category) and deps-leaf (also required)
// deps-sibling is a row in the same section that deps-closer recommends; deps-companion -> deps-leaf
// deps-review recommends deps-sibling, so deps-planner lists it through its requirement
fixture("deps-planner", { requires: ["deps-review"] });
fixture("deps-closer", { requires: ["deps-review"], recommends: ["deps-companion", "deps-leaf", "deps-sibling", "deps-hidden"] });
fixture("deps-sibling");
fixture("deps-review", { selectable: false, requires: ["deps-leaf"], recommends: ["deps-sibling"], presentation: { visibility: "dependency" } });
fixture("deps-leaf", { presentation: { category: "token-optimization" } });
fixture("deps-companion", { requires: ["deps-leaf"], presentation: { category: "token-optimization" } });
fixture("deps-hidden", { presentation: { visibility: "hidden" } });
fixture("pure-parent", { requires: ["deps-review"], resources: [] });
fixture("pure-hidden-parent", { requires: ["deps-hidden"], resources: [] });
function run(...args) {
  const result = spawnSync(process.execPath, args, { env, cwd: repoRoot, encoding: "utf8", input: "" });
  assert.equal(result.status, 0, `${args.join(" ")} failed\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

try {
  run(cli, "package", "enable", "deps-planner");
  const section = JSON.parse(run("-e", `
    import(${JSON.stringify(path.join(repoRoot, "scripts/cli/config.mjs"))}).then((c) => {
      const view = c.buildBehaviorView(c.readConfigSnapshot());
      console.log(JSON.stringify(view.find((s) => s.categoryId === "integrations")));
    });
  `));

  const rowIds = section.items.map((item) => item.id).filter((id) => id.startsWith("deps-")).sort();
  assert.deepEqual(rowIds, ["deps-closer", "deps-planner", "deps-sibling"],
    "dependency-only and hidden packages have no normal row");

  const byId = new Map(section.items.map((item) => [item.id, item]));
  const pureParent = byId.get("pure-parent");
  assert.equal(pureParent.inspect?.kind, "package-contents", "a pure composite exposes its requirement references");
  assert.deepEqual(pureParent.inspect.entries, [], "the pure composite has no source entries of its own");
  assert.deepEqual(pureParent.requires.map((ref) => ref.id), ["deps-leaf", "deps-review"]);
  const pureHiddenParent = byId.get("pure-hidden-parent");
  assert.equal(pureHiddenParent.inspect, null, "a pure composite whose requirements are all hidden has nothing to open");
  assert.deepEqual(pureHiddenParent.requires, []);
  assert.deepEqual(byId.get("deps-planner").requires.map((ref) => ref.id), ["deps-leaf", "deps-review"],
    "a row references its transitive requirements, dependencies first");
  const review = byId.get("deps-planner").requires.find((ref) => ref.id === "deps-review");
  assert.equal(review.label, "Deps deps-review");
  assert.equal(review.active, true, "a derived requirement reads as on");
  assert.deepEqual(review.inspect, { kind: "rules", id: "deps-review", label: "Deps deps-review" },
    "a requirement carries the inspect target its source popup opens");
  assert.deepEqual(review.requiredIds, ["deps-leaf"],
    "a requirement names its own requirements, so its popup can show the next link of the chain");
  assert.deepEqual(byId.get("deps-planner").requires.find((ref) => ref.id === "deps-leaf").requiredIds, []);
  assert.deepEqual(byId.get("deps-sibling").requires, [], "a row with no requirements references none");
  assert.equal(section.requiredDependencies, undefined, "required packages get no page list of their own");

  assert.equal(section.recommendedDependencies, undefined, "recommended packages get no section list of their own");
  const closerRecommends = byId.get("deps-closer").recommends;
  assert.deepEqual(closerRecommends.map((ref) => ref.id), ["deps-companion", "deps-sibling"],
    "a row's recommendations skip packages it requires and hidden packages, in manifest order");
  const companion = closerRecommends[0];
  assert.equal(companion.label, "Deps deps-companion");
  assert.equal(companion.active, false, "an off recommendation reads as off");
  assert.ok(companion.inspect, "a recommendation carries the inspect target its detail opens");
  assert.deepEqual(companion.requires.map((ref) => ref.id), ["deps-leaf"],
    "a recommendation carries its own requirements, so its detail can list them");
  assert.deepEqual(byId.get("deps-planner").recommends.map((ref) => ref.id), ["deps-sibling"],
    "a row lists the recommendations of what it requires, flattened into its own list");
  assert.deepEqual(byId.get("deps-sibling").recommends, [], "a row with no recommendations references none");

  const printed = run(cli, "config", "status");
  assert.doesNotMatch(printed, /Required dependencies/, "config status prints no required list");
  assert.match(printed, /\[x\] Deps deps-planner\n {6}Dependency section fixture\n {6}requires: Deps deps-leaf, Deps deps-review\n/,
    "config status names a row's requirements under it");
  assert.doesNotMatch(printed, /Recommended dependencies/, "config status prints no section recommended list");
  assert.match(printed, /\n {6}recommends: Deps deps-companion \(off\), Deps deps-sibling \(off\)\n/,
    "config status names a row's recommendations under it, with the ones still off marked");

  const enabledCloser = run(cli, "package", "enable", "deps-closer");
  assert.match(enabledCloser, /recommended \(not enabled\): .*deps-companion/);
  assert.doesNotMatch(enabledCloser, /recommended \(not enabled\): .*deps-hidden/,
    "hidden recommendations stay out of the enable result shown by the terminal and portal dialog");

  console.log("ok: config dependencies (row references, recommendations, terminal print)");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
