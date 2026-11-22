#!/usr/bin/env node
// Package-boundary warnings from `roborepo skill audit`: one fixture per warning, each a small
// in-memory catalog, plus the real catalog, which must produce none.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageBoundaryFindings, pairedSkillRows } from "../cli/skill-package-boundaries.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const table = (...rows) => [
  "## Paired Skills",
  "",
  "Load these when the work calls for them; do not wait to be asked for them by name.",
  "",
  "| Skill | Relationship | Load when | Contributes |",
  "| --- | --- | --- | --- |",
  ...rows.map(([skill, relationship, when]) => `| \`${skill}\` | ${relationship} | ${when} | Rules |`),
  "",
  "## Workflow",
  "",
].join("\n");
const pkg = (id, skills, { requires = [], recommends = [] } = {}) => ({
  id, requires, recommends,
  skills: Object.entries(skills).map(([name, body]) => ({ name, body })),
});
const only = (packages, pattern) => {
  const findings = packageBoundaryFindings(packages, { proseOnly: new Set() });
  assert.equal(findings.length, 1, `expected one finding, got:\n${findings.join("\n")}`);
  assert.match(findings[0], pattern);
};

// Table parsing reads columns by header, so a three-column table still parses.
assert.deepEqual(
  pairedSkillRows("## Paired Skills\n\n| Skill | Load when | Contributes |\n| --- | --- | --- |\n| `a` | Always | x |\n"),
  [{ skill: "a", relationship: "", when: "Always" }],
);

// Unconditional load across packages with no `requires` either way: merge, or add requires.
only([
  pkg("writer", { writer: `${table(["helper", "recommends", "**Always**: every run"])}` }, { recommends: ["helper"] }),
  pkg("helper", { helper: "# Helper\n" }),
], /writer unconditionally loads helper, and neither requires the other/);

// A prose instruction outside the table counts as unconditional when the table does not declare it.
only([
  pkg("writer", { writer: "# Writer\n\nThen load `helper` and run it.\n" }),
  pkg("helper", { helper: "# Helper\n" }),
], /writer unconditionally loads helper/);

// The same load is fine once the manifest requires it.
assert.deepEqual(packageBoundaryFindings([
  pkg("writer", { writer: `${table(["helper", "requires", "Always"])}` }, { requires: ["helper"] }),
  pkg("helper", { helper: "# Helper\n" }),
]), []);

// Two packages that each unconditionally hand off to the other: merge them.
only([
  pkg("left", { left: "# Left\n\nWhen done, hand off to `right`.\n" }),
  pkg("right", { right: "# Right\n\nWhen done, hand off to `left`.\n" }),
], /left and right each unconditionally hand off to the other: merge them/);

// A package of several skills that never reference each other: split it.
only([
  pkg("grab-bag", { alpha: "# Alpha\n", beta: "# Beta\n" }),
], /grab-bag holds 2 skills and none references another: split them/);

// Manifest and prose disagree: an edge with no row, a row with no edge, and a row whose
// relationship contradicts the manifest.
only([
  pkg("parent", { parent: "# Parent\n" }, { recommends: ["helper"] }),
  pkg("helper", { helper: "# Helper\n" }),
], /parent recommends helper, but no parent skill has a Paired Skills row for it/);
only([
  pkg("parent", { parent: table(["helper", "recommends", "The work touches helpers"]) }),
  pkg("helper", { helper: "# Helper\n" }),
], /parent pairs `helper`, but parent neither requires nor recommends helper/);
only([
  pkg("parent", { parent: table(["helper", "requires", "The work touches helpers"]) }, { recommends: ["helper"] }),
  pkg("helper", { helper: "# Helper\n" }),
], /parent marks `helper` as requires, but parent recommends helper/);

// A reference classified prose-only is not reported.
assert.deepEqual(packageBoundaryFindings([
  pkg("writer", { writer: "# Writer\n\nLoad `helper` for conventions.\n" }),
  pkg("helper", { helper: "# Helper\n" }),
], { proseOnly: new Set(["writer -> helper"]) }), []);

// The built-in catalog: the rendered audit lists no package-boundary warning.
const audit = fs.readFileSync(path.join(repoRoot, "docs/internal/skill-invocation-audit.md"), "utf8");
const section = audit.split("## Package Boundary Warnings")[1]?.split("\n## ")[0];
assert.ok(section, "skill audit has a Package Boundary Warnings section");
assert.match(section, /\nNone\.\n/, `built-in catalog has package-boundary warnings:\n${section}`);

console.log("ok: package-boundary warnings");
