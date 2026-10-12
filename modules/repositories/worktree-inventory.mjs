import fs from "node:fs";
import path from "node:path";
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
  return { main, worktrees };
}

// Git keeps one administrative directory per linked worktree. Read it directly so inventory does
// not spawn a Git process for every checkout during a Runtime refresh.
export function linkedWorktrees(commonDir, { fsApi = fs } = {}) {
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
    const head = readOrNull(path.join(adminDir, "HEAD"), fsApi)?.trim() || null;
    const branch = head?.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : null;
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
