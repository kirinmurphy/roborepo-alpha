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

// Assert shipped defaults in clean projections, independent of local provider overrides.
const { claudePermissions } = await import("../harnesses/permissions-render.mjs");
const { renderGeminiPolicyRules } = await import("../harnesses/gemini/policy-toml.mjs");
const defaults = JSON.parse(fs.readFileSync(path.join(repoRoot, "manifests/inventory/agent-permissions.json"), "utf8"));
const claude = claudePermissions(defaults);
const codex = renderCodexRules(defaults);
const gemini = renderGeminiPolicyRules({}, defaults);
const guarded = defaults.behaviors.filter((behavior) => ["guarded-delivery", "plan-lifecycle"].includes(behavior.id));
assert.equal(guarded.length, 2);
for (const behavior of guarded) {
  assert.equal(behavior.bucket, "allow");
  for (const tokens of behavior.commands) {
    assert.ok(claude.allow.includes(`Bash(${tokens.join(" ")}:*)`));
    assert.ok(codex.includes(`pattern=${JSON.stringify(tokens).replaceAll(",", ", ")}, decision="allow"`));
    assert.ok(gemini.includes(`commandPrefix = "${tokens.join(" ")}"\ndecision = "allow"`));
  }
}
for (const command of ["gh pr edit", "gh pr ready"]) {
  assert.ok(claude.ask.includes(`Bash(${command}:*)`));
}
for (const command of ["gh pr merge", "gh api", "git push --force"]) {
  assert.ok(claude.deny.includes(`Bash(${command}:*)`));
}
for (const command of ["git fetch", "gh run rerun", "git worktree add", "git merge"]) {
  assert.ok(!claude.allow.includes(`Bash(${command}:*)`));
}
const planStore = defaults.behaviors.find((behavior) => behavior.id === "plan-store-commands");
assert.equal(planStore?.bucket, "allow");
for (const subcommand of ["archive", "close"]) {
  const tokens = ["roborepo", "plans", subcommand];
  assert.ok(planStore.commands.some((command) => command.join(" ") === tokens.join(" ")));
  assert.ok(claude.allow.includes(`Bash(${tokens.join(" ")}:*)`));
}
assert.ok(!claude.allow.includes("Bash(roborepo delivery:*)"));
assert.ok(!claude.allow.includes("Bash(roborepo plans:*)"));
console.log("Guarded delivery projections passed for Claude, Codex, and Gemini.");
