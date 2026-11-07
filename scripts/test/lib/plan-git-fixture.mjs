// A hermetic home and Git fixture for the plan lifecycle checks: real repositories with a bare origin,
// a primary checkout on main, a plans store, and linked worktrees, driven through the real `roborepo`
// CLI entry point.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = path.join(repoRoot, "scripts/cli/main.mjs");

export function createPlanFixture(prefix) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const home = path.join(tmp, "home");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    ROBOREPO_STATE_ROOT: path.join(home, ".roborepo"),
    SKIP_MCP: "1",
    ROBOREPO_PRESETS_ONBOARD: "skip",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  for (const key of ["ROBOREPO_WORKSPACE_ROOT", "ROBOREPO_APP_ROOT", "GIT_DIR", "GIT_WORK_TREE"]) delete env[key];
  // In-process plan-suite calls shell out to Git too.
  Object.assign(process.env, { GIT_CONFIG_NOSYSTEM: "1", HOME: home, GIT_AUTHOR_NAME: env.GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL: env.GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME: env.GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL: env.GIT_COMMITTER_EMAIL });

  const git = (cwd, ...args) => {
    const result = spawnSync("git", ["-C", cwd, ...args], { env, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  const tryGit = (cwd, ...args) => spawnSync("git", ["-C", cwd, ...args], { env, encoding: "utf8" });
  const roborepo = (args, { cwd, env: overrides = {} }) => spawnSync(process.execPath, [cli, ...args], { cwd, env: { ...env, ...overrides }, encoding: "utf8" });
  const json = (result, label) => {
    try {
      return JSON.parse(result.stdout);
    } catch {
      return assert.fail(`${label}: expected JSON (exit ${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    }
  };

  // A repository with a bare `origin`, a primary checkout on main holding the code files, and a plans
  // store holding the `plans/...` files, set up through the real `roborepo plans init`. Pass
  // { store: false } for a repository that has not run it, or { refFormat: "reftable" } for that ref
  // storage. `clone(root, name)` adds a second machine.
  const repository = (name, files = {}, { store = true, refFormat = null } = {}) => {
    const format = refFormat ? [`--ref-format=${refFormat}`] : [];
    const origin = path.join(tmp, "remotes", `${name}.git`);
    fs.mkdirSync(path.dirname(origin), { recursive: true });
    git(tmp, "init", "--quiet", "--bare", "--initial-branch=main", ...format, origin);
    const root = path.join(tmp, name);
    git(tmp, "clone", "--quiet", ...format, origin, root);
    git(root, "symbolic-ref", "HEAD", "refs/heads/main");
    const code = Object.entries(files).filter(([file]) => !file.startsWith("plans/"));
    const plans = Object.entries(files).filter(([file]) => file.startsWith("plans/"));
    for (const [file, content] of code.length ? code : [["README.md", "fixture\n"]]) write(path.join(root, file), content);
    git(root, "add", "--", ".");
    git(root, "commit", "--quiet", "-m", "fixture");
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(root, "push", "--quiet", "origin", "main");
    if (!store) return root;
    initStore(root, name);
    if (plans.length) {
      const storeRoot = storePath(root);
      for (const [file, content] of plans) write(path.join(storeRoot, file), content);
      git(storeRoot, "add", "--", ...plans.map(([file]) => file));
      git(storeRoot, "commit", "--quiet", "-m", "fixture plans");
      git(storeRoot, "push", "--quiet", "origin", "repo-plans:repo-plans");
      git(storeRoot, "update-ref", "refs/remotes/origin/repo-plans", "HEAD");
    }
    return root;
  };

  const initStore = (root, name = path.basename(root)) => {
    const result = roborepo(["plans", "init", "--worktree-root", path.join(tmp, "worktree-root"), "--repo-name", name, "--json"], { cwd: root });
    assert.equal(result.status, 0, `plans init failed:\n${result.stdout}${result.stderr}`);
    return json(result, "plans init");
  };

  // The checked-out path of a repository's reserved plans worktree, as Git records it.
  const storePath = (root) => {
    const entry = git(root, "worktree", "list", "--porcelain").split("\n\n").find((item) => item.includes("branch refs/heads/repo-plans"));
    assert.ok(entry, "the repository has a plans worktree");
    return fs.realpathSync(/^worktree (.+)$/m.exec(entry)[1]);
  };

  // A second machine: a fresh clone of the same origin, not yet connected to the plans store.
  const clone = (root, name) => {
    const target = path.join(tmp, name);
    git(tmp, "clone", "--quiet", git(root, "remote", "get-url", "origin"), target);
    return target;
  };

  // A linked worktree on a new branch from main; returns { path, name, branch }.
  const worktree = (root, branch) => {
    const worktreePath = path.join(tmp, "worktrees", branch.replaceAll("/", "-"));
    git(root, "worktree", "add", "--quiet", "-b", branch, worktreePath, "main");
    return { path: worktreePath, name: path.basename(git(worktreePath, "rev-parse", "--absolute-git-dir")), branch };
  };

  const commit = (cwd, message, files) => {
    for (const [file, content] of Object.entries(files)) write(path.join(cwd, file), content);
    git(cwd, "add", "--", ...Object.keys(files));
    git(cwd, "commit", "--quiet", "-m", message);
    return git(cwd, "rev-parse", "HEAD");
  };

  // A portal under test can still be writing in a store when a suite ends.
  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  return { tmp, env, git, tryGit, roborepo, json, repository, initStore, storePath, clone, worktree, commit, cleanup };
}

// A plan document that satisfies every non-terminal lifecycle's structure rules. `tasks` are the
// Implementation checklist lines; `extra` is appended verbatim.
export function planDoc({ id, title = id, nextAction = "Implement the first task.", tasks = ["- [ ] Build the thing."], worktree = "", extra = "" }) {
  return `---
id: ${id}
next_action: ${nextAction}
blocked_by: []
depends_on: []
related: []
reviewed_commit:
worktree:${worktree ? ` ${worktree}` : ""}
---

# ${title}

## Summary

Fixture plan.

## Goals

Do the thing.

## Context

Fixture context.

## Proposed design

Fixture design.

## Implementation checklist

${tasks.join("\n")}

## Validation

The thing is done.
${extra}`;
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
