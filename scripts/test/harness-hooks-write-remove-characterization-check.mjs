#!/usr/bin/env node
// Characterization test for the Claude provider's hooks.write (removal semantics) adapter
// (scripts/harnesses/claude/index.mjs), ported from scripts/install/uninstall.sh's
// strip_package_hooks. Pins: strips hook entries matching a claude-harness "hooks" resource's
// commands from every event array (deleting the event key entirely once empty), strips permission
// allow-entries matching a "permissions" resource's allow list, both in one settings.json read/
// write pass, and leaves unrelated hooks/permissions/settings keys untouched.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { claudeProvider } = await import("../harnesses/claude/index.mjs");

// hooksWriteRemove reads packages from a fixed repoRoot-relative path (globals/packages), not a
// parameter, so a fully isolated unit test can't substitute fixture packages without chdir'ing the
// whole process. Exercise it against a real package already in this repo (jcodemunch, which
// declares both a claude hooks resource and a permissions resource) instead.
function testStripsRealPackageHooksAndPermissions() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-hooks-write-remove-real-"));
  const homePath = path.join(tmp, ".claude");
  fs.mkdirSync(homePath, { recursive: true });
  const settingsPath = path.join(homePath, "settings.json");

  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
  const pkgConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, "globals", "packages-archived", "jcodemunch", "package.config.json"), "utf8"));
  const hooksResource = pkgConfig.resources.find((r) => r.type === "hooks" && r.harness === "claude");
  const permissionsResource = pkgConfig.resources.find((r) => r.type === "permissions");
  const fragment = JSON.parse(fs.readFileSync(path.join(repoRoot, "globals", "packages-archived", "jcodemunch", hooksResource.source), "utf8"));
  const firstEvent = Object.keys(fragment)[0];
  const firstCommand = fragment[firstEvent][0].hooks[0].command;

  fs.writeFileSync(settingsPath, JSON.stringify({
    hooks: { [firstEvent]: [{ hooks: [{ command: firstCommand }] }, { hooks: [{ command: "node user-owned.mjs" }] }] },
    permissions: { allow: [...permissionsResource.allow, "user-owned-permission"] },
  }));

  const result = claudeProvider.adapters.hooks.write({ homePath });
  assert.equal(result.ok, true);
  assert.equal(result.changed, true, "must report changed when it stripped a real package's hooks/permissions");

  const after = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const remainingCommands = (after.hooks?.[firstEvent] || []).flatMap((e) => e.hooks.map((h) => h.command));
  assert.ok(!remainingCommands.includes(firstCommand), "must strip the package-owned hook command");
  assert.ok(remainingCommands.includes("node user-owned.mjs"), "must keep a hook command the package doesn't own");
  assert.ok(!after.permissions.allow.some((p) => permissionsResource.allow.includes(p)), "must strip every package-owned permission");
  assert.ok(after.permissions.allow.includes("user-owned-permission"), "must keep a permission the package doesn't own");

  fs.rmSync(tmp, { recursive: true, force: true });
}

function testNoPackagesMatchIsNoop() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-hooks-write-remove-noop-"));
  const homePath = path.join(tmp, ".claude");
  fs.mkdirSync(homePath, { recursive: true });
  const settingsPath = path.join(homePath, "settings.json");
  const before = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: "node totally-unmanaged.mjs" }] }] } });
  fs.writeFileSync(settingsPath, before);

  const result = claudeProvider.adapters.hooks.write({ homePath });
  assert.equal(result.changed, false, "no matching package resource must mean no change");
  assert.equal(fs.readFileSync(settingsPath, "utf8"), before, "file content must be untouched when nothing matches");

  fs.rmSync(tmp, { recursive: true, force: true });
}

function testMissingSettingsIsNoop() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-hooks-write-remove-missing-"));
  const homePath = path.join(tmp, ".claude");
  fs.mkdirSync(homePath, { recursive: true });

  const result = claudeProvider.adapters.hooks.write({ homePath });
  assert.equal(result.ok, true, "missing settings.json must not be reported as a failure");
  assert.equal(result.changed, false);

  fs.rmSync(tmp, { recursive: true, force: true });
}

testStripsRealPackageHooksAndPermissions();
testNoPackagesMatchIsNoop();
testMissingSettingsIsNoop();

console.log("harness Claude hooks.write (removal) characterization: all checks passed");
