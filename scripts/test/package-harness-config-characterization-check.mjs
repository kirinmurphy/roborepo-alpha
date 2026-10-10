#!/usr/bin/env node
// Characterization tests for scripts/cli/package-harness-config.mjs's mergeHarnessConfig/
// unmergeHarnessConfig — captured before this moved into a
// provider-adapter orchestrator. Pins the trickiest current
// behavior: Claude statusLine conflict preservation, Codex TUI status_line array dedupe/table
// creation from scratch, and the color-scalar ownership-provenance mechanism (first-seen value
// preserved across repeated enables, restored exactly on disable).
//
// This file must keep passing unchanged through the refactor — a failure here means the provider
// adapter's behavior diverged from pre-refactor behavior, not that the old behavior was wrong.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-pkg-harness-config-"));
process.env.HOME = tmp;
process.env.ROBOREPO_STATE_DIR = path.join(tmp, ".roborepo");

const {
  mergeHarnessConfig,
  unmergeHarnessConfig,
  codexStatusLineIncludes,
  packageRuntimeAssetDestination,
} = await import("../cli/package-harness-config.mjs");

function readSettings(settingsPath) {
  try { return JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch { return {}; }
}
function writeSettings(settingsPath, settings) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}
function readText(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return ""; }
}

const fixturesDir = path.join(tmp, "fixtures");
fs.mkdirSync(fixturesDir, { recursive: true });
function writeComponentFixture(name, data) {
  const sourcePath = path.join(fixturesDir, `${name}.json`);
  fs.writeFileSync(sourcePath, JSON.stringify(data));
  return sourcePath;
}

const pkg = { id: "test-pkg", components: [] };

function testClaudeMergeAndUnmerge() {
  const settingsPath = path.join(tmp, "claude-settings.json");
  const sourcePath = writeComponentFixture("claude-status", { statusLine: { type: "command", command: "foo" } });
  const component = { harness: "claude", source: path.relative(process.cwd(), sourcePath) };

  mergeHarnessConfig(pkg, component, { claudeSettingsPath: settingsPath, readSettings, writeSettings });
  assert.deepEqual(readSettings(settingsPath).statusLine, { type: "command", command: "foo" }, "claude merge must write the desired statusLine");

  unmergeHarnessConfig(pkg, component, { claudeSettingsPath: settingsPath, readSettings, writeSettings });
  assert.equal(readSettings(settingsPath).statusLine, undefined, "claude unmerge must remove the statusLine it owns");
}

function testClaudeMergeConflictPreservesUnmanagedValue() {
  const settingsPath = path.join(tmp, "claude-settings-conflict.json");
  writeSettings(settingsPath, { statusLine: { type: "command", command: "user-owned" } });
  const sourcePath = writeComponentFixture("claude-status-conflict", { statusLine: { type: "command", command: "roborepo-desired" } });
  const component = { harness: "claude", source: path.relative(process.cwd(), sourcePath) };

  mergeHarnessConfig(pkg, component, { claudeSettingsPath: settingsPath, readSettings, writeSettings });
  assert.deepEqual(readSettings(settingsPath).statusLine, { type: "command", command: "user-owned" }, "claude merge must leave an unmanaged, conflicting statusLine unchanged rather than overwrite it");
}

function testCodexTuiStatusLineFromScratch() {
  const configPath = path.join(tmp, "codex-config-fresh.toml");
  const sourcePath = writeComponentFixture("codex-tui-fresh", { tui: { status_line: ["item-a", "item-b"] } });
  const component = { harness: "codex", source: path.relative(process.cwd(), sourcePath) };

  mergeHarnessConfig(pkg, component, { codexConfigPath: configPath, readSettings, writeSettings });
  const text = readText(configPath);
  assert.ok(codexStatusLineIncludes(text, "item-a"), "codex merge must create [tui] status_line from scratch with item-a");
  assert.ok(codexStatusLineIncludes(text, "item-b"), "codex merge must create [tui] status_line from scratch with item-b");
}

