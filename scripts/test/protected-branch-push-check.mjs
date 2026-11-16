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
// The .sh files are helpers the hooks source, not hooks git runs.
for (const name of fs.readdirSync(gitHooks).filter((name) => !name.endsWith(".sh"))) {
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
// An agent shell carries the core.hooksPath override itself; the "human" git here must not.
for (const key of Object.keys(gitEnv)) if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) delete gitEnv[key];
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

function decide(command, { cwd = work, toolName = "Bash", env = {}, hookPath = hook, key = "command", event = "PreToolUse" } = {}) {
  const result = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({ cwd, hook_event_name: event, tool_name: toolName, tool_input: { [key]: command } }),
    encoding: "utf8",
    env: { ...gitEnv, ROBOREPO_GIT_HOOKS_DIR: gitHooks, ...env },
  });
  assert.equal(result.status, 0, `hook exited ${result.status}: ${result.stderr}`);
  if (!result.stdout.trim()) return "defer";
  const output = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, event);
  return event === "PermissionRequest" ? output.decision.behavior : output.permissionDecision;
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
  // The plans store branch: only `roborepo plans` pushes it, with hooks off.
  ["git push origin repo-plans", "deny"],
  ["git push origin HEAD:repo-plans", "deny"],
  ["git push origin --delete repo-plans", "deny"],
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
  ["gh --repo=owner/repo api -X PATCH repos/o/r/git/refs/heads/main", "deny"],
  ["git push origin feat && gh -R o/r api repos/o/r", "deny"],
  // Agents never merge a pull request (merge-pull-requests), in either flag position.
  ["gh -R owner/repo pr merge 12 --admin", "deny"],
  ["gh pr merge 12", "deny"],
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
// Codex runs a command whose hook result is "ask" without prompting, so its copy turns every ask
// into a deny. It knows it is Codex's from its directory, in this repo and where it is installed.
const codexHook = path.join(codexHooks, "protected-branch-push.mjs");
const installedHome = path.join(tmp, "home");
for (const dir of [".codex", ".claude"]) {
  fs.mkdirSync(path.join(installedHome, dir, "hooks"), { recursive: true });
  fs.copyFileSync(hook, path.join(installedHome, dir, "hooks", "protected-branch-push.mjs"));
}
const askCases = [
  ...cases.filter(([, expected]) => expected === "ask").map(([command]) => command),
  "git push origin feat --no-verify",
  `sh -c 'b=main; git push origin "$b"'`,
];
for (const command of askCases) {
  assert.equal(decide(command), "ask", `Claude asks: ${command}`);
  assert.equal(decide(command, { toolName: "exec_command", hookPath: codexHook, key: "cmd" }), "deny", `Codex denies: ${command}`);
}
const installedCodex = path.join(installedHome, ".codex", "hooks", "protected-branch-push.mjs");
const installedClaude = path.join(installedHome, ".claude", "hooks", "protected-branch-push.mjs");
assert.equal(decide("git push --no-verify origin feat", { toolName: "exec_command", hookPath: installedCodex }), "deny", "installed Codex copy denies an ask");
assert.equal(decide("git push --no-verify origin feat", { hookPath: installedClaude }), "ask", "installed Claude copy still asks");
// Codex keeps its other decisions: exec_command sends the command as `cmd`.
for (const [command, expected] of [["git push origin feat", "allow"], ["git push origin main", "deny"], ["gh pr view 12", "defer"]]) {
  assert.equal(decide(command, { toolName: "exec_command", hookPath: codexHook, key: "cmd" }), expected, `Codex cmd: ${command}`);
}
// Native approval requests use the branch guard to approve only verified generic pushes. Chaining another command or losing the backstop must never inherit an allow.
const permissionHook = path.join(codexHooks, "permission-check.mjs");
for (const event of ["PreToolUse", "PermissionRequest"]) {
  for (const [toolName, key] of [["Bash", "command"], ["exec_command", "cmd"]]) {
    const options = { event, toolName, key, hookPath: permissionHook, env: { REPO_ROOT: repoRoot, ROBOREPO_STATE_ROOT: path.join(tmp, "permission-state") } };
    for (const [command, expected] of [
      ["git push origin feat", "allow"],
      ["git push origin main", "deny"],
      ["git push origin feat --no-verify", "deny"],
      ["git push --all origin", "deny"],
      ["git push origin feat && touch chained.txt", "deny"],
    ]) assert.equal(decide(command, options), expected, `command permissions ${toolName}: ${command}`);
    assert.equal(decide("git push origin feat", { ...options, env: { ...options.env, ROBOREPO_GIT_HOOKS_DIR: path.join(tmp, "missing") } }), "deny", "command permissions deny without the push backstop");
  }
}
const overrideState = path.join(tmp, "push-override-state");
fs.mkdirSync(overrideState);
for (const [tokens, bucket] of [
  [["git", "push"], "ask"],
  [["git", "push", "origin", "feat"], "ask"],
  [["git"], "ask"],
  [["git"], "deny"],
]) {
  fs.writeFileSync(path.join(overrideState, "command-overrides.json"), JSON.stringify({
    commands: { [tokens.join(" ")]: { tokens, bucket } },
  }));
  assert.equal(decide("git push origin feat", {
    hookPath: permissionHook, event: "PermissionRequest",
    env: { REPO_ROOT: repoRoot, ROBOREPO_STATE_ROOT: overrideState },
  }), bucket === "deny" ? "deny" : "defer", "personal restrictions survive push approval");
}

