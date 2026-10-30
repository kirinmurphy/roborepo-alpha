#!/usr/bin/env node
// Proves agents can push feature branches but not protected ones (main, master, the remote's
// default branch), and never force-push, through both guards:
//   - the PreToolUse hook, which reads the command text before it runs and is the only thing that
//     approves a push without a prompt, and
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
const gitHooks = path.join(repoRoot, "globals/system/git-hooks");

// Both harnesses install their own copy of the PreToolUse hook; a fix landed in one must land in the
// other. The git hooks have one source, installed into each harness home.
assert.equal(fs.readFileSync(path.join(codexHooks, "protected-branch-push.mjs"), "utf8"), fs.readFileSync(hook, "utf8"),
  "protected-branch-push.mjs differs between Claude and Codex");
for (const name of fs.readdirSync(gitHooks).filter((name) => name !== "chain.sh")) {
  assert.ok(fs.statSync(path.join(gitHooks, name)).mode & 0o111, `git hook ${name} is executable`);
}

// Hermetic git: no user, system, or environment-injected config, so a developer's own
// core.hooksPath cannot leak in. An agent shell injects the installed backstop through
// GIT_CONFIG_COUNT/KEY/VALUE, which would refuse this test's own setup pushes.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-protected-push-"));
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: path.join(tmp, "gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
};
for (const key of Object.keys(gitEnv)) {
  if (/^GIT_CONFIG_(?:COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)$/.test(key)) delete gitEnv[key];
}
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
    env: { ...gitEnv, ROBOREPO_GIT_HOOKS_DIR: gitHooks, ...env },
  });
  assert.equal(result.status, 0, `hook exited ${result.status}: ${result.stderr}`);
  if (!result.stdout.trim()) return "defer";
  return JSON.parse(result.stdout).hookSpecificOutput.permissionDecision;
}

const cases = [
  // Verified pushes are allowed: the hook is what lets agents push without a prompt.
  ["git push -u origin feat", "allow"],
  ["git push origin HEAD", "allow"],
  ["git push origin v1.0", "allow"],
  ["git push origin feat 2>&1", "allow"],
  [`cd ${work} && git push origin feat`, "allow"],
  // Anything beyond pushes stays with the permission prompt, so the allow never covers it.
  ["git status && echo git push origin main", "defer"],
  ["git push origin feat && rm -rf build", "defer"],
  ["git push origin feat > push.log", "defer"],
  ["bash -lc 'git push origin feat'", "defer"],
  ["git push origin --delete feat", "defer"],
  // Ways to point git away from the pre-push backstop are never approved silently.
  ["GIT_CONFIG_COUNT=0 git push origin feat", "defer"],
  ["git -c core.hooksPath=/dev/null push origin feat", "defer"],
  ["git push --no-verify origin feat", "ask"],
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
  ["git push origin :", "ask"],
  // Force pushes are denied wherever they land, in every spelling.
  ["git push --force origin feat", "deny"],
  ["git push origin feat --force", "deny"],
  ["git push --force-with-lease=feat origin feat", "deny"],
  ["git push origin --force-with-lease=feat:0123abc feat", "deny"],
  ["git push -uf origin feat", "deny"],
  ["git push origin +feat", "deny"],
  ["git push origin +:", "deny"],
  ["git push -o ci.skip origin feat", "allow"],
];
// gh commands that skip git: denied in any flag position, since the prefix rules only see the
// leading words. Other gh commands are left to the permission rules.
cases.push(
  ["gh -R owner/repo pr merge 12 --admin", "deny"],
  ["gh --repo=owner/repo api -X PATCH repos/o/r/git/refs/heads/main", "deny"],
  ["gh pr merge 12", "deny"],
  ["git push origin feat && gh -R o/r pr merge 12", "deny"],
  ["gh -R owner/repo pr create --head feat", "defer"],
  ["gh pr view 12", "defer"],
);
// The hook's gh deny list must cover every command the manifest denies, in the flag-first form the
// prefix rules miss.
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "manifests/inventory/agent-permissions.json"), "utf8"));
for (const command of manifest.behaviors.find((b) => b.id === "change-github-directly").commands) {
  cases.push([`gh -R owner/repo ${command.slice(1).join(" ")} x`, "deny"]);
}
for (const [command, expected] of cases) {
  assert.equal(decide(command), expected, command);
}
assert.equal(decide("git push origin release", { env: { ROBOREPO_PROTECTED_BRANCHES: "release, prod" } }), "deny", "extra protected names");
assert.equal(decide("git push origin main", { toolName: "exec_command" }), "deny", "Codex shell tool");
assert.equal(decide("git push origin main", { toolName: "Read" }), "defer", "non-shell tool");
// Without the backstop installed, nothing approves a push: the permission prompt stays.
assert.equal(decide("git push origin feat", { env: { ROBOREPO_GIT_HOOKS_DIR: path.join(tmp, "missing") } }), "defer", "no backstop, no allow");
assert.equal(decide("git push origin main", { env: { ROBOREPO_GIT_HOOKS_DIR: path.join(tmp, "missing") } }), "deny", "a protected push is still denied");

