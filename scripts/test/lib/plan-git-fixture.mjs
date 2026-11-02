// A hermetic home and Git fixture for the plan lifecycle checks: real repositories with a primary
// checkout on main and linked worktrees, driven through the real `roborepo` CLI entry point.
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
  const roborepo = (args, { cwd }) => spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: "utf8" });
  const json = (result, label) => {
    try {
      return JSON.parse(result.stdout);
    } catch {
      return assert.fail(`${label}: expected JSON (exit ${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    }
  };

  // A repository whose primary checkout is on main, with each { path: content } committed.
  const repository = (name, files) => {
    const root = path.join(tmp, name);
    for (const [file, content] of Object.entries(files)) write(path.join(root, file), content);
    git(tmp, "init", "--quiet", "--initial-branch=main", root);
    git(root, "add", "--", ".");
    git(root, "commit", "--quiet", "-m", "fixture");
    return root;
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

  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
  return { tmp, env, git, tryGit, roborepo, json, repository, worktree, commit, cleanup };
}

// A plan document that satisfies every non-terminal lifecycle's structure rules. `tasks` are the
// Implementation checklist lines; `extra` is appended verbatim.
export function planDoc({ id, title = id, nextAction = "Implement the first task.", tasks = ["- [ ] Build the thing."], worktree = "", extra = "" }) {
  return `---
id: ${id}
priority: medium
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