fs.writeFileSync(path.join(overrideState, "command-overrides.json"), JSON.stringify({ commands: {} }));
for (const command of ['git push origin "feat"', "git push origin feat && git push origin special"]) {
  assert.equal(decide(command, {
    hookPath: permissionHook, event: "PermissionRequest",
    env: { REPO_ROOT: repoRoot, ROBOREPO_STATE_ROOT: overrideState },
  }), "defer", "only literal single pushes may receive automatic approval");
}
for (const bucket of ["ask", "deny"]) {
  const tokens = ["git", "push", "origin", "special"];
  fs.writeFileSync(path.join(overrideState, "command-overrides.json"), JSON.stringify({
    commands: { [tokens.join(" ")]: { tokens, bucket } },
  }));
  assert.equal(decide("git push origin feat && git push origin special", {
    hookPath: permissionHook, event: "PermissionRequest",
    env: { REPO_ROOT: repoRoot, ROBOREPO_STATE_ROOT: overrideState },
  }), "defer", "a later push must retain its native personal restriction");
}

console.log("push approval checks passed: both hook events, shell payloads, protected/force denials, and personal overrides");
assert.equal(decide("git push origin release", { env: { ROBOREPO_PROTECTED_BRANCHES: "release, prod" } }), "deny", "extra protected names");
assert.equal(decide("git push origin main", { toolName: "exec_command" }), "deny", "Codex shell tool");
assert.equal(decide("git push origin main", { toolName: "Read" }), "defer", "non-shell tool");
// Without the backstop installed, nothing approves a push: the permission prompt stays.
assert.equal(decide("git push origin feat", { env: { ROBOREPO_GIT_HOOKS_DIR: path.join(tmp, "missing") } }), "defer", "no backstop, no allow");
assert.equal(decide("git push origin main", { env: { ROBOREPO_GIT_HOOKS_DIR: path.join(tmp, "missing") } }), "deny", "a protected push is still denied");

// With no recorded remote default branch, a push may land on it; this hook cannot ask the remote.
gitOk(work, "remote", "set-head", "origin", "-d");
assert.equal(decide("git push origin feat"), "ask", "unknown remote default branch asks");
assert.equal(decide("git push origin feat", { toolName: "exec_command", hookPath: codexHook, key: "cmd" }), "deny", "Codex denies an unknown remote default branch");
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
// main is protected by name and, here, as the remote's default branch too; it is reported once.
gitOk(work, "remote", "set-head", "origin", "main");
r = git(work, ["push", "-q", "origin", "feature:main"], agentEnv);
assert.match(r.stderr, /protected branch\(es\): main is blocked/, "each blocked branch is named once");
gitOk(work, "remote", "set-head", "origin", "trunk");

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

// The plans store branch is refused by the backstop too, and so are hand-made commits and merges in a
// checkout of it. `roborepo plans` runs its own Git with hooks off, so only hand-made ones get here.
r = git(work, ["push", "-q", "origin", "HEAD:repo-plans"], agentEnv);
assert.notEqual(r.status, 0, "pushing to repo-plans should be refused");
assert.match(r.stderr, /plans store/, "the refusal names the plans store");
gitOk(work, "switch", "-q", "-c", "repo-plans", "HEAD~1");
r = git(work, ["commit", "-q", "--allow-empty", "-m", "by hand"], agentEnv);
assert.notEqual(r.status, 0, "a commit on repo-plans should be refused");
assert.match(r.stderr, /roborepo plans/, "the commit refusal points at the plans commands");
r = git(work, ["merge", "-q", "--no-ff", "--no-edit", "feature"], agentEnv);
assert.notEqual(r.status, 0, "a merge commit on repo-plans should be refused");
assert.match(r.stderr, /plans store/);
gitOk(work, "merge", "--abort");
gitOk(work, "switch", "-q", "feature");
assert.equal(git(work, ["commit", "-q", "--allow-empty", "-m", "elsewhere"], agentEnv).status, 0, "other branches still commit");
gitOk(work, "branch", "-q", "-D", "repo-plans");

