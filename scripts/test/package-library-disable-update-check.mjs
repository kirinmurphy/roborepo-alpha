#!/usr/bin/env node
// Regression for the Package Library wizard apply path: package-backed rows must persist an explicit
// disabled entry, and a later package reconciliation must not silently restore the disabled package.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repoRoot, "scripts/cli/main.mjs");
const packageId = "supabase-integration-testing";

function makeHome() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-package-library-"));
  fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(tmp, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".claude", "settings.json"), "{}");
  fs.writeFileSync(path.join(tmp, ".codex", "config.toml"), "");
  return tmp;
}

function runNode(args, env, label) {
  const result = spawnSync(process.execPath, args, { env, encoding: "utf8" });
  assert.equal(result.status, 0, `${label} should succeed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

function assertSkillAbsent(home, label) {
  for (const rel of [
    [".roborepo", "skills", packageId],
    [".claude", "skills", packageId],
    [".codex", "skills", packageId],
  ]) {
    assert.equal(fs.existsSync(path.join(home, ...rel)), false, `${label}: ${rel.join("/")} should be absent`);
  }
}

const home = makeHome();
const env = {
  ...process.env,
  HOME: home,
  ROBOREPO_STATE_ROOT: path.join(home, ".roborepo"),
  SKIP_MCP: "1",
};

try {
  runNode([cli, "package", "enable", packageId], env, "initial package enable");
  assert.equal(
    fs.existsSync(path.join(home, ".roborepo", "skills", packageId)),
    true,
    "enabled package should install its managed skill cache",
  );

  const applyWizard = `
const steps = [{
  title: "Code Conventions",
  items: [{
    label: "Supabase Integration Testing",
    active: false,
    wasActive: true,
    toggleable: true,
    section: { category: "Code Conventions" },
    item: { id: ${JSON.stringify(packageId)}, toggle: "package", label: "Supabase Integration Testing" },
  }],
}];
const { applyWizardChanges } = await import(${JSON.stringify(path.join(repoRoot, "scripts", "cli", "presets.mjs"))});
const result = await applyWizardChanges(steps);
if (!result.applied || !result.changed || result.failed) process.exit(1);
`;
  const wizard = runNode(["-e", applyWizard], env, "Package Library-equivalent wizard apply");
  assert.match(wizard.stdout, /disable supabase-integration-testing .* ok/, "wizard path disables the package-backed row");

  const registryPath = path.join(home, ".roborepo", "enabled-packages.json");
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  assert.ok(registry.disabled.includes(packageId), "explicit disabled entry is recorded");
  assert.ok(!registry.packages.includes(packageId), "explicit enabled entry is cleared");
  assertSkillAbsent(home, "after wizard disable");

  runNode([cli, "package", "reconcile"], env, "package reconcile after explicit disable");
  const registryAfterReconcile = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  assert.ok(registryAfterReconcile.disabled.includes(packageId), "explicit disabled entry survives reconcile");
  assert.ok(!registryAfterReconcile.packages.includes(packageId), "package remains absent from explicit enables after reconcile");
  assertSkillAbsent(home, "after reconcile");
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("ok: Package Library package disable survives reconcile");