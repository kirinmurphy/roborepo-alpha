#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
// package.json declares node >=20 and moduleDir only landed in 20.11, so it is undefined
// on a supported floor version. The rest of this repo derives the directory this way.
import { fileURLToPath } from "node:url";
import { loadPackageCatalog, validatePackageCatalog } from "../cli/package-catalog.mjs";
import { listPackageCommands } from "../cli/package-commands.mjs";
import { loadSlashCommandPlan } from "../cli/slash-commands.mjs";
import { readConfigSnapshot } from "../cli/config.mjs";
import { buildOnboardSteps } from "../cli/presets.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const catalog = loadPackageCatalog({ includeUnavailable: true });
validatePackageCatalog(catalog);

const packageIds = new Set(catalog.map((pkg) => pkg.id));
for (const id of ["jcodemunch", "jdocmunch", "telemetry", "caveman", "plan-promote", "plan-start"]) {
  assert(packageIds.has(id), `missing package: ${id}`);
}
assert(!packageIds.has("code-intel"), "Code Intelligence composite package should not be present");

const commands = listPackageCommands({ includeUnavailable: true }).map((command) => command.name).sort();
for (const name of ["index code", "index docs", "watch code"]) {
  assert(commands.includes(name), `missing package CLI command: ${name}`);
}

const slashNames = loadSlashCommandPlan().commands.map((command) => command.name).sort();
for (const name of ["case-study", "plan-write", "tighten", "session-close", "plan-promote", "plan-start", "plan-close"]) {
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

assert(sections.get("Token Optimization").items.some((item) => item.id === "jcodemunch"), "jcodemunch not visible in Token Optimization");
assert(sections.get("Skills - Code Quality").items.some((item) => item.id === "tighten"), "tighten not visible in Skills - Code Quality");
assert(sections.get("Plan Suite").items.map((item) => item.id).join(",") === "plan-write,plan-promote,plan-start,plan-close,session-close",
  "the Plan Suite section lists the five suite commands in lifecycle order");

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
    env: { ...process.env, ROBOREPO_APP_ROOT: tempRoot, ROBOREPO_STATE_DIR: path.join(tempRoot, "state") },
    stdio: "ignore",
  });
  assert(result.status === 0, "package configs with legacy components should be rejected");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

const scaffoldWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-package-scaffold-"));
try {
  const cliPath = path.resolve("scripts/cli/main.mjs");
  const env = { ...process.env, ROBOREPO_MODE: "package", ROBOREPO_WORKSPACE_ROOT: scaffoldWorkspace, ROBOREPO_STATE_DIR: path.join(scaffoldWorkspace, "state") };
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
// globals/packages/ (the real shared source), not a workspace dir — mirrors skill-new.mjs's
// packageMode ? workspaceSkillsDir : sharedSkillsDir branch.
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
  // needed here too, same gap the Phase 3 grounding notes describe for test-cli.sh sandboxes.
  fs.mkdirSync(path.join(devRoot, "globals"), { recursive: true });
  fs.cpSync(path.resolve("globals/harnesses"), path.join(devRoot, "globals", "harnesses"), { recursive: true });
  const cliPath = path.resolve("scripts/cli/main.mjs");
  const env = { ...process.env, ROBOREPO_MODE: "development", ROBOREPO_APP_ROOT: devRoot, ROBOREPO_STATE_DIR: path.join(devRoot, "state") };
  const create = spawnSync(process.execPath, [cliPath, "package", "dev", "create", "dev-scaffold-check", "--kind=empty"], { env, encoding: "utf8" });
  assert(create.status === 0, `dev-mode package dev create should succeed: ${create.stderr}\n${create.stdout}`);
  assert(
    fs.existsSync(path.join(devRoot, "globals", "packages", "dev-scaffold-check", "package.config.json")),
    "dev-mode scaffold should write into globals/packages/, not a workspace dir",
  );
} finally {
  fs.rmSync(devRoot, { recursive: true, force: true });
}

console.log("ok: package catalog behavior");