// The backstop refuses a merge commit or a rebase on a protected branch, however the command reached
// git; a feature branch still merges and rebases, and a person's own shell is unaffected.
gitOk(work, "switch", "-q", "-c", "master", "HEAD~1");
r = git(work, ["merge", "-q", "--no-ff", "--no-edit", "feature"], agentEnv);
assert.notEqual(r.status, 0, "a merge commit on master should be refused");
assert.match(r.stderr, /protected branch "master"/);
gitOk(work, "merge", "--abort");
r = git(work, ["rebase", "-q", "feature"], agentEnv);
assert.notEqual(r.status, 0, "rebasing master should be refused");
assert.match(r.stderr, /a rebase into protected branch "master"/);
r = git(work, ["rebase", "-q", "feature", "master"], agentEnv);
assert.notEqual(r.status, 0, "rebasing master by name should be refused");
gitOk(work, "switch", "-q", "-c", "side", "HEAD~1");
assert.equal(git(work, ["merge", "-q", "--no-ff", "--no-edit", "feature"], agentEnv).status, 0, "a feature branch takes merges");
gitOk(work, "switch", "-q", "master");
r = git(work, ["merge", "-q", "--no-ff", "--no-edit", "side"]);
assert.equal(r.status, 0, `a human merge is not affected: ${r.stderr}`);
gitOk(work, "switch", "-q", "feature");
gitOk(work, "branch", "-q", "-D", "master", "side");

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

