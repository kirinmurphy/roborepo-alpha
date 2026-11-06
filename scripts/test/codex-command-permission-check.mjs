#!/usr/bin/env node
import assert from "node:assert/strict";
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
    ["rm scratch.txt", "deny"],
    ["rm scratch.txt && git status", "deny"],
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
    if (command === "rm scratch.txt") assert.match(output.permissionDecisionReason, /Codex cannot ask.*Run the command yourself/);
  }
}
console.log("codex-command-permission-check passed");
