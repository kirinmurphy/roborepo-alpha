import fs from "node:fs";
import path from "node:path";
import { runGitProcessSync } from "./git-exec.mjs";
import { mainCheckoutPath, resolveGitDir } from "./identity.mjs";
import { checkoutRootsFor } from "./registry.mjs";

export function repositoryWorktrees(registry, repositoryId, options = {}) {
  const roots = checkoutRootsFor(registry, repositoryId).map((root) => root.path);
  const main = mainCheckoutPath(roots, options);
  const commonDirs = new Set();
  for (const root of roots) {
    const git = resolveGitDir(root, options);
    if (git?.commonDir && path.basename(git.commonDir) === ".git") commonDirs.add(git.commonDir);
  }
  const worktrees = [...commonDirs].flatMap((commonDir) => linkedWorktrees(commonDir, options).map((worktree) => ({ ...worktree, mainPath: path.dirname(commonDir) })));
  return { main, worktrees, commonDirs: [...commonDirs] };
}

// The branch checked out in a repository's reserved plans worktree. That worktree holds no code, so
// it is never a cleanup candidate, a Home worktree, or a place a plan can be implemented.
export const RESERVED_PLANS_BRANCH = "repo-plans";

// A reftable repository keeps refs in binary tables and leaves this placeholder in every HEAD file.
const REFTABLE_HEAD_PLACEHOLDER = "ref: refs/heads/.invalid";
const reftableHeads = new Map();

// Git keeps one administrative directory per linked worktree. Read it directly so inventory does
// not spawn a Git process for every checkout during a Runtime refresh. Only a reftable worktree needs
// Git, and only when its table list changed. The reserved plans worktree is left out unless the
// caller is the plan store.
export function linkedWorktrees(commonDir, { fsApi = fs, includeReserved = false } = {}) {
  let names;
  try {
    names = fsApi.readdirSync(path.join(commonDir, "worktrees"));
  } catch {
    return [];
  }
  const worktrees = [];
  for (const name of names) {
    const adminDir = path.join(commonDir, "worktrees", name);
    let gitFile;
    try {
      gitFile = fsApi.readFileSync(path.join(adminDir, "gitdir"), "utf8").trim();
    } catch {
      continue;
    }
    const checkoutPath = path.dirname(path.resolve(adminDir, gitFile));
    const root = realpathOrNull(checkoutPath, fsApi);
    const prunable = !root || !isDirectory(root, fsApi);
    const headFile = readOrNull(path.join(adminDir, "HEAD"), fsApi)?.trim() || null;
    const head = headFile === REFTABLE_HEAD_PLACEHOLDER ? reftableHead(adminDir, fsApi) : headFile;
    const branch = head?.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : null;
    if (branch === RESERVED_PLANS_BRANCH && !includeReserved) continue;
    worktrees.push({
      path: root || checkoutPath,
      name,
      branch,
      detachedCommit: head && !branch ? head : null,
      detached: Boolean(head && !branch),
      locked: exists(path.join(adminDir, "locked"), fsApi),
      prunable,
    });
  }
  return worktrees;
}

// HEAD as its file would read in the files format: `ref: <branch>`, or the commit id when detached.
function reftableHead(adminDir, fsApi) {
  const tables = readOrNull(path.join(adminDir, "reftable", "tables.list"), fsApi);
  const cached = reftableHeads.get(adminDir);
  if (cached && tables !== null && cached.tables === tables) return cached.head;
  const symbolic = runGitProcessSync(adminDir, ["symbolic-ref", "--quiet", "HEAD"]);
  const direct = symbolic.ok ? null : runGitProcessSync(adminDir, ["rev-parse", "--verify", "-q", "HEAD"]);
  const head = symbolic.ok ? `ref: ${symbolic.stdout.trim()}` : (direct.ok ? direct.stdout.trim() : null);
  if (tables !== null) reftableHeads.set(adminDir, { tables, head });
  return head;
}

function readOrNull(file, fsApi) {
  try { return fsApi.readFileSync(file, "utf8"); } catch { return null; }
}

function exists(file, fsApi) {
  try { fsApi.statSync(file); return true; } catch { return false; }
}

function realpathOrNull(value, fsApi) {
  try { return fsApi.realpathSync(value); } catch { return null; }
}

function isDirectory(value, fsApi) {
  try { return fsApi.statSync(value).isDirectory(); } catch { return false; }
}
