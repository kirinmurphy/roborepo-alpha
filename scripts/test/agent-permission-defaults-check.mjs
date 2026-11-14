#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudePermissions, renderCodexRules } from "../harnesses/permissions-render.mjs";
import { renderGeminiPolicyRules } from "../harnesses/gemini/policy-toml.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Assert shipped defaults in clean projections, independent of local provider overrides.
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
console.log("agent-permission-defaults-check passed for Claude, Codex, and Gemini.");
