#!/usr/bin/env node
// Proves agents can push feature branches but not protected ones (main, master, the remote's
// default branch), through both guards:
//   - the PreToolUse hook, which reads the command text before it runs, and
//   - the pre-push git hook, which agent shells reach through a core.hooksPath override and which
//     must still run the repo's own hooks.
// A permission prefix rule cannot express this, so it is only checkable by running the hooks.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const claudeHooks = path.join(repoRoot, "globals/system/hooks/claude");
const codexHooks = path.join(repoRoot, "globals/harnesses/codex/hooks");
const hook = path.join(claudeHooks, "protected-branch-push.mjs");
const gitHooks = path.join(claudeHooks, "git");

// Both harnesses install their own copy; a fix landed in one must land in the other.
for (const relative of ["protected-branch-push.mjs", ...fs.readdirSync(gitHooks).map((name) => path.join("git", name))]) {
  const codexCopy = path.join(codexHooks, relative);
  assert.ok(fs.existsSync(codexCopy), `Codex is missing ${relative}`);
  assert.equal(fs.readFileSync(codexCopy, "utf8"), fs.readFileSync(path.join(claudeHooks, relative), "utf8"), `${relative} differs between Claude and Codex`);
  assert.equal(fs.statSync(codexCopy).mode & 0o111, fs.statSync(path.join(claudeHooks, relative)).mode & 0o111, `${relative} executable bit differs`);
}

// Hermetic git: no user or system config, so a developer's own core.hooksPath cannot leak in.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-protected-push-"));
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: path.join(tmp, "gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
};
delete gitEnv.ROBOREPO_PROTECTED_BRANCHES;
fs.writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, "");
const agentEnv = { ...gitEnv, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: gitHooks };

function git(cwd, args, env = gitEnv) {
  return spawnSync("git", args, { cwd, encoding: "utf8", env });
}
function gitOk(cwd, ...args) {
  const r = git(cwd, args);
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

const remote = path.join(tmp, "remote.git");
const work = path.join(tmp, "work");
gitOk(tmp, "init", "-q", "--bare", "-b", "trunk", remote);
gitOk(tmp, "init", "-q", "-b", "main", work);
gitOk(work, "commit", "-q", "--allow-empty", "-m", "init");
gitOk(work, "remote", "add", "origin", remote);
gitOk(work, "push", "-q", "origin", "main", "main:trunk");
gitOk(work, "remote", "set-head", "origin", "trunk");
gitOk(work, "branch", "-q", "--set-upstream-to=origin/main");
gitOk(work, "switch", "-q", "-c", "feat");

function decide(command, { cwd = work, toolName = "Bash", env = {} } = {}) {
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ cwd, tool_name: toolName, tool_input: { command } }),
    encoding: "utf8",
    env: { ...gitEnv, ...env },
  });
  assert.equal(result.status, 0, `hook exited ${result.status}: ${result.stderr}`);
  if (!result.stdout.trim()) return "defer";
  return JSON.parse(result.stdout).hookSpecificOutput.permissionDecision;
}

const cases = [
  ["git push -u origin feat", "defer"],
  ["git push origin HEAD", "defer"],
  ["git push origin v1.0", "defer"],
  ["git status && echo git push origin main", "defer"],
  ["git push origin main", "deny"],
  ["git push origin HEAD:main", "deny"],
  ["git push origin feat:refs/heads/main", "deny"],
  ["git push origin +main", "deny"],
  ["git push origin :main", "deny"],
  ["git push origin --delete main", "deny"],
  ["git push origin master", "deny"],
  // The remote's default branch is protected even when it is not named main or master.
  ["git push origin feat:trunk", "deny"],
  ["git -C . push origin main", "deny"],
  [`cd ${work} && git push origin main`, "deny"],
  ["bash -lc 'git push origin main'", "deny"],
  ["git push origin feat && git push origin main", "deny"],
  ["git push --all", "ask"],
  ["git push --mirror origin", "ask"],
  ["git push origin $BRANCH", "ask"],
  ["git push origin 'refs/heads/*:refs/heads/*'", "ask"],
];
for (const [command, expected] of cases) {
  assert.equal(decide(command), expected, command);
}
assert.equal(decide("git push origin release", { env: { ROBOREPO_PROTECTED_BRANCHES: "release, prod" } }), "deny", "extra protected names");
assert.equal(decide("git push origin main", { toolName: "exec_command" }), "deny", "Codex shell tool");
assert.equal(decide("git push origin main", { toolName: "Read" }), "defer", "non-shell tool");

// A bare `git push` resolves where git itself would send it.
assert.equal(decide("git push"), "defer", "bare push from a feature branch with no upstream");
gitOk(work, "switch", "-q", "main");
assert.equal(decide("git push"), "deny", "bare push from main");
assert.equal(decide("git push origin"), "deny", "bare push to a remote from main");
gitOk(work, "switch", "-q", "-c", "tracks-main", "--track", "origin/main");
gitOk(work, "config", "push.default", "upstream");
assert.equal(decide("git push"), "deny", "feature branch whose upstream is main, push.default=upstream");
gitOk(work, "config", "push.default", "matching");
assert.equal(decide("git push"), "ask", "push.default=matching");
gitOk(work, "config", "--unset", "push.default");

// pre-push backstop: git hands it the real destination refs.
gitOk(work, "switch", "-q", "-c", "feature");
gitOk(work, "commit", "-q", "--allow-empty", "-m", "work");
let r = git(work, ["push", "-q", "origin", "feature"], agentEnv);
assert.equal(r.status, 0, `feature push should pass: ${r.stderr}`);
for (const refspec of ["feature:main", "feature:refs/heads/master", "feature:trunk"]) {
  r = git(work, ["push", "-q", "origin", refspec], agentEnv);
  assert.notEqual(r.status, 0, `${refspec} should be refused`);
  assert.match(r.stderr, /protected branch/, refspec);
}
assert.notEqual(git(work, ["push", "-q", "origin", ":main"], agentEnv).status, 0, "deleting main should be refused");
// Without the agent override, the same push goes through: the backstop only applies to agent shells.
r = git(work, ["push", "-q", "origin", "feature:main"]);
assert.equal(r.status, 0, `a human push is not affected: ${r.stderr}`);

// The repo's own hooks still run under the override, from .git/hooks or its own core.hooksPath.
const log = path.join(tmp, "hook.log");
const repoHook = (dir, name) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `#!/bin/sh\necho "${name} $(cat | wc -l | tr -d ' ')" >> "${log}"\n`, { mode: 0o755 });
};
repoHook(path.join(work, ".git", "hooks"), "pre-push");
repoHook(path.join(work, ".git", "hooks"), "pre-commit");
gitOk(work, "commit", "-q", "--allow-empty", "-m", "chained");
assert.equal(git(work, ["commit", "-q", "--allow-empty", "-m", "chained"], agentEnv).status, 0);
assert.equal(git(work, ["push", "-q", "origin", "feature"], agentEnv).status, 0);
assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n").slice(-2), ["pre-commit 0", "pre-push 1"], "repo hooks chained, with pre-push stdin intact");

const customHooks = path.join(work, ".custom-hooks");
repoHook(customHooks, "pre-commit");
fs.rmSync(path.join(work, ".git", "hooks", "pre-commit"));
gitOk(work, "config", "core.hooksPath", ".custom-hooks");
fs.writeFileSync(log, "");
assert.equal(git(work, ["commit", "-q", "--allow-empty", "-m", "custom"], agentEnv).status, 0);
assert.equal(fs.readFileSync(log, "utf8").trim(), "pre-commit 0", "repo-configured core.hooksPath is honored");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("protected-branch-push-check passed");
