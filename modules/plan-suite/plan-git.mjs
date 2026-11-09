// Code-branch helpers for the plan-suite operations that inspect or merge implementation checkouts:
// base synchronization, the completion preflight, and approval freshness. Plan commits go through
// plan-store.mjs instead. This wrapper preserves raw status
// columns and uses a longer timeout than the repository executor's default polling reads.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { RESERVED_PLANS_BRANCH, RESERVED_PLANS_LOCK_REASON } from "../repositories/worktree-inventory.mjs";
import { domainError } from "./index.mjs";

const GIT_TIMEOUT_MS = 60_000;

export function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  // `raw` keeps leading whitespace, which porcelain status lines use as a status column.
  return { ok: result.status === 0, status: result.status, raw: result.stdout || "", stdout: (result.stdout || "").trim(), stderr: (result.stderr || "").trim() };
}

export function gitOrThrow(cwd, args) {
  const result = git(cwd, args);
  if (!result.ok) throw domainError("MOVE_FAILED", `git ${args[0]} failed.`, { details: [result.stderr] });
  return result;
}

export function primaryCheckout(cwd) {
  const list = git(cwd, ["worktree", "list", "--porcelain"]);
  if (!list.ok) throw domainError("INVALID_CHANGE", "Not inside a Git repository.", { details: [list.stderr] });
  const first = /^worktree (.+)$/m.exec(list.stdout);
  return fs.realpathSync(first[1]);
}

export function topLevel(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  return result.ok ? fs.realpathSync(result.stdout) : "";
}

export function currentBranch(cwd) {
  return git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout;
}

// The code branch gates compare against when no caller names one: the remote's default, then main or
// master. Null when none of those says, so a caller refuses rather than guessing, because treating
// whichever branch is checked out as the base would make every comparison empty.
export function repositoryBaseBranch(cwd) {
  const remote = git(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (remote.ok && remote.stdout) return remote.stdout.replace(/^refs\/remotes\/origin\//, "");
  return ["main", "master"].find((name) => git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]).ok) ?? null;
}

// Finds the linked worktree whose Git administrative name (`.git/worktrees/<name>`) is `name`. The
// main checkout has no administrative name and can never match. Returns null when none does.
export function linkedWorktreeNamed(primary, name) {
  if (!name) return null;
  const entries = git(primary, ["worktree", "list", "--porcelain"]).stdout.split("\n\n").slice(1);
  for (const entry of entries) {
    const worktreePath = /^worktree (.+)$/m.exec(entry)?.[1];
    if (!worktreePath || !fs.existsSync(worktreePath)) continue;
    if (worktreeName(worktreePath) === name) {
      const branch = (/^branch refs\/heads\/(.+)$/m.exec(entry)?.[1]) || null;
      const reserved = branch === RESERVED_PLANS_BRANCH || /^locked (.*)$/m.exec(entry)?.[1] === RESERVED_PLANS_LOCK_REASON;
      return { name, path: fs.realpathSync(worktreePath), branch, reserved };
    }
  }
  return null;
}

export function findLinkedWorktree(primary, name) {
  const found = linkedWorktreeNamed(primary, name);
  if (found?.reserved) {
    throw domainError("INVALID_CHANGE", `${name} is the reserved plans worktree, which never implements a plan.`, {
      resolution: "Create a separate worktree for the implementation and pass its name.",
    });
  }
  if (found) return found;
  throw domainError("PLAN_NOT_FOUND", `No linked worktree is named ${name}.`, {
    resolution: "Pass the worktree's Git administrative name: basename of `git -C <worktree> rev-parse --absolute-git-dir`.",
  });
}

export function worktreeName(checkoutPath) {
  return path.basename(git(checkoutPath, ["rev-parse", "--absolute-git-dir"]).stdout);
}

// Files on the plans branch that still name `oldPath`. Reported, never edited: rewriting them would
// put files other than the plan into a plan-only transition commit.
export function linksToPath(storeRoot, oldPath) {
  if (!oldPath) return [];
  const found = git(storeRoot, ["grep", "-l", "-F", "--", oldPath]);
  return found.ok ? found.stdout.split("\n").filter(Boolean) : [];
}

// The paths whose content differs from HEAD in any way: staged, unstaged, or untracked.
export function dirtyPaths(cwd, paths = []) {
  const status = git(cwd, ["status", "--porcelain", "--untracked-files=all", ...(paths.length ? ["--", ...paths] : [])]).raw;
  return status.split("\n").filter(Boolean);
}
