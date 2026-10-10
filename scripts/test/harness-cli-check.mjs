#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// `roborepo harness list|inspect|refresh|enable|disable`, end to end through the real CLI
// process.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repoRoot, "scripts/cli/main.mjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-harness-cli-"));
try {
  testZeroStateListIsSafe();
  testRefreshDiscoversAndEnables();
  testInspectUnknownHarnessFails();
  testEnableDisableRoundTrip();
  testDetectedReflectsHomeDirOnly();
  console.log("harness CLI checks passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

function run(args) {
  const env = { ...process.env, HOME: tmp, ROBOREPO_STATE_DIR: path.join(tmp, ".roborepo") };
  return spawnSync(process.execPath, [cli, ...args], { cwd: repoRoot, env, encoding: "utf8" });
}

function testZeroStateListIsSafe() {
  const result = run(["harness", "list"]);
  assert.equal(result.status, 0, `list failed:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /^claude\t/m, "list must include claude even before any discovery has run");
  assert.match(result.stdout, /^codex\t/m, "list must include codex even before any discovery has run");
  assert.match(result.stdout, /disabled/, "undiscovered providers must show as disabled, not silently enabled");
}

function testRefreshDiscoversAndEnables() {
  const result = run(["harness", "refresh"]);
  assert.equal(result.status, 0, `refresh failed:\n${result.stdout}\n${result.stderr}`);
  // Whether claude/codex executables are on PATH varies by machine (e.g. CI runners have neither),
  // so this only asserts the CLI plumbing works end to end, not a specific discovery outcome —
  // discovery's actual confidence-normalization logic is covered deterministically by
  // harness-registry-check.mjs against fixture manifests, not real installed executables.
  assert.match(result.stdout, /^claude\t/m, "refresh output must list claude");
  assert.match(result.stdout, /^codex\t/m, "refresh output must list codex");
}

function testInspectUnknownHarnessFails() {
  const result = run(["harness", "inspect", "bogus-harness"]);
  assert.notEqual(result.status, 0, "inspecting an unknown harness id must fail, not silently succeed");
  assert.match(result.stderr, /unknown harness/, "must report the unknown harness by name");
}

function testEnableDisableRoundTrip() {
  let result = run(["harness", "disable", "codex"]);
  assert.equal(result.status, 0, `disable failed:\n${result.stdout}\n${result.stderr}`);

  result = run(["harness", "list"]);
  assert.match(result.stdout, /^codex\t.*\tdisabled\t/m, "codex must show disabled after explicit disable");

  // Refresh must not silently re-enable an explicit disable.
  result = run(["harness", "refresh"]);
  assert.match(result.stdout, /^codex\t.*\tdisabled\t/m, "explicit disable must survive refresh");

  result = run(["harness", "enable", "codex"]);
  assert.equal(result.status, 0, `enable failed:\n${result.stdout}\n${result.stderr}`);
  result = run(["harness", "list"]);
  assert.match(result.stdout, /^codex\t.*\tenabled\t/m, "codex must show enabled after explicit enable");
}

// `harness detected`: the row source shell install/uninstall/repair/doctor scripts consume.
// Presence must reflect home-dir existence only, independent of state.json and
// independent of whether an executable happens to be on PATH — same semantics as the
// harness_present() shell function it replaces. Install never creates a home directory the harness
// itself has not created.
function testDetectedReflectsHomeDirOnly() {
  let result = run(["harness", "detected"]);
  assert.equal(result.status, 0, `detected failed:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /^claude\t.*\t0\tClaude Code\t/m, "claude must show absent (0) with no ~/.claude dir");
  assert.match(result.stdout, /^codex\t.*\t0\tCodex\t/m, "codex must show absent (0) with no ~/.codex dir");
  assert.match(result.stdout, /^claude\t.*\t.*\.claude[/\\]settings\.json$/m, "claude row must end with its rootConfig path");
  assert.match(result.stdout, /^codex\t.*\t.*\.codex[/\\]config\.toml$/m, "codex row must end with its rootConfig path");

  fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
  result = run(["harness", "detected"]);
  assert.equal(result.status, 0, `detected failed:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /^claude\t.*\t1\tClaude Code\t/m, "claude must show present (1) once ~/.claude exists");
  assert.match(result.stdout, /^codex\t.*\t0\tCodex\t/m, "codex must still show absent (0)");
  fs.rmSync(path.join(tmp, ".claude"), { recursive: true, force: true });
}
