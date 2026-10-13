#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { configHarnessWarning, hasOptionalPackageSelected } = await import(
  path.join(repoRoot, "portal/config/onboarding-state.js")
);

const catalog = [
  { id: "claude", displayName: "Claude Code" },
  { id: "codex", displayName: "Codex" },
];

{
  const snap = { harnesses: catalog, machineHarnesses: [], packages: [] };
  const notice = configHarnessWarning(snap);
  assert.equal(notice.variant, "warning");
  assert.equal(notice.body, "Install a supported harness to add agent tools and enable token tracking.");
}

{
  const snap = {
    harnesses: catalog,
    machineHarnesses: [],
    machineHarnessGuidance: [{ id: "claude", displayName: "Claude Code", confidence: "absent", warnings: ["Open Claude Desktop’s Code tab, then refresh."] }],
  };
  assert.equal(configHarnessWarning(snap).body, "Open Claude Desktop’s Code tab, then refresh.");
}

{
  const snap = {
    harnesses: catalog,
    machineHarnesses: [],
    machineHarnessGuidance: [{ id: "claude", displayName: "Claude Code", confidence: "absent", warnings: ["Open Claude Desktop’s Code tab to install Claude Code, then run roborepo harness refresh."] }],
  };
  assert.equal(configHarnessWarning(snap).body,
    "Open Claude Desktop’s Code tab to install Claude Code. RoboRepo will finish setting it up.");
  assert.equal(configHarnessWarning(snap).action, "Check now");
  assert.equal(configHarnessWarning(snap).harnessSpecific, true, "harness-specific guidance hides the supported-harness list");
}

{
  const snap = {
    harnesses: catalog,
    machineHarnesses: [],
    machineHarnessGuidance: [{ id: "claude", displayName: "Claude Code", confidence: "probable", warnings: ["Launch Claude Code once, then run roborepo update."] }],
  };
  assert.equal(configHarnessWarning(snap).body, "Launch Claude Code once. RoboRepo will finish setting it up.",
    "the portal applies config for a newly enabled harness, so it replaces `roborepo update`");
  const noChange = { at: Date.now(), step: "Launch Claude Code once. RoboRepo will finish setting it up.", noChange: true, setUp: [], failed: null };
  assert.equal(configHarnessWarning(snap, noChange).noChangeNote, "Claude Code hasn't been launched yet.");
}

{
  // Installed and launched but not yet set up: the page finishes setup without a click, even when
  // another harness is already active.
  const snap = {
    harnesses: catalog,
    machineHarnesses: [{ id: "codex", displayName: "Codex", enabled: true }],
    machineHarnessGuidance: [{ id: "claude", displayName: "Claude Code", confidence: "confirmed", ready: true, warnings: [] }],
  };
  const settingUp = configHarnessWarning(snap);
  assert.equal(settingUp.state, "setting-up");
  assert.equal(settingUp.body, "Setting up Claude Code…");
  assert.deepEqual(settingUp.readyIds, ["claude"]);
  assert.equal(settingUp.action, null, "setup needs no click");

  const failed = configHarnessWarning(snap, { at: Date.now(), step: settingUp.body, setUp: [], noChange: false,
    failed: { ids: ["claude"], error: "installer exited 1\nmore detail" } });
  assert.equal(failed.state, "failed");
  assert.equal(failed.body, "RoboRepo couldn't finish setting up Claude Code. Run roborepo update in a terminal to see why.");
  assert.equal(failed.detail, "installer exited 1");
  assert.equal(failed.action, "Try again");
}

{
  // Right after setup completes the harness is active, and the banner confirms it once.
  const snap = { harnesses: catalog, machineHarnesses: [{ id: "claude", displayName: "Claude Code", enabled: true }], machineHarnessGuidance: [] };
  const done = configHarnessWarning(snap, { at: Date.now(), step: "Setting up Claude Code…", setUp: ["Claude Code"], noChange: false, failed: null });
  assert.equal(done.state, "done");
  assert.equal(done.variant, "success");
  assert.equal(done.body, "Claude Code is set up.");
  assert.equal(configHarnessWarning(snap), null, "without a recent setup there is nothing to say");
}

{
  const snap = { harnesses: catalog, machineHarnesses: [], machineHarnessGuidance: [] };
  assert.equal(configHarnessWarning(snap).harnessSpecific, false, "the generic install prompt keeps the supported-harness list");
}

{
  const snap = {
    harnesses: catalog,
    machineHarnesses: [{ id: "claude", displayName: "Claude Code", enabled: true }],
    onboarding: { libraryCompleted: false },
    packages: [{ id: "usage-statusline", enabled: true, defaultEnabled: true }],
  };
  // Optional-package state no longer produces a notice: the packages explanation is a persistent
  // page intro (tpl-packages-intro), not an ephemeral onboarding banner.
  assert.equal(configHarnessWarning(snap), null);
  assert.equal(hasOptionalPackageSelected(snap), false);
}

{
  const snap = {
    harnesses: catalog,
    machineHarnesses: [{ id: "claude", displayName: "Claude Code", enabled: true }],
    onboarding: { libraryCompleted: true },
    packages: [{ id: "usage-statusline", enabled: true, defaultEnabled: true }],
  };
  assert.equal(configHarnessWarning(snap), null);
}

{
  const snap = {
    harnesses: catalog,
    machineHarnesses: [{ id: "claude", displayName: "Claude Code", enabled: true }],
    onboarding: { libraryCompleted: true },
    packages: [
      { id: "usage-statusline", enabled: true, defaultEnabled: true },
      { id: "telemetry", enabled: true, defaultEnabled: false },
    ],
  };
  assert.equal(hasOptionalPackageSelected(snap), true);
  assert.equal(configHarnessWarning(snap), null);
}

{
  const snap = {
    harnesses: catalog,
    machineHarnesses: [{ id: "codex", displayName: "Codex", enabled: false }],
    packages: [{ id: "telemetry", enabled: true, defaultEnabled: false }],
  };
  assert.equal(configHarnessWarning(snap).variant, "warning", "disabled harnesses do not count as active");
}

console.log("config onboarding state checks passed");
