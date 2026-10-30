#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
// The rest of this repo derives the directory this way.
import { fileURLToPath } from "node:url";
import { loadPackageCatalog, validatePackageCatalog } from "../cli/package-catalog.mjs";
import { loadSlashCommandPlan } from "../cli/slash-commands.mjs";
import { readConfigSnapshot } from "../cli/config.mjs";
import { buildOnboardSteps } from "../cli/presets.mjs";
import { MULTI_SKILL_IDS, MULTI_SKILL_PACKAGE_ID, writeMultiSkillPackage } from "./fixtures/multi-skill-package.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const catalog = loadPackageCatalog({ includeUnavailable: true });
validatePackageCatalog(catalog);

const packageIds = new Set(catalog.map((pkg) => pkg.id));
assert(
  !catalog.some((pkg) => pkg.origin === "built-in" && pkg.defaultEnabled),
  "built-in packages should all be off by default",
);
for (const id of ["telemetry", "caveman", "plan-suite", "session-close"]) {
  assert(packageIds.has(id), `missing package: ${id}`);
}
const planSuite = catalog.find((pkg) => pkg.id === "plan-suite");
assert(planSuite, "missing package: plan-suite");
assert(!(planSuite.urls || []).length, "Plan Suite should not expose external links");
assert(!packageIds.has("code-intel"), "Code Intelligence composite package should not be present");

const slashNames = loadSlashCommandPlan().commands.map((command) => command.name).sort();
for (const name of ["case-study", "plan-write", "tighten", "session-close", "plan-promote", "plan-execute", "plan-review", "plan-close", "plan-archive"]) {
  assert(slashNames.includes(name), `missing slash command: ${name}`);
}

const snapshot = readConfigSnapshot();
const sections = new Map(snapshot.behaviorView.map((section) => [section.category, section]));

// Every category in the manifest that owns at least one package must reach the rendered view.
//
// Derived from the manifest rather than listed, so adding a category extends the assertion for
// free. This is a regression guard, not a reproduction: three categories once shipped invisible
// because portal/config/state.js kept a second hard-coded category->template map
// (SECTION_TEMPLATE_ID) that a new category had to be added to by hand. Commit 8c82f6e deleted that
// map and made the portal render from this manifest, so the failure is structurally gone. What this
// catches is a future reintroduction of per-category wiring anywhere between manifest and view.
//
// Categories with no packages are skipped: buildBehaviorView filters empty sections deliberately,
// so an unused category is absent by design, not by failure.
const categories = JSON.parse(
  fs.readFileSync(path.join(moduleDir, "../../manifests/inventory/package-categories.json"), "utf8"),
).categories;
const populated = new Set(catalog.map((pkg) => pkg.presentation?.category).filter(Boolean));
for (const category of categories) {
  if (!populated.has(category.id)) continue;
  assert(
    sections.has(category.label),
    `category "${category.id}" (${category.label}) has packages but renders no section — `
      + "every populated manifest category must appear in behaviorView",
  );
}

// Non-package sections are appended by buildBehaviorView rather than coming from the manifest, so
// they need their own assertion — the loop above cannot see them.
for (const label of ["Permissions", "Local Stores"]) {
  assert(sections.has(label), `missing ${label} section`);
}

assert(sections.get("Writing Assistants"), "Writing Assistants category label should be updated");
assert(snapshot.behaviorView.findIndex((section) => section.category === "Writing Assistants")
  > snapshot.behaviorView.findIndex((section) => section.category === "Code Conventions"),
"Writing Assistants should follow Code Conventions");
assert(snapshot.behaviorView.filter((section) => section.categoryId).slice(0, 2).map((section) => section.category).join(",")
  === "Code Conventions,Chat-Time Output",
"Code Conventions and Chat-Time Output should be the first two package sections");
assert(sections.get("Chat-Time Output").items.slice(0, 2).map((item) => item.id).join(",") === "response-output,feature-verification",
  "Response Output and Feature Verification should lead Chat-Time Output");
const tokenItems = sections.get("Token Optimization").items.map((item) => item.id);
assert(tokenItems.indexOf("caveman") < tokenItems.indexOf("tool-call-optimization"),
  "Caveman Plugin should precede Tool Call Optimization");