// Deletes ask only in a checkout that has a protected branch checked out. The fixtures live under the
// system temp folder, which the hook treats as temp, so ROBOREPO_TEMP_ROOTS narrows the temp list
// to one scratch folder for these cases.
const scratch = path.join(tmp, "scratch");
const onMain = path.join(tmp, "on-main");
const onFeature = path.join(tmp, "on-feature");
fs.mkdirSync(scratch);
for (const [dir, branch] of [[onMain, "main"], [onFeature, "feature"]]) {
  gitOk(tmp, "init", "-q", "-b", branch, dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "a");
  gitOk(dir, "add", "a.txt");
  gitOk(dir, "commit", "-q", "-m", "init");
}
gitOk(onFeature, "branch", "main");
fs.symlinkSync(onMain, path.join(scratch, "main-link"));
const temps = { ROBOREPO_TEMP_ROOTS: scratch, TMPDIR: scratch };
const deleteCases = [
  [onMain, "rm a.txt", "ask"],
  [onMain, "rm -rf build", "ask"],
  [onMain, `rm ${path.join(scratch, "x")}`, "defer"],
  [onMain, 'rm "$TARGET"', "ask"],
  [onMain, "rm *.log", "ask"],
  [onMain, "rmdir empty", "ask"],
  [onMain, "unlink a.txt", "ask"],
  [onMain, "git rm a.txt", "ask"],
  [onMain, "git clean -fdx", "ask"],
  [onMain, "git clean -n", "defer"],
  [onMain, "git reset --hard", "ask"],
  [onMain, "git reset --soft HEAD~1", "defer"],
  [onMain, "git restore a.txt", "ask"],
  [onMain, "git restore --staged a.txt", "defer"],
  [onMain, "git restore --staged --worktree a.txt", "ask"],
  [onMain, "git stash drop", "ask"],
  [onMain, "git stash", "defer"],
  [onMain, "find . -name '*.tmp' -delete", "ask"],
  [onMain, "find . -name x -exec rm {} ;", "ask"],
  [onMain, `find ${scratch} -delete`, "defer"],
  [onMain, "find . -name x", "defer"],
  [onMain, "ls | xargs rm", "ask"],
  [onMain, "sh -c 'rm a.txt'", "ask"],
  [onMain, `cd ${onFeature} && rm a.txt`, "defer"],
  [onMain, `rm ${path.join(onFeature, "a.txt")}`, "defer"],
  [onMain, `git -C ${onFeature} rm a.txt`, "defer"],
  [onMain, "grep rm notes.txt", "defer"],
  [onFeature, "rm a.txt", "defer"],
  [onFeature, "git reset --hard", "defer"],
  [onFeature, `rm ${path.join(onMain, "a.txt")}`, "ask"],
  [onFeature, `git -C ${onMain} clean -f`, "ask"],
  // .git belongs to the checkout around it.
  [onMain, "rm -rf .git", "ask"],
  [onMain, "rm .git/index", "ask"],
  // Shell keywords, grouping, subshells, and command substitution do not hide the program.
  [onMain, 'for f in *.log; do rm "$f"; done', "ask"],
  [onMain, "if true; then rm a.txt; fi", "ask"],
  [onMain, "(rm a.txt)", "ask"],
  [onMain, "{ rm a.txt; }", "ask"],
  [onMain, "echo $(rm a.txt)", "ask"],
  [onMain, 'echo "$(rm a.txt)"', "ask"],
  [onMain, "echo `rm a.txt`", "ask"],
  [onMain, "echo 'rm a.txt'", "defer"],
  // Nor do wrappers.
  [onMain, "command rm a.txt", "ask"],
  [onMain, "env -i rm a.txt", "ask"],
  [onMain, "nohup rm a.txt", "ask"],
  [onMain, "time rm a.txt", "ask"],
  [onMain, "sudo -u someone rm a.txt", "ask"],
  [onMain, "FOO=1 rm a.txt", "ask"],
  // xargs options that take a value, and git stash options before the subcommand.
  [onMain, "ls | xargs -n 1 rm", "ask"],
  [onMain, "ls | xargs -I {} rm {}", "ask"],
  [onMain, "ls | xargs -P 4 rm -f", "ask"],
  [onMain, "ls | xargs -n 1 echo", "defer"],
  [onMain, "git stash -q drop", "ask"],
  // An expanded word is judged by its literal part: a $TMPDIR path is temp, a glob under a main
  // checkout is that checkout.
  [onMain, 'rm -rf "$TMPDIR/foo"', "defer"],
  [onMain, "rm -rf ${TMPDIR}/foo", "defer"],
  [scratch, `rm -rf ${onMain}/*.txt`, "ask"],
  [onFeature, `rm -rf ${onMain}/src/*`, "ask"],
  [onFeature, `rm -rf ${onFeature}/src/*`, "defer"],
  // cd -- and pushd are followed.
  [scratch, `cd -- ${onMain} && rm a.txt`, "ask"],
  [scratch, `pushd ${onMain} && rm a.txt`, "ask"],
  // Deleting a folder that holds a main checkout takes the checkout with it.
  [scratch, `rm -rf ${tmp}`, "ask"],
  [scratch, `rm -rf ${onFeature}`, "defer"],
  // A cd inside a subshell or substitution ends with it; popd and cd - return.
  [onMain, `(cd ${scratch} && rm x); rm a.txt`, "ask"],
  [onMain, `echo $(cd ${scratch}); rm a.txt`, "ask"],
  [onMain, `pushd ${scratch} && rm x && popd && rm a.txt`, "ask"],
  [onMain, `cd ${scratch} && rm x && cd - && rm a.txt`, "ask"],
  [onMain, `(cd ${scratch} && rm x)`, "defer"],
  // cd into $TMPDIR is followed, so a temp delete after it does not ask.
  [onMain, 'cd "$TMPDIR" && rm -rf x', "defer"],
  // A cd to a folder that does not exist fails, so the delete runs where the shell already was.
  [onMain, "cd $TMPDIR/sub && rm x", "ask"],
  [onMain, `sh -c 'cd ${scratch}/missing; rm a.txt'`, "ask"],
  [onMain, "cd $SOMEWHERE && rm x", "ask"],
  // A substitution inside double quotes does not hide the commands after the string.
  [onMain, 'git commit -m "$(cat x)" && rm a.txt', "ask"],
  [onMain, 'echo "a $(pwd) b"; rm a.txt', "ask"],
  [onMain, 'echo "`pwd`" ; rm a.txt', "ask"],
  [onMain, 'X="$(date)"; rm a.txt', "ask"],
  [onMain, 'echo "$(cd x) ; rm a.txt"', "defer"],
  // cd - with a redirect, popd after a popd in a subshell, and moves to unknown folders.
  [onMain, `cd ${scratch} && cd - >/dev/null && rm a.txt`, "ask"],
  [onMain, `pushd ${scratch} && (popd) && popd && rm a.txt`, "ask"],
  [scratch, `cd ${onMain} && cd $FOO && cd - && rm a.txt`, "ask"],
  [scratch, `pushd ${onMain} && pushd $FOO && popd && rm a.txt`, "ask"],
  // A cd to a substitution is not followed; it is not a bare cd home.
  [onMain, "cd $(git rev-parse --show-toplevel) && rm -rf src", "ask"],
  [onMain, "cd `pwd` && rm a.txt", "ask"],
  [onMain, `pushd ${scratch} && pushd $(pwd) && rm x`, "defer"],
  [onMain, 'cd ">x" && rm a.txt', "ask"],
  [onMain, "rm$(echo ' -rf') src", "ask"],
  [onMain, "find . -delete`true`", "ask"],
  // The words after a substitution stay part of its command.
  [onMain, "git -C $(pwd) clean -f", "ask"],
  [onMain, "rm -rf $TMPDIR/$(date)", "defer"],
  [onMain, "find $(pwd) -delete", "ask"],
  [onMain, `rm -rf "$(echo x)" && cd ${scratch} && rm x`, "ask"],
  [onMain, `echo $(cd ${scratch} && rm x) && rm -rf "$TMPDIR/y"`, "defer"],
  [onMain, `pushd ${scratch} >/dev/null && pushd >/dev/null && rm a.txt`, "ask"],
  // Bare cd goes home and bare pushd swaps; redirects around the target are dropped.
  [onMain, `cd ${scratch} && cd && cd - && rm x`, "defer"],
  [onMain, `pushd ${scratch} && pushd && rm a.txt`, "ask"],
  [onMain, `cd ${scratch} 2>/dev/null && rm x`, "defer"],
  [scratch, `cd ${onMain} >/dev/null && rm a.txt`, "ask"],
  [onMain, `cd > out ${scratch} && rm x`, "defer"],
  // `$TMPDIR/..` is judged where it lands, and a symlinked folder by what it points to.
  [scratch, `rm "$TMPDIR/../${path.basename(onMain)}/a.txt"`, "ask"],
  [scratch, `rm ${path.join(scratch, "main-link", "a.txt")}`, "ask"],
  [scratch, `rm ${path.join(scratch, "main-link")}`, "defer"],
  // Wrapper options: `command -p` takes no value, `sudo -u` does.
  [onMain, "command -p rm a.txt", "ask"],
  [onMain, "sudo -u root rm a.txt", "ask"],
  // Operands written into find -exec rm and after xargs rm count, wherever the command runs.
  [scratch, `find ${scratch} -maxdepth 0 -exec rm ${path.join(onMain, "a.txt")} {} \\;`, "ask"],
  [onMain, `cd ${scratch} && printf x | xargs rm ${path.join(onMain, "a.txt")}`, "ask"],
  [onMain, `cd ${scratch} && printf x | xargs rm`, "defer"],
  // A branch switch earlier in the command decides what a later delete or merge lands on.
  [onFeature, "git switch main && rm a.txt", "ask"],
  [onFeature, "git checkout main && rm a.txt", "ask"],
  [onFeature, "git checkout - && rm a.txt", "ask"],
  [onFeature, "git checkout -- a.txt && rm a.txt", "defer"],
  [onFeature, "git switch -c other && rm a.txt", "defer"],
];
for (const [cwd, command, expected] of deleteCases) {
  assert.equal(decide(command, { cwd, env: temps }), expected, `${path.basename(cwd)}: ${command}`);
}
// A verified push never covers a delete chained onto it: the push alone is allowed, and with a
// delete in a main checkout the whole command asks.
assert.equal(decide("git push origin feature", { env: temps }), "allow", "the push alone is verified");
assert.equal(decide(`git push origin feature && rm ${path.join(onMain, "a.txt")}`, { env: temps }), "ask", "a chained main delete asks");
assert.equal(decide(`git push origin feature && rm ${path.join(scratch, "x")}`, { env: temps }), "defer", "a chained temp delete drops the allow");
// Temp folders win: with the default temp roots, the system temp folder holding these fixtures is
// temp, so even the checkout on main deletes freely there.
assert.equal(decide("rm a.txt", { cwd: onMain }), "defer", "a checkout under a temp folder is temp");
// Extra protected names count, and Codex, which cannot ask, denies.
gitOk(onFeature, "switch", "-q", "-c", "release");
assert.equal(decide("rm a.txt", { cwd: onFeature, env: { ...temps, ROBOREPO_PROTECTED_BRANCHES: "release" } }), "ask", "extra protected names guard deletes");
gitOk(onFeature, "switch", "-q", "feature");
for (const command of ["rm a.txt", "git reset --hard"]) {
  assert.equal(decide(command, { cwd: onMain, env: temps, toolName: "exec_command", hookPath: codexHook, key: "cmd" }), "deny", `Codex denies: ${command}`);
}
const reason = spawnSync(process.execPath, [hook], {
  input: JSON.stringify({ cwd: onMain, tool_name: "Bash", tool_input: { command: "rm a.txt" } }),
  encoding: "utf8", env: { ...gitEnv, ...temps },
}).stdout;
assert.match(JSON.parse(reason).hookSpecificOutput.permissionDecisionReason, /protected branch "main"/, "the ask names the branch");

