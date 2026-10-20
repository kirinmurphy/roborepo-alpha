#!/usr/bin/env node
// Round-trip test: authors a package
// config, enables it (merge), disables it (unmerge), re-enables it, and asserts the final state
// matches the first-enable state byte-for-byte, for both Claude and Codex. Complements the two
// characterization suites (root-config-merge-characterization-check.mjs,
// package-harness-config-characterization-check.mjs), which pin merge/render and package-component
// merge/unmerge behavior against a fixed pre-refactor snapshot; this test instead exercises the
// provider adapters' full enable/disable/enable cycle and checks idempotency of the round trip
// itself, independent of what the exact merged output looks like.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-harness-pkg-roundtrip-"));
process.env.HOME = tmp;
process.env.ROBOREPO_STATE_DIR = path.join(tmp, ".roborepo");

const { mergeHarnessConfig, unmergeHarnessConfig } = await import("../cli/package-harness-config.mjs");

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

const pkg = { id: "roundtrip-pkg", components: [] };

function testClaudeRoundTrip() {
  const settingsPath = path.join(tmp, "claude-settings-roundtrip.json");
  const sourcePath = writeComponentFixture("claude-status-roundtrip", { statusLine: { type: "command", command: "roundtrip" } });
  const component = { harness: "claude", source: path.relative(process.cwd(), sourcePath) };
  const options = { claudeSettingsPath: settingsPath, readSettings, writeSettings };

  mergeHarnessConfig(pkg, component, options);
  const firstEnable = readText(settingsPath);
  assert.ok(firstEnable.length > 0, "claude first enable must write settings content");

  unmergeHarnessConfig(pkg, component, options);
  assert.equal(readSettings(settingsPath).statusLine, undefined, "claude disable must remove the owned statusLine");

  mergeHarnessConfig(pkg, component, options);
  const secondEnable = readText(settingsPath);
  assert.equal(secondEnable, firstEnable, "claude re-enable must match first-enable state byte-for-byte");
}

function testCodexRoundTrip() {
  const configPath = path.join(tmp, "codex-config-roundtrip.toml");
  const sourcePath = writeComponentFixture("codex-tui-roundtrip", { tui: { status_line: ["item-a", "item-b"], status_line_use_colors: true } });
  const component = { harness: "codex", source: path.relative(process.cwd(), sourcePath) };
  const options = { codexConfigPath: configPath, readSettings, writeSettings };

  mergeHarnessConfig(pkg, component, options);
  const firstEnable = readText(configPath);
  assert.ok(firstEnable.length > 0, "codex first enable must write config content");

  unmergeHarnessConfig(pkg, component, options);
  const afterDisable = readText(configPath);
  assert.doesNotMatch(afterDisable, /"item-a"/, "codex disable must remove owned status_line entries");
  assert.doesNotMatch(afterDisable, /status_line_use_colors/, "codex disable must remove the owned color scalar");

  mergeHarnessConfig(pkg, component, options);
  const secondEnable = readText(configPath);
  assert.equal(secondEnable, firstEnable, "codex re-enable must match first-enable state byte-for-byte");
}

function testCodexRoundTripPreservesUnownedNeighbors() {
  const configPath = path.join(tmp, "codex-config-roundtrip-neighbors.toml");
  fs.writeFileSync(configPath, '[tui]\nstatus_line = ["user-owned"]\n');
  const sourcePath = writeComponentFixture("codex-tui-roundtrip-neighbors", { tui: { status_line: ["item-a"] } });
  const component = { harness: "codex", source: path.relative(process.cwd(), sourcePath) };
  const options = { codexConfigPath: configPath, readSettings, writeSettings };

  mergeHarnessConfig(pkg, component, options);
  const firstEnable = readText(configPath);
  assert.match(firstEnable, /"user-owned"/, "codex first enable must preserve an unowned neighbor entry");

  unmergeHarnessConfig(pkg, component, options);
  const afterDisable = readText(configPath);
  assert.match(afterDisable, /"user-owned"/, "codex disable must keep the unowned neighbor entry");
  assert.doesNotMatch(afterDisable, /"item-a"/, "codex disable must remove only the owned entry");

  mergeHarnessConfig(pkg, component, options);
  const secondEnable = readText(configPath);
  assert.equal(secondEnable, firstEnable, "codex re-enable with an unowned neighbor must match first-enable state byte-for-byte");
}

testClaudeRoundTrip();
testCodexRoundTrip();
testCodexRoundTripPreservesUnownedNeighbors();

console.log("harness package-config round-trip: all checks passed");