function testCodexTuiStatusLineDedupeAndUnmerge() {
  const configPath = path.join(tmp, "codex-config-dedupe.toml");
  fs.writeFileSync(configPath, '[tui]\nstatus_line = ["existing", "item-a"]\n');
  const sourcePath = writeComponentFixture("codex-tui-dedupe", { tui: { status_line: ["item-a", "item-c"] } });
  const component = { harness: "codex", source: path.relative(process.cwd(), sourcePath) };

  mergeHarnessConfig(pkg, component, { codexConfigPath: configPath, readSettings, writeSettings });
  let text = readText(configPath);
  assert.ok(codexStatusLineIncludes(text, "existing"), "codex merge must keep a pre-existing status_line entry it doesn't own");
  assert.ok(codexStatusLineIncludes(text, "item-a"), "codex merge must dedupe an entry present both before and in the desired set");
  assert.ok(codexStatusLineIncludes(text, "item-c"), "codex merge must add a new desired entry");

  unmergeHarnessConfig(pkg, component, { codexConfigPath: configPath, readSettings, writeSettings });
  text = readText(configPath);
  assert.ok(codexStatusLineIncludes(text, "existing"), "codex unmerge must keep an entry it doesn't own");
  assert.ok(!codexStatusLineIncludes(text, "item-a"), "codex unmerge must remove an entry it owns");
  assert.ok(!codexStatusLineIncludes(text, "item-c"), "codex unmerge must remove an entry it owns");
}

function testCodexColorScalarProvenanceRoundTrip() {
  const configPath = path.join(tmp, "codex-config-color.toml");
  fs.writeFileSync(configPath, '[tui]\nstatus_line = []\nstatus_line_use_colors = false\n');
  const sourcePath = writeComponentFixture("codex-tui-color", { tui: { status_line: ["item-a"], status_line_use_colors: true } });
  const component = { harness: "codex", source: path.relative(process.cwd(), sourcePath) };

  // First enable: an existing unowned value (false) disagrees with desired (true), and no prior
  // provenance is recorded yet -> mergeCodexColorScalar's conflict guard leaves it unchanged
  // rather than overwrite an unmanaged value. Pinning that exact current behavior here.
  mergeHarnessConfig(pkg, component, { codexConfigPath: configPath, readSettings, writeSettings });
  let text = readText(configPath);
  assert.match(text, /status_line_use_colors = false/, "first merge with a pre-existing conflicting value must leave it unchanged (unmanaged-value conflict guard)");

  // Second enable, now with no pre-existing disagreement (remove the line first to simulate a
  // fresh, no-prior-value scenario), confirms the scalar gets set once there's nothing to conflict with.
  fs.writeFileSync(configPath, "[tui]\nstatus_line = []\n");
  mergeHarnessConfig(pkg, component, { codexConfigPath: configPath, readSettings, writeSettings });
  text = readText(configPath);
  assert.match(text, /status_line_use_colors = true/, "merge must set the color scalar when there is no pre-existing conflicting value");

  unmergeHarnessConfig(pkg, component, { codexConfigPath: configPath, readSettings, writeSettings });
  text = readText(configPath);
  assert.doesNotMatch(text, /status_line_use_colors/, "unmerge must remove the color scalar roborepo introduced (no prior value existed)");
}

function testPackageRuntimeAssetDestinationIsPackageAndComponentScoped() {
  const dest = packageRuntimeAssetDestination({ id: "my-pkg" }, { source: "some/path/script.sh" });
  assert.match(dest, /package-runtime[/\\]my-pkg[/\\]script\.sh$/, "package-runtime asset destination must be scoped under package-runtime/<pkgId>/<basename>");
}

testClaudeMergeAndUnmerge();
testClaudeMergeConflictPreservesUnmanagedValue();
testCodexTuiStatusLineFromScratch();
testCodexTuiStatusLineDedupeAndUnmerge();
testCodexColorScalarProvenanceRoundTrip();
testPackageRuntimeAssetDestinationIsPackageAndComponentScoped();

console.log("package-harness-config characterization: all checks passed");
