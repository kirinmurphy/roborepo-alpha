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
  assert.match(notice.body, /Install a supported harness/);
  assert.match(notice.body, /check for installs/);
  assert.match(notice.body, /Claude Code and Codex/);
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