// With no recorded remote default branch, a push may land on it; this hook cannot ask the remote.
gitOk(work, "remote", "set-head", "origin", "-d");
assert.equal(decide("git push origin feat"), "ask", "unknown remote default branch asks");
assert.equal(decide("git push origin main"), "deny", "main is protected regardless");
gitOk(work, "remote", "set-head", "origin", "trunk");

// A bare `git push` resolves where git itself would send it.
assert.equal(decide("git push"), "allow", "bare push from a feature branch with no upstream");
gitOk(work, "switch", "-q", "main");
assert.equal(decide("git push"), "deny", "bare push from main");
assert.equal(decide("git push origin"), "deny", "bare push to a remote from main");
gitOk(work, "switch", "-q", "-c", "tracks-main", "--track", "origin/main");
gitOk(work, "config", "push.default", "upstream");
assert.equal(decide("git push"), "deny", "feature branch whose upstream is main, push.default=upstream");
gitOk(work, "config", "push.default", "matching");
assert.equal(decide("git push"), "ask", "push.default=matching");
gitOk(work, "config", "--unset", "push.default");
gitOk(work, "config", "remote.origin.push", "refs/heads/feat:refs/heads/main");
assert.equal(decide("git push origin feat"), "ask", "a source-only refspec follows remote.<name>.push");
assert.equal(decide("git push origin feat:feat"), "allow", "an explicit destination does not");
gitOk(work, "config", "--unset", "remote.origin.push");

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

// Force pushes are refused from the refs themselves, however the command spelled them.
gitOk(work, "commit", "-q", "--allow-empty", "-m", "published");
assert.equal(git(work, ["push", "-q", "origin", "feature"], agentEnv).status, 0);
gitOk(work, "reset", "-q", "--hard", "HEAD~1");
gitOk(work, "commit", "-q", "--allow-empty", "-m", "rewritten");
for (const args of [["origin", "--force", "feature"], ["origin", "+feature"], ["--force-with-lease", "origin", "feature"]]) {
  r = git(work, ["push", "-q", ...args], agentEnv);
  assert.notEqual(r.status, 0, `force push ${args.join(" ")} should be refused`);
  assert.match(r.stderr, /not a fast-forward/, args.join(" "));
}
// A remote ref holding commits this repo lacks cannot be checked for fast-forward, so it is refused.
const other = path.join(tmp, "other");
gitOk(tmp, "clone", "-q", "-b", "feature", remote, other);
gitOk(other, "commit", "-q", "--allow-empty", "-m", "elsewhere");
gitOk(other, "push", "-q", "origin", "feature");
r = git(work, ["push", "-q", "--force", "origin", "feature"], agentEnv);
assert.notEqual(r.status, 0, "force over unknown remote commits should be refused");
assert.match(r.stderr, /does not have/);
gitOk(work, "pull", "-q", "--rebase", "origin", "feature");
assert.equal(git(work, ["push", "-q", "origin", "feature"], agentEnv).status, 0, "a fast-forward after integrating is allowed");

// With no recorded remote HEAD, the backstop asks the remote for its default branch.
gitOk(work, "remote", "set-head", "origin", "-d");
r = git(work, ["push", "-q", "origin", "feature:trunk"], agentEnv);
assert.notEqual(r.status, 0, "the remote's default branch is protected without a recorded HEAD");
assert.match(r.stderr, /protected branch/);
assert.equal(git(work, ["push", "-q", "origin", "feature"], agentEnv).status, 0, "a feature push still passes");
gitOk(work, "remote", "set-head", "origin", "trunk");
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

// An exported CDPATH with its own .custom-hooks must not redirect the relative core.hooksPath.
fs.mkdirSync(path.join(tmp, "decoy", ".custom-hooks"), { recursive: true });
fs.writeFileSync(log, "");
assert.equal(git(work, ["commit", "-q", "--allow-empty", "-m", "cdpath"], { ...agentEnv, CDPATH: path.join(tmp, "decoy") }).status, 0);
assert.equal(fs.readFileSync(log, "utf8").trim(), "pre-commit 0", "CDPATH does not redirect the repo's hooks");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("protected-branch-push-check passed");
