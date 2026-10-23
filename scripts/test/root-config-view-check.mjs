#!/usr/bin/env node
// Unit test for buildRootConfigView (scripts/cli/root-config-view.mjs), the per-harness drift view the
// terminal `roborepo config root inspect` report and the web /agents drift chip both render from.
// Drives a throwaway HOME so rootConfigActive/rootConfigBaseline resolve into a temp tree, then
// exercises each user-facing state: not-installed, unwritten, in-sync, drifted.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-root-config-view-"));
// os.homedir() reads $HOME on macOS/Linux; set it before importing the modules that snapshot it.
process.env.HOME = home;
const stateDir = path.join(home, ".roborepo");
process.env.ROBOREPO_STATE_DIR = stateDir;
fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
fs.mkdirSync(path.join(home, ".codex"), { recursive: true });

const { buildRootConfigView } = await import("../cli/root-config-view.mjs");
const { recordWrite } = await import("../cli/root-config-state.mjs");

const claudeActive = path.join(home, ".claude", "settings.json");
const stateOf = (harness) => buildRootConfigView().find((r) => r.harness === harness).state;

// No active file on disk -> not-installed.
assert.equal(stateOf("claude"), "not-installed", "no active file yields not-installed");

// Active file exists but roborepo never recorded a write -> unwritten.
fs.writeFileSync(claudeActive, '{"a":1}\n');
assert.equal(stateOf("claude"), "unwritten", "untracked active file yields unwritten");

// Roborepo records its write, file unchanged since -> in-sync.
recordWrite("claude", claudeActive);
assert.equal(stateOf("claude"), "in-sync", "unchanged recorded file yields in-sync");

// User edits after the recorded write -> drifted.
fs.writeFileSync(claudeActive, '{"a":1,"user":"edited"}\n');
assert.equal(stateOf("claude"), "drifted", "edit after recorded write yields drifted");

// A *_update_TIMESTAMP sibling left by an earlier release is not a state of its own: update merges
// drifted files now and removes such leftovers, so the view reports the file's drift alone.
fs.writeFileSync(path.join(home, ".claude", "settings_update_20260707-000000.json"), '{"baseline":true}\n');
assert.equal(stateOf("claude"), "drifted", "a leftover update sibling does not change the reported state");

console.log("root-config-view ok");