assert(sections.get("Code Conventions").items.at(-1)?.id === "tighten", "tighten should be last in Code Conventions");
assert(sections.get("Code Conventions").items.findIndex((item) => item.id === "react")
  < sections.get("Code Conventions").items.findIndex((item) => item.id === "test-harness"),
"React should precede Test Harness");
assert(sections.get("Code Conventions").items.findIndex((item) => item.id === "test-harness")
  < sections.get("Code Conventions").items.findIndex((item) => item.id === "supabase-integration-testing"),
"Test Harness should precede Supabase Integration Testing");
assert(sections.get("Additional Agent Rules").items.map((item) => item.id).join(",") === "branch-safety,capture-dense-bash",
  "Additional Agent Rules should contain Branch Safety and Capture Dense Bash in order");
assert(snapshot.behaviorView.findIndex((section) => section.category === "Additional Agent Rules")
  > snapshot.behaviorView.findIndex((section) => section.category === "Chat-Time Output"),
"Additional Agent Rules should follow Chat-Time Output");
assert(snapshot.behaviorView.filter((section) => section.categoryId).at(-1)?.category === "Additional Agent Rules",
  "Additional Agent Rules should be the final package section");
assert(sections.get("Development Workflows").items.map((item) => item.id).join(",") === "plan-suite,session-close",
  "the Development Workflows section holds the plan-suite package, then session-close");
assert(!sections.get("Development Workflows").bulkToggle, "Development Workflows has no Select All switch");

// A package with several skills is labeled by its package label, carries a skill-count badge, and
// opens a contents view whose entries each carry the inspect target a single-skill card would have.
// A single-skill package keeps today's shape: its command label and command-skill inspect target.
{
  const items = new Map(sections.get("Development Workflows").items.map((item) => [item.id, item]));
  const suite = items.get("plan-suite");
  assert(suite.label === "Development Planning Lifecycle", `plan-suite card label should be its package label, got ${suite.label}`);
  assert(suite.description !== sections.get("Development Workflows").description, "the package and its category describe different things");
  assert(suite.badges.includes("6 skills"), `plan-suite card should carry a 6 skills badge: ${suite.badges}`);
  assert(suite.inspect?.kind === "package-contents", "plan-suite card label should open the contents view");
  assert(suite.inspect.summary === "6 skills · 1 rules fragment", `contents summary: ${suite.inspect.summary}`);
  const entries = suite.inspect.entries;
  assert(entries.map((entry) => entry.label).join(",") === "/plan-write,/plan-promote,/plan-execute,/plan-review,/plan-close,/plan-archive,Rules",
    `contents entries: ${entries.map((entry) => entry.label)}`);
  for (const entry of entries.slice(0, 6)) {
    const id = entry.label.slice(1);
    assert(entry.inspect.kind === "command-skill" && entry.inspect.id === id && entry.inspect.skill === id, `${id} entry opens its command and skill`);
    assert(entry.description && !/\n/.test(entry.description), `${id} entry has a one-line description`);
    assert(entry.contextCost?.onDemandTokens > 0, `${id} entry carries its own on-demand cost`);
  }
  const rules = entries.at(-1);
  assert(rules.inspect.kind === "rules" && rules.inspect.id === "plan-suite", "rules entry opens the package's rules source");
  assert(rules.description === "Code Outlives Plans", `rules entry describes the fragment by its heading: ${rules.description}`);
  assert(rules.contextCost?.rulesTokens > 0, "rules entry carries its own cost");
  const totals = Object.values(snapshot.contextCost.packages["plan-suite"].resources);
  // Each entry shows its own harness maximum, so together they cover the package total and can
  // exceed it only when harnesses differ per resource.
  const entrySum = totals.reduce((sum, r) => sum + r.onDemandTokens, 0);
  assert(entrySum >= suite.contextCost.onDemandTokens, "entry costs cover the package cost");
  if (!suite.contextCost.harnessesDiffer) assert(entrySum === suite.contextCost.onDemandTokens, "entry costs add up to the package cost when harnesses agree");

  const single = items.get("session-close");
  assert(single.label === "/session-close" && single.inspect?.kind === "command-skill",
    "a single-skill package keeps its command label and command-skill inspect target");
  assert(!single.badges.some((badge) => /skills$/.test(badge)), "a single-skill package gets no skill-count badge");
}

const libraryStepTitles = new Set(buildOnboardSteps().map((step) => step.title));
for (const section of snapshot.behaviorView) {
  const packageItems = (section.items || []).filter((item) => item.toggle === "package");
  if (packageItems.length === 0) continue;
  assert(
    libraryStepTitles.has(section.category),
    `CLI Package Library omits package section "${section.category}" — `
      + "terminal and portal package management must render from behaviorView, not a hard-coded category list",
  );
}

