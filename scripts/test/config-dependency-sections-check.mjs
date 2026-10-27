#!/usr/bin/env node
// Config page dependencies, as buildBehaviorView derives them and `roborepo config status` prints
// them: required packages are never page rows, only a reference on each row that requires them
// (transitive, for its source popup); a section lists its rows' direct `recommends` as switchable
// rows, without repeating a row it already shows or a package a row requires; dependency-only and
// hidden packages have no normal row. Workspace fixtures in a throwaway home.
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
const env = { ...process.env, HOME: tmp, ROBOREPO_STATE_DIR: path.join(tmp, ".roborepo"), ROBOREPO_WORKSPACE_ROOT: workspace, SKIP_MCP: "1" };

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
// deps-sibling is a row in the same section that deps-closer recommends
fixture("deps-planner", { requires: ["deps-review"] });
fixture("deps-closer", { requires: ["deps-review"], recommends: ["deps-companion", "deps-leaf", "deps-sibling"] });
fixture("deps-sibling");
fixture("deps-review", { selectable: false, requires: ["deps-leaf"], presentation: { visibility: "dependency" } });
fixture("deps-leaf", { presentation: { category: "token-optimization" } });
fixture("deps-companion", { presentation: { category: "token-optimization" } });
fixture("deps-hidden", { presentation: { visibility: "hidden" } });

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
  assert.deepEqual(byId.get("deps-planner").requires.map((ref) => ref.id), ["deps-leaf", "deps-review"],
    "a row references its transitive requirements, dependencies first");
  const review = byId.get("deps-planner").requires.find((ref) => ref.id === "deps-review");
  assert.equal(review.label, "Deps deps-review");
  assert.equal(review.active, true, "a derived requirement reads as on");
  assert.deepEqual(review.inspect, { kind: "rules", id: "deps-review", label: "Deps deps-review" },
    "a requirement carries the inspect target its source popup opens");
  assert.deepEqual(byId.get("deps-sibling").requires, [], "a row with no requirements references none");
  assert.equal(section.requiredDependencies, undefined, "required packages get no page list of their own");

  const recommended = section.recommendedDependencies.map((item) => item.id);
  assert.deepEqual(recommended, ["deps-companion"],
    "recommended skips rows already in the section and packages a row requires");
  assert.equal(section.recommendedDependencies[0].toggle, "package", "an off recommendation can be switched on");
  assert.equal(section.recommendedDependencies[0].relationText, "recommended by Deps deps-closer");

  const printed = run(cli, "config", "status");
  assert.doesNotMatch(printed, /Required dependencies/, "config status prints no required list");
  assert.match(printed, /\[x\] Deps deps-planner\n {6}Dependency section fixture\n {6}requires: Deps deps-leaf, Deps deps-review\n/,
    "config status names a row's requirements under it");
  assert.match(printed, /\n {2}Recommended dependencies\n {4}\[ \] Deps deps-companion {2}\(recommended by Deps deps-closer\)/,
    "config status prints the recommended list");

  console.log("ok: config dependencies (row references, recommended list, terminal print)");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
