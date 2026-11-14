#!/usr/bin/env node
// Rule text that plan-suite skills depend on. Generated-output checks only prove the renders are
// current, so this pins the clauses themselves:
//
// - The shared delivery rule renders for every rules-capable harness and keeps its stop conditions.
// - The worktree exception reads the same in the always-on branch-safety fragment and the
//   branch-safety package, so enabling the package never contradicts the shared rule.
// - The Claude rule enters a linked worktree with `EnterWorktree`, not `change_directory`.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { harnessIdsWithCapability, renderRulesPreview, renderSharedRulesPreview } from "../cli/rules-render.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), "utf8");
const normalize = (text) => text.replace(/\s+/g, " ").trim();

// ---- Delivery rule ----
const shared = normalize(renderSharedRulesPreview());
for (const clause of [
  "## Deliver Finished Work",
  "Skip this workflow for unfinished experiments, when the user asks to keep work local, or when the repository has no remote.",
  "Follow the active skill's delivery rules when it defines its own.",
  "If unrelated unpublished base commits would enter the pull request, report the mismatch and pause delivery.",
  "Request approval to run `git switch -c <branch>` in the primary checkout.",
  "Stage only the paths or hunks from the requested work.",
  "Report the CI result and leave the merge to the user.",
]) {
  assert.ok(shared.includes(clause), `shared rules keep the delivery clause: "${clause}"`);
}
for (const harness of harnessIdsWithCapability("rules")) {
  assert.ok(renderRulesPreview(harness, []).includes("## Deliver Finished Work"), `${harness} renders the delivery rule`);
}

// ---- Worktree exception, identical in both branch-safety copies ----
const exception = (text, source) => {
  const match = normalize(text).match(/Invoking a workflow that explicitly creates its own worktree[^]*?checkout changes\./);
  assert.ok(match, `${source} states the workflow worktree exception`);
  return match[0];
};
const fragmentException = exception(read("globals/system/rules/shared/06-branch-safety.md"), "the shared branch-safety fragment");
const packageException = exception(read("globals/packages/branch-safety/rules.md"), "the branch-safety package");
assert.equal(packageException, fragmentException, "both branch-safety copies state the same worktree exception");
assert.ok(fragmentException.includes("such as `/plan-execute`"), "the exception names the plan-execute workflow");

// ---- Claude worktree entry ----
const claude = normalize(renderRulesPreview("claude", []));
assert.ok(claude.includes("enter a linked worktree of this repo with `EnterWorktree({ path })`"), "Claude enters worktrees with EnterWorktree");
assert.ok(!/entering a worktree means calling `change_directory`/.test(claude), "Claude no longer directs agents to change_directory");

console.log("agent-workflow-rules-check passed");