// Every item `kind` buildBehaviorView emits must be handled by every consumer that branches on it.
//
// The kinds are read off the live view, so a new one is covered the moment it ships — the point is
// to fail on the kind nobody wired up, which is exactly the case a hard-coded list would miss.
// Renaming a kind in config.mjs without updating a consumer silently drops those rows from that
// surface: the CLI printer falls through to its generic package branch and prints a checkbox for
// something that is not a package, and the portal renders an empty row. Both are quiet failures
// that look like styling bugs, so they are worth catching here rather than by eye.
//
// Consumers are matched by source text rather than executed: printConfigStatus writes to stdout and
// the portal templates need a DOM, so neither can be called from a plain node check. A string match
// is coarse, but it is checking a literal that must appear in a branch either way.
const consumers = [
  { path: "scripts/cli/config-cli-print.mjs", label: "CLI printer (printConfigStatus)" },
  { path: "portal/config/templates.js", label: "portal templates (permissionRow/renderSection)" },
];
// Kinds whose rows are rendered by a section-level template rather than a per-item branch, so no
// consumer names them. Keep this list short — an entry here is an assertion deliberately waived.
const sectionRenderedKinds = new Set(["store"]);
const emittedKinds = new Set(
  snapshot.behaviorView
    .flatMap((section) => section.items || [])
    .map((item) => item.kind)
    .filter(Boolean),
);
for (const consumer of consumers) {
  const source = fs.readFileSync(path.join(moduleDir, "../..", consumer.path), "utf8");
  for (const kind of emittedKinds) {
    if (sectionRenderedKinds.has(kind)) continue;
    assert(
      source.includes(`"${kind}"`),
      `buildBehaviorView emits item kind "${kind}" but ${consumer.label} never branches on it — `
        + `those rows render blank or fall through to the wrong branch in ${consumer.path}`,
    );
  }
}

// No source file may branch on a package category id that the manifest does not define.
//
// validatePackageCatalog already rejects a PACKAGE naming an unknown category, but nothing checked
// CODE that hardcodes one. config.mjs branched on `presentation?.category === "commands"` long after
// commit ac35c97 deleted that category, so the condition was permanently false and every
// command-backed package silently lost its `/command` label — no test failed, because the data was
// valid and only the consumer was stale. This is the same failure shape as the kind check above: a
// second declaration of a name that must agree with the manifest.
//
// Matched by source text rather than executed, for the same reason as the consumer scan: these are
// literals inside branches, and reaching them all would need a DOM and a stdout capture. Only
// category-shaped comparisons are inspected, so unrelated `category` fields (telemetry operation
// categories, for instance) are not swept in.
const packageCategoryIds = new Set(categories.map((category) => category.id));
const categoryComparison = /\bcategory\s*(?:===|!==)\s*"([a-z][a-z0-9-]*)"/g;
const categoryConsumers = [
  "scripts/cli/config.mjs",
  "scripts/cli/config-cli-print.mjs",
  "scripts/cli/package-catalog.mjs",
  "portal/config/templates.js",
  "portal/config/state.js",
];
for (const relPath of categoryConsumers) {
  const fullPath = path.join(moduleDir, "../..", relPath);
  if (!fs.existsSync(fullPath)) continue;
  const source = fs.readFileSync(fullPath, "utf8");
  for (const [, id] of source.matchAll(categoryComparison)) {
    assert(
      packageCategoryIds.has(id),
      `${relPath} branches on package category "${id}", which manifests/inventory/`
        + "package-categories.json does not define — that comparison can never be true, so the rows "
        + "it governs silently render the wrong way",
    );
  }
}

// The Permissions section splits on authorship (customized vs shipped default), not on item kind.
// customizedCount is the boundary both the portal and the CLI printer read, so it must agree with
// the items themselves rather than being computed twice and drifting.
const permissions = sections.get("Permissions");
assert(
  permissions.customizedCount === permissions.items.filter((item) => item.overridden).length,
  "Permissions customizedCount disagrees with the number of overridden items",
);
// A delete affordance on a row with no override would revert something the user never set.
for (const item of permissions.items) {
  assert(
    Boolean(item.deletable) === Boolean(item.overridden),
    `permission "${item.label}" has deletable=${item.deletable} but overridden=${item.overridden} — `
      + "delete must appear on exactly the customized rows",
  );
}