// Outside Claude's sandbox nothing limits a delete to the checkout, so any delete outside the temp
// folders asks; a temp delete still does not.
const unsandboxedDecision = (command, cwd) => {
  const out = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ cwd, tool_name: "Bash", tool_input: { command, dangerouslyDisableSandbox: true } }),
    encoding: "utf8", env: { ...gitEnv, ...temps },
  }).stdout;
  return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : "defer";
};
assert.equal(unsandboxedDecision(`rm ${path.join(onFeature, "a.txt")}`, onFeature), "ask", "an unsandboxed delete asks");
assert.equal(unsandboxedDecision(`rm ${path.join(scratch, "x")}`, onFeature), "defer", "an unsandboxed temp delete does not");

// Agents never merge into a protected branch: merge, pull, rebase, and cherry-pick are denied in a
// checkout that has one checked out, wherever the command runs from. A fast-forward-only update
// from the branch's own upstream, and stopping one in progress, are not.
const mergeCases = [
  [onMain, "git merge feature", "deny"],
  [onMain, "git merge --no-ff --no-edit feature", "deny"],
  [onMain, "git merge --ff-only feature", "deny"],
  [onMain, "git merge --continue", "deny"],
  [onMain, "git pull", "deny"],
  [onMain, "git pull --rebase origin main", "deny"],
  [onMain, "git pull --ff-only origin feature", "deny"],
  [onMain, "git rebase feature", "deny"],
  [onMain, "git cherry-pick abc123", "deny"],
  [onMain, "git fetch origin && git merge origin/feature", "deny"],
  [onFeature, `git -C ${onMain} merge feature`, "deny"],
  [onFeature, `cd ${onMain} && git merge feature`, "deny"],
  [onFeature, `(cd ${onMain} && git pull)`, "deny"],
  [onFeature, `sh -c 'cd ${onMain} && git rebase feature'`, "deny"],
  [onMain, "git pull --ff-only", "defer"],
  [onMain, "git pull --ff-only origin", "defer"],
  [onMain, "git pull --ff-only origin main", "defer"],
  [onMain, "git merge --ff-only origin/main", "defer"],
  [onMain, "git merge --ff-only @{u}", "defer"],
  [onMain, "git merge --abort", "defer"],
  [onMain, "git rebase --abort", "defer"],
  [onMain, "git cherry-pick --quit", "defer"],
  [onFeature, "git merge main", "defer"],
  [onFeature, "git pull origin main", "defer"],
  [onFeature, "git rebase main", "defer"],
  [onFeature, `cd ${onMain} && git merge feature; cd ${onFeature} && git merge main`, "deny"],
];
for (const [cwd, command, expected] of mergeCases) {
  assert.equal(decide(command, { cwd, env: temps }), expected, `${path.basename(cwd)}: ${command}`);
  if (expected === "deny") {
    assert.equal(decide(command, { cwd, env: temps, toolName: "exec_command", hookPath: codexHook, key: "cmd" }), "deny", `Codex: ${command}`);
  }
}
assert.equal(decide("git merge feature", { cwd: onFeature, env: { ...temps, ROBOREPO_PROTECTED_BRANCHES: "feature" } }), "deny", "extra protected names guard merges");
assert.equal(decide("git push origin feature && git merge feature", { cwd: onMain, env: temps }), "deny", "a chained merge into main drops the push allow");
const mergeReason = spawnSync(process.execPath, [hook], {
  input: JSON.stringify({ cwd: onMain, tool_name: "Bash", tool_input: { command: "git merge feature" } }),
  encoding: "utf8", env: { ...gitEnv, ...temps },
}).stdout;
assert.match(JSON.parse(mergeReason).hookSpecificOutput.permissionDecisionReason, /never merge into main.*sync-base/, "the deny names the way forward");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("protected-branch-push-check passed");
