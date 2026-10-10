#!/usr/bin/env node
// Characterizes package-catalog.mjs's harness validation (validateHarness/validateHarnesses),
// then pins that it now resolves against the harness-provider registry
// (scripts/harnesses/registry.mjs) instead of a hardcoded local Set, so
// HARNESSES/SLASH_COMMAND_HARNESSES cannot drift apart as independently maintained closed sets.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-package-catalog-harness-"));
const appRoot = path.join(tmp, "app");
const workspace = path.join(tmp, "workspace");

fs.mkdirSync(path.join(appRoot, "manifests", "inventory"), { recursive: true });
fs.writeFileSync(
  path.join(appRoot, "manifests", "inventory", "package-categories.json"),
  JSON.stringify({ schemaVersion: 1, categories: [{ id: "skills-dev-lifecycle", label: "Skills - Development Life Cycle", order: 1 }] }, null, 2),
);
fs.writeFileSync(path.join(appRoot, "package.json"), JSON.stringify({ version: "9.9.9" }, null, 2));

function writePackage(id, resource) {
  const root = path.join(appRoot, "globals", "packages", id);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.config.json"),
    JSON.stringify({
      schemaVersion: 1,
      id,
      label: id,
      description: `${id} package.`,
      lifecycle: "optional",
      presentation: { category: "skills-dev-lifecycle", order: 1 },
      resources: resource ? [resource] : [],
    }, null, 2),
  );
  return root;
}

// harness-config resource with an unknown harness id must be rejected.
const badRoot = writePackage("bad-harness-pkg", {
  type: "harness-config",
  source: "hooks.json",
  harness: "totally-not-a-real-harness",
});
fs.writeFileSync(path.join(badRoot, "hooks.json"), "{}");

process.env.HOME = tmp;
process.env.ROBOREPO_APP_ROOT = appRoot;
process.env.ROBOREPO_STATE_ROOT = path.join(tmp, "state");
process.env.ROBOREPO_WORKSPACE_ROOT = workspace;

const { loadPackageCatalog } = await import("../cli/package-catalog.mjs");
const { hasHarnessProvider } = await import("../harnesses/registry.mjs");

assert.throws(
  () => loadPackageCatalog({ includeUnavailable: true }),
  /unknown harness: totally-not-a-real-harness/,
  "unregistered harness id must be rejected",
);

// Registered provider ids (claude, codex) must remain accepted — proves the swap from a hardcoded
// Set to a registry lookup didn't narrow acceptance.
fs.rmSync(badRoot, { recursive: true, force: true });
const goodRoot = writePackage("good-harness-pkg", {
  type: "harness-config",
  source: "hooks.json",
  harness: "codex",
});
fs.writeFileSync(path.join(goodRoot, "hooks.json"), "{}");

const catalog = loadPackageCatalog({ includeUnavailable: true });
assert.ok(catalog.some((pkg) => pkg.id === "good-harness-pkg"), "package with a registered harness id must load");

// The validator must actually be registry-backed (not a second hardcoded set reimplementing the
// same two ids) -- sanity-check the registry itself agrees on both directions.
assert.equal(hasHarnessProvider("claude"), true, "registry must know claude");
assert.equal(hasHarnessProvider("codex"), true, "registry must know codex");
assert.equal(hasHarnessProvider("totally-not-a-real-harness"), false, "registry must reject unknown ids");

fs.rmSync(tmp, { recursive: true, force: true });

// --- Capability gap: a resource targeting a harness whose provider manifest doesn't declare the
// capability that resource type needs must fail validation, not silently no-op at install time.
// Both real providers (claude/codex) currently declare the same capability set, so this can only
// be proven with a fabricated provider manifest missing "hooks" -- a fresh process/module registry
// is required since registry.mjs's PROVIDERS map is a static import-time Map. ---
const capTmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-package-catalog-harness-cap-"));
const capAppRoot = path.join(capTmp, "app");
const capWorkspace = path.join(capTmp, "workspace");

fs.mkdirSync(path.join(capAppRoot, "manifests", "inventory"), { recursive: true });
fs.writeFileSync(
  path.join(capAppRoot, "manifests", "inventory", "package-categories.json"),
  JSON.stringify({ schemaVersion: 1, categories: [{ id: "skills-dev-lifecycle", label: "Skills - Development Life Cycle", order: 1 }] }, null, 2),
);
fs.writeFileSync(path.join(capAppRoot, "package.json"), JSON.stringify({ version: "9.9.9" }, null, 2));

// The provider registry, claude/codex manifests, and adapter modules are the app's own
// scripts/harnesses/ and globals/harnesses/ -- point ROBOREPO_APP_ROOT at the real checkout so
// those resolve normally, then overwrite just the codex manifest's capabilities in place inside
// this isolated app root copy.
fs.cpSync(path.resolve("scripts"), path.join(capAppRoot, "scripts"), { recursive: true });
fs.cpSync(path.resolve("globals/harnesses"), path.join(capAppRoot, "globals", "harnesses"), { recursive: true });
const codexManifestPath = path.join(capAppRoot, "globals", "harnesses", "codex", "provider.json");
const codexManifest = JSON.parse(fs.readFileSync(codexManifestPath, "utf8"));
codexManifest.capabilities = codexManifest.capabilities.filter((cap) => cap !== "hooks");
fs.writeFileSync(codexManifestPath, JSON.stringify(codexManifest, null, 2));

function capWritePackage(id, resource) {
  const root = path.join(capAppRoot, "globals", "packages", id);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.config.json"),
    JSON.stringify({
      schemaVersion: 1,
      id,
      label: id,
      description: `${id} package.`,
      lifecycle: "optional",
      presentation: { category: "skills-dev-lifecycle", order: 1 },
      resources: [resource],
    }, null, 2),
  );
  return root;
}

const capRoot = capWritePackage("hooks-needs-codex-hooks", {
  type: "hooks",
  source: "hooks.json",
  harness: "codex",
});
fs.writeFileSync(path.join(capRoot, "hooks.json"), "{}");

// Run in a fresh subprocess against the COPIED scripts/cli/package-catalog.mjs (not the real
// checkout's) -- scripts/harnesses/{claude,codex}/index.mjs resolve globals/harnesses/<id>/
// provider.json relative to their own file's import.meta.url, never via ROBOREPO_APP_ROOT, so the
// edited codex manifest is only visible to a package-catalog.mjs loaded from inside capAppRoot.
const probeScript = path.join(capTmp, "probe.mjs");
fs.writeFileSync(
  probeScript,
  `import { loadPackageCatalog } from ${JSON.stringify(path.join(capAppRoot, "scripts", "cli", "package-catalog.mjs"))};\n` +
  `loadPackageCatalog({ includeUnavailable: true });\n`,
);
const result = spawnSync(process.execPath, [probeScript], {
  encoding: "utf8",
  env: {
    ...process.env,
    HOME: capTmp,
    ROBOREPO_APP_ROOT: capAppRoot,
    ROBOREPO_STATE_ROOT: path.join(capTmp, "state"),
    ROBOREPO_WORKSPACE_ROOT: capWorkspace,
  },
});
assert.notEqual(result.status, 0, "a hooks resource targeting a harness missing the hooks capability must be rejected");
assert.match(
  result.stderr,
  /harness "codex" does not support required capability: hooks/,
  `expected capability-gap error, got: ${result.stderr}`,
);

fs.rmSync(capTmp, { recursive: true, force: true });
console.log("package-catalog-harness-check: ok");
