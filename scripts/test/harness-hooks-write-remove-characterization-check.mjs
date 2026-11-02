#!/usr/bin/env node
// Characterization test for the Claude provider's hooks.write (removal semantics) adapter
// (scripts/harnesses/claude/hooks-withdraw.mjs), ported from scripts/install/uninstall-lib.sh's
// strip_package_hooks. Pins: strips hook entries matching a claude-harness "hooks" resource's
// commands from every event array (deleting the event key entirely once empty), strips permission
// allow-entries matching a "permissions" resource's allow list, both in one settings.json read/
// write pass, and leaves unrelated hooks/permissions/settings keys untouched.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeAppRoot } from "./app-root-fixture.mjs";

// hooksWriteRemove reads packages from the app root, so point it at an isolated copy carrying the
// fixture-tool package (a claude hooks resource plus a permissions resource) before loading it.
const appRoot = makeAppRoot({ prefix: "roborepo-hooks-write-remove-app-", fixturePackages: true });
process.env.ROBOREPO_APP_ROOT = appRoot;
process.on("exit", () => fs.rmSync(appRoot, { recursive: true, force: true }));
const FIXTURE_DIR = path.join(appRoot, "globals", "packages", "fixture-tool");
const { claudeProvider } = await import("../harnesses/claude/index.mjs");

function testStripsRealPackageHooksAndPermissions() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-hooks-write-remove-real-"));
  const homePath = path.join(tmp, ".claude");
  fs.mkdirSync(homePath, { recursive: true });
  const settingsPath = path.join(homePath, "settings.json");

  const pkgConfig = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "package.config.json"), "utf8"));
  const hooksResource = pkgConfig.resources.find((r) => r.type === "hooks" && r.harness === "claude");
  const permissionsResource = pkgConfig.resources.find((r) => r.type === "permissions");
  const fragment = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, hooksResource.source), "utf8"));
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

function testStrippingEveryAllowEntryKeepsOtherPermissionKeys() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-hooks-write-remove-perm-keys-"));
  const homePath = path.join(tmp, ".claude");
  fs.mkdirSync(homePath, { recursive: true });
  const settingsPath = path.join(homePath, "settings.json");

  const pkgConfig = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "package.config.json"), "utf8"));
  const permissionsResource = pkgConfig.resources.find((r) => r.type === "permissions");

  fs.writeFileSync(settingsPath, JSON.stringify({
    permissions: { allow: [...permissionsResource.allow], deny: ["Bash(rm -rf:*)"], ask: ["Bash(git push:*)"], defaultMode: "acceptEdits" },
  }));
  const result = claudeProvider.adapters.hooks.write({ homePath });
  assert.equal(result.changed, true);
  const after = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.equal(after.permissions?.allow, undefined, "must drop the emptied allow list");
  assert.deepEqual(after.permissions?.deny, ["Bash(rm -rf:*)"], "must keep the user's deny rules");
  assert.deepEqual(after.permissions?.ask, ["Bash(git push:*)"], "must keep the user's ask rules");
  assert.equal(after.permissions?.defaultMode, "acceptEdits", "must keep the user's defaultMode");

  fs.writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: [...permissionsResource.allow] } }));
  claudeProvider.adapters.hooks.write({ homePath });
  assert.equal(JSON.parse(fs.readFileSync(settingsPath, "utf8")).permissions, undefined, "must drop permissions once nothing is left in it");

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
testStrippingEveryAllowEntryKeepsOtherPermissionKeys();
testNoPackagesMatchIsNoop();
testMissingSettingsIsNoop();

console.log("harness Claude hooks.write (removal) characterization: all checks passed");
