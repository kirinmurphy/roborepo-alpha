#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { renderCodexRules, renderCodexConfig } from "../harnesses/permissions-render.mjs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hook = path.join(repoRoot, "globals/harnesses/codex/hooks/permission-check.mjs");
const home = path.join(os.tmpdir(), `roborepo-command-permission-${randomUUID()}`);
const env = { ...process.env, HOME: home, REPO_ROOT: repoRoot, ROBOREPO_STATE_ROOT: path.join(home, ".roborepo") };

for (const [toolName, key] of [["Bash", "command"], ["exec_command", "cmd"]]) {
  for (const [command, expected] of [
    ["git status", "allow"],
    ["git push --force origin feature/demo", "deny"],
    ["rm scratch.txt", undefined],
    ["rm scratch.txt && git status", undefined],
    ["git push origin feature/demo && touch chained.txt", "deny"],
    ["git status && touch chained.txt", undefined],
    ["git status; touch chained.txt", undefined],
    ["git status | sh", undefined],
    ["git status > status.txt", undefined],
    ["git status $(touch chained.txt)", undefined],
  ]) {
    const result = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ tool_name: toolName, tool_input: { [key]: command } }),
      encoding: "utf8", env,
    });
    assert.equal(result.status, 0, result.stderr);
    const output = result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput : undefined;
    assert.equal(output?.permissionDecision, expected, `${toolName}/${key}: ${command}`);
    // A delegated push denial can carry the branch guard’s reason.
    if (expected) assert.match(output.permissionDecisionReason, /^roborepo(?: permissions)?:/);
  }
}
for (const command of ["rm scratch.txt", "git status", "git pull", "git switch feature/demo"]) {
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8", env,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", `${command}: leave native approval to the configured reviewer`);
}
const hooks = JSON.parse(fs.readFileSync(path.join(repoRoot, "globals/harnesses/codex/hooks-codex.json"), "utf8"));
assert.ok(hooks.hooks.PermissionRequest.some((group) =>
  new RegExp(group.matcher).test("Bash") && group.hooks.some((entry) => entry.command.includes("permission-check.mjs"))));
const manifest = { behaviors: [
  { id: "delete", kind: "commands", commands: [["rm"]], bucket: "ask" },
  { id: "force", kind: "commands", commands: [["git", "push", "--force"]], bucket: "deny" },
], commands: { allow: [["git", "status"]] } };
const rules = renderCodexRules(manifest, { commands: {
  "custom action": { tokens: ["custom", "action"], bucket: "ask" },
} });
assert.match(rules, /pattern=\["rm"\], decision="prompt"/);
assert.match(rules, /pattern=\["custom", "action"\], decision="prompt"/);
assert.match(rules, /pattern=\["git", "push", "--force"\], decision="forbidden"/);
assert.match(rules, /pattern=\["git", "status"\], decision="allow"/);
for (const reviewer of ["user", "auto_review"]) {
  const config = renderCodexConfig(`approvals_reviewer = "${reviewer}"\n`, manifest.behaviors, [], "fixture");
  assert.match(config, new RegExp(`approvals_reviewer = "${reviewer}"`));
}
console.log("codex-command-permission-check passed");