// The defaults list groups by category, so an entry whose category is missing from the taxonomy
// falls into a catch-all "Other" bucket. That is a safety net, not a destination: every shipped
// entry should file under a real category, and a new behavior added without one should fail here
// rather than quietly landing in Other.
const categoryIds = new Set((permissions.categories || []).map((category) => category.id));
assert(categoryIds.size > 0, "Permissions section exposes no category taxonomy");
for (const item of permissions.items) {
  assert(
    item.category && categoryIds.has(item.category),
    `permission "${item.label}" has category=${JSON.stringify(item.category)}, which is not in the `
      + `manifest taxonomy (${[...categoryIds].join(", ")}) — add a category to its manifest entry`,
  );
}
// Categories arrive pre-sorted so consumers render them in manifest order without re-sorting.
const orders = (permissions.categories || []).map((category) => category.order ?? 99);
assert(
  orders.every((value, i) => i === 0 || orders[i - 1] <= value),
  "permission categories are not sorted by order — consumers render them as given",
);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-package-catalog-"));
try {
  fs.mkdirSync(path.join(tempRoot, "manifests", "inventory"), { recursive: true });
  fs.writeFileSync(
    path.join(tempRoot, "manifests", "inventory", "package-categories.json"),
    JSON.stringify({ schemaVersion: 1, categories: [{ id: "commands", label: "Commands", order: 1 }] }),
  );
  fs.mkdirSync(path.join(tempRoot, "globals", "packages", "legacy-shape"), { recursive: true });
  fs.writeFileSync(path.join(tempRoot, "globals", "packages", "legacy-shape", "package.config.json"), JSON.stringify({
    schemaVersion: 1,
    id: "legacy-shape",
    label: "Legacy Shape",
    description: "Legacy package shape.",
    presentation: { category: "skills-dev-lifecycle" },
    components: [],
  }));
  const result = spawnSync(process.execPath, [
    "-e",
    `import(${JSON.stringify(path.resolve("scripts/cli/package-catalog.mjs"))}).then((m) => { try { m.loadPackageCatalog({ includeUnavailable: true }); process.exit(1); } catch (err) { process.exit(String(err.message).includes("resources must be an array") ? 0 : 1); } })`,
  ], {
    env: { ...process.env, ROBOREPO_APP_ROOT: tempRoot, ROBOREPO_STATE_ROOT: path.join(tempRoot, "state") },
    stdio: "ignore",
  });
  assert(result.status === 0, "package configs with legacy components should be rejected");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

// A package may hold several skills, and each skill ID is still claimed by exactly one package: a
// second package naming one of the fixture's skills must fail validation.
const multiSkillRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-package-multi-skill-"));
try {
  fs.cpSync(path.resolve("manifests"), path.join(multiSkillRoot, "manifests"), { recursive: true });
  fs.mkdirSync(path.join(multiSkillRoot, "globals", "packages"), { recursive: true });
  fs.cpSync(path.resolve("globals/harnesses"), path.join(multiSkillRoot, "globals", "harnesses"), { recursive: true });
  writeMultiSkillPackage(path.join(multiSkillRoot, "globals", "packages"));
  const validateIn = () => spawnSync(process.execPath, [
    "-e",
    `import(${JSON.stringify(path.resolve("scripts/cli/package-catalog.mjs"))}).then((m) => { try { const c = m.loadPackageCatalog({ includeUnavailable: true }); m.validatePackageCatalog(c); console.log(JSON.stringify(c.map((p) => [p.id, p.resources.filter((r) => r.type === "skill").map((r) => r.id)]))); } catch (err) { console.error(err.message); process.exit(1); } })`,
  ], {
    env: { ...process.env, ROBOREPO_APP_ROOT: multiSkillRoot, ROBOREPO_STATE_ROOT: path.join(multiSkillRoot, "state") },
    encoding: "utf8",
  });
  const clean = validateIn();
  assert(clean.status === 0, `a package with two skills and a rules fragment should validate: ${clean.stderr}`);
  assert(
    JSON.stringify(JSON.parse(clean.stdout)) === JSON.stringify([[MULTI_SKILL_PACKAGE_ID, MULTI_SKILL_IDS]]),
    `the fixture package should load both skills in order: ${clean.stdout}`,
  );

  const rivalDir = path.join(multiSkillRoot, "globals", "packages", "duo-rival");
  fs.mkdirSync(path.join(rivalDir, "skills", "duo-helper"), { recursive: true });
  fs.writeFileSync(path.join(rivalDir, "skills", "duo-helper", "SKILL.md"), "---\nname: duo-helper\ndescription: Rival.\n---\n");
  fs.writeFileSync(path.join(rivalDir, "package.config.json"), JSON.stringify({
    schemaVersion: 1,
    id: "duo-rival",
    label: "Duo Rival",
    description: "Claims a skill another package owns.",
    presentation: { category: "skills-dev-lifecycle" },
    resources: [{ type: "skill", id: "duo-helper", source: "skills/duo-helper", invocation: "auto" }],
  }));
  const claimed = validateIn();
  assert(claimed.status !== 0 && /duo-helper/.test(claimed.stderr), `a skill ID claimed by two packages should fail validation: ${claimed.stderr}`);
} finally {
  fs.rmSync(multiSkillRoot, { recursive: true, force: true });
}

const scaffoldWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-package-scaffold-"));
try {
  const cliPath = path.resolve("scripts/cli/main.mjs");
  const env = { ...process.env, ROBOREPO_MODE: "package", ROBOREPO_WORKSPACE_ROOT: scaffoldWorkspace, ROBOREPO_STATE_ROOT: path.join(scaffoldWorkspace, "state") };
  const create = spawnSync(process.execPath, [cliPath, "package", "dev", "create", "scaffold-check", "--kind=auto-skill"], { env, encoding: "utf8" });
  assert(create.status === 0, `package dev create should succeed: ${create.stderr}\n${create.stdout}`);
  assert(create.stdout.includes("next: roborepo package validate scaffold-check"), "create should print the next validate command");
  assert(fs.existsSync(path.join(scaffoldWorkspace, "packages", "scaffold-check", "package.config.json")), "scaffolded package.config.json should exist in the workspace");

  const validate = spawnSync(process.execPath, [cliPath, "package", "validate", "scaffold-check"], { env, encoding: "utf8" });
  assert(validate.status === 0, `scaffolded package should validate clean: ${validate.stderr}\n${validate.stdout}`);

  const collision = spawnSync(process.execPath, [cliPath, "package", "dev", "create", "scaffold-check", "--kind=auto-skill"], { env, encoding: "utf8" });
  assert(collision.status !== 0, "package dev create should refuse to overwrite an existing package");
} finally {
  fs.rmSync(scaffoldWorkspace, { recursive: true, force: true });
}

// Development-checkout mode: `roborepo package dev create` must scaffold directly into
// globals/packages/ (the real shared source), not a workspace dir.
const devRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-package-scaffold-dev-"));
try {
  fs.mkdirSync(path.join(devRoot, ".git"), { recursive: true });
  fs.cpSync(path.resolve("manifests"), path.join(devRoot, "manifests"), { recursive: true });
  // module-loader.mjs resolves "module" adapter commands (package dev create, ...) relative to
  // appRoot, mirroring the real npm package layout (scripts/cli/ ships under the install root) — so
  // a spawned CLI subprocess under a fake appRoot needs scripts/ too, not just manifests/.
  fs.cpSync(path.resolve("scripts"), path.join(devRoot, "scripts"), { recursive: true });
  // package-catalog.mjs resolves harnesses through scripts/harnesses/registry.mjs, whose Claude
  // and Codex provider modules read their manifest from globals/harnesses/<id>/provider.json —
  // needed here too, same gap test-cli.sh sandboxes have.
  fs.mkdirSync(path.join(devRoot, "globals"), { recursive: true });
  fs.cpSync(path.resolve("globals/harnesses"), path.join(devRoot, "globals", "harnesses"), { recursive: true });
  const cliPath = path.resolve("scripts/cli/main.mjs");
  const env = { ...process.env, ROBOREPO_MODE: "development", ROBOREPO_APP_ROOT: devRoot, ROBOREPO_STATE_ROOT: path.join(devRoot, "state") };
  const create = spawnSync(process.execPath, [cliPath, "package", "dev", "create", "dev-scaffold-check", "--kind=empty"], { env, encoding: "utf8" });
  assert(create.status === 0, `dev-mode package dev create should succeed: ${create.stderr}\n${create.stdout}`);
  assert(
    fs.existsSync(path.join(devRoot, "globals", "packages", "dev-scaffold-check", "package.config.json")),
    "dev-mode scaffold should write into globals/packages/, not a workspace dir",
  );
} finally {
  fs.rmSync(devRoot, { recursive: true, force: true });
}

// Package relationships and selectability: valid graphs pass; unknown or self-referencing ids,
// `requires` cycles, and a non-selectable default-enabled package fail. `recommends` cycles are fine.
{
  const node = (id, extra = {}) => ({
    id, presentation: { category: "code-conventions" }, resources: [], requires: [], recommends: [], selectable: true, ...extra,
  });
  const rejects = (packages, fragment, label) => {
    let message = "";
    try { validatePackageCatalog(packages); } catch (err) { message = String(err.message); }
    assert(message.includes(fragment), `${label}: expected "${fragment}", got "${message}"`);
  };
  validatePackageCatalog([
    node("parent", { requires: ["dep"], recommends: ["companion"] }),
    node("dep", { selectable: false }),
    node("companion", { recommends: ["parent"] }),
  ]);
  rejects([node("a", { requires: ["ghost"] })], "a: missing required package: ghost", "unknown required id");
  rejects([node("a", { recommends: ["ghost"] })], "a: missing recommended package: ghost", "unknown recommended id");
  rejects([node("a", { recommends: ["Bad Id"] })], "a: invalid recommended package id", "invalid recommended id");
  rejects([node("a", { requires: ["a"] })], "a: package cannot list itself in requires", "self-required");
  rejects([node("a", { recommends: ["a"] })], "a: package cannot list itself in recommends", "self-recommended");
  rejects([node("a", { requires: ["b"] }), node("b", { requires: ["a"] })], "package dependency cycle: a -> b -> a", "requires cycle");
  rejects([node("a", { selectable: false, defaultEnabled: true })], "a: a package with selectable: false cannot be defaultEnabled", "non-selectable default");

  for (const pkg of catalog) {
    assert(pkg.selectable === true || pkg.selectable === false, `${pkg.id}: selectable should normalize to a boolean`);
    assert(["catalog", "dependency", "hidden"].includes(pkg.presentation.visibility), `${pkg.id}: visibility should normalize`);
    assert(Array.isArray(pkg.recommends), `${pkg.id}: recommends should normalize to an array`);
  }

  const shapeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-package-shape-"));
  try {
    fs.cpSync(path.resolve("manifests"), path.join(shapeRoot, "manifests"), { recursive: true });
    fs.cpSync(path.resolve("globals/harnesses"), path.join(shapeRoot, "globals", "harnesses"), { recursive: true });
    const loadWith = (config) => {
      const dir = path.join(shapeRoot, "globals", "packages", "shape-check");
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "package.config.json"), JSON.stringify({
        schemaVersion: 1, id: "shape-check", label: "Shape Check", description: "Shape check.",
        presentation: { category: "code-conventions" }, resources: [], ...config,
      }));
      return spawnSync(process.execPath, [
        "-e",
        `import(${JSON.stringify(path.resolve("scripts/cli/package-catalog.mjs"))}).then((m) => { const p = m.loadPackageCatalog({ includeUnavailable: true })[0]; console.log(JSON.stringify([p.selectable, p.presentation.visibility, p.recommends])); }).catch((err) => { console.error(err.message); process.exit(1); })`,
      ], { env: { ...process.env, ROBOREPO_APP_ROOT: shapeRoot, ROBOREPO_STATE_ROOT: path.join(shapeRoot, "state") }, encoding: "utf8" });
    };
    const defaults = loadWith({});
    assert(defaults.status === 0 && defaults.stdout.trim() === JSON.stringify([true, "catalog", []]), `defaults: ${defaults.stderr}${defaults.stdout}`);
    const dependencyOnly = loadWith({ selectable: false, presentation: { category: "code-conventions", visibility: "dependency" } });
    assert(dependencyOnly.stdout.trim() === JSON.stringify([false, "dependency", []]), `dependency-only: ${dependencyOnly.stderr}`);
    assert(loadWith({ selectable: "no" }).stderr.includes("selectable must be a boolean"), "a non-boolean selectable should be rejected");
    assert(loadWith({ presentation: { category: "code-conventions", visibility: "secret" } }).stderr.includes("presentation.visibility must be one of"), "an unknown visibility should be rejected");
    assert(loadWith({ recommends: "test-harness" }).stderr.includes("recommends must be an array"), "a non-array recommends should be rejected");
  } finally {
    fs.rmSync(shapeRoot, { recursive: true, force: true });
  }
}

console.log("ok: package catalog behavior");
