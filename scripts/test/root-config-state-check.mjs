#!/usr/bin/env node
// Unit test for root config drift detection (scripts/cli/root-config-state.mjs). Verifies the
// hash-sidecar distinguishes "roborepo's own baseline changed" from "something else touched the
// file since roborepo's last write" without a real install run.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-root-config-state-"));
process.env.ROBOREPO_STATE_DIR = tmp;

const { recordWrite, checkDrift } = await import("../cli/root-config-state.mjs");

const target = path.join(tmp, "settings.json");

// No recorded write yet -> "unwritten", callers fall back to existing collision handling.
fs.writeFileSync(target, '{"a":1}\n');
assert.equal(checkDrift("claude", target).status, "unwritten", "no prior write recorded yields unwritten");

// Roborepo writes the file -> recorded. Checking immediately after finds no drift.
recordWrite("claude", target);
assert.equal(checkDrift("claude", target).status, "clean", "unchanged file matches its recorded hash");

// The repo baseline changes and roborepo rewrites the same content (simulating "update" landing a
// new baseline the user never touched) -> still clean once recorded again.
fs.writeFileSync(target, '{"a":1,"b":2}\n');
recordWrite("claude", target);
assert.equal(checkDrift("claude", target).status, "clean", "re-recorded write after a baseline change is clean");

// Something else (a user edit, a native harness flow) changes the file after roborepo's last
// recorded write -> drifted, with both hashes available for the caller's diff.
fs.writeFileSync(target, '{"a":1,"b":2,"c":"user added this"}\n');
const drift = checkDrift("claude", target);
assert.equal(drift.status, "drifted", "a change after the last recorded write is drift, not a clean baseline bump");
assert.ok(drift.lastHash && drift.currentHash && drift.lastHash !== drift.currentHash,
  "drifted result carries both hashes for the caller to act on");

// Two harnesses are tracked independently.
const codexTarget = path.join(tmp, "config.toml");
fs.writeFileSync(codexTarget, 'model = "o3"\n');
recordWrite("codex", codexTarget);
assert.equal(checkDrift("codex", codexTarget).status, "clean", "codex hash is tracked independently of claude");
assert.equal(checkDrift("claude", target).status, "drifted", "recording codex does not disturb claude's drift state");

console.log("root-config-state ok");
