#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-root-config-merge-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
const repo = path.join(tmp, "repo.toml");
const local = path.join(tmp, "local.toml");
const out = path.join(tmp, "out.toml");
const claudeRepo = path.join(tmp, "repo.json");
const claudeLocal = path.join(tmp, "local.json");
const claudeOut = path.join(tmp, "out.json");

fs.writeFileSync(repo, [
  'model = "repo-model"',
  'approval_policy = "on-request"',
  "",
  "[profiles.personal]",
  'model = "repo-profile"',
  'effort = "medium"',
  "",
  "[mcp_servers.repo]",
  'command = "repo"',
  "",
].join("\n"));

fs.writeFileSync(local, [
  'model = "local-model"',
  "# keep this comment with custom_top",
  'custom_top = "keep-me"',
  "",
  "[profiles.personal]",
  'model = "local-profile"',
  'extra = "keep-profile-key"',
  "",
  "[mcp_servers.personal]",
  'command = "personal"',
  'args = ["--flag", "[bracketed]"]',
  "",
].join("\n"));

const result = spawnSync(process.execPath, [
  path.resolve("scripts/cli/root-config-merge.mjs"),
  "codex",
  repo,
  local,
  out,
], { encoding: "utf8" });

assert.equal(result.status, 0, result.stderr);
const merged = fs.readFileSync(out, "utf8");
assert.match(merged, /model = "local-model"/, "local top-level conflict wins");
assert.match(merged, /custom_top = "keep-me"/, "local top-level key is preserved");
assert.match(merged, /\[profiles\.personal\][\s\S]*model = "local-profile"/, "local same-table conflict wins");
assert.match(merged, /extra = "keep-profile-key"/, "local same-table key is preserved");
assert.match(merged, /\[mcp_servers\.personal\]/, "local-only table is preserved");
assert.match(merged, /\[mcp_servers\.repo\]/, "repo-only table is preserved");
assert.match(merged, /args = \["--flag", "\[bracketed\]"\]/, "array values with brackets survive intact");
assert.match(
  merged,
  /# keep this comment with custom_top\ncustom_top = "keep-me"/,
  "local comment stays attached to the key it documents",
);

fs.writeFileSync(claudeRepo, JSON.stringify({ permissions: { allow: ["Read"] } }, null, 2));
fs.writeFileSync(claudeLocal, JSON.stringify({ model: "opus", hooks: { Stop: [] } }, null, 2));
const claudeResult = spawnSync(process.execPath, [
  path.resolve("scripts/cli/root-config-merge.mjs"),
  "claude",
  claudeRepo,
  claudeLocal,
  claudeOut,
], { encoding: "utf8" });
assert.equal(claudeResult.status, 0, claudeResult.stderr);
const claudeMerged = JSON.parse(fs.readFileSync(claudeOut, "utf8"));
assert.equal(claudeMerged.model, undefined, "Claude root config merge must not preserve global model");
assert.deepEqual(claudeMerged.hooks, { Stop: [] }, "Claude root config merge still preserves other local settings");

console.log("root-config-merge ok");
