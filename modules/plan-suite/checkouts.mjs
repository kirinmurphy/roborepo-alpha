// Every checkout of one known repository that Plans should read (pljvmyh §9): the main checkout
// plus each linked worktree and any other registered clone. Read from Git's administrative files,
// not from `git worktree list`, so enumerating checkouts costs no subprocess per repository.
import fs from "node:fs";
import path from "node:path";
import { checkoutRootsFor, mainCheckoutPath, resolveGitDir } from "../repositories/index.mjs";

// Returns [{ path, isMain, isWorktree, label }], main first. `label` names a non-main checkout for
// display: the worktree's administrative name, or a second clone's directory name. The main checkout
// comes from Git's common directory, never from the registry's first-registered root, which can be a
// worktree.
export function repositoryCheckouts(registry, repositoryId, { fsApi = fs } = {}) {
  const known = checkoutRootsFor(registry, repositoryId)
    .map((root) => realpathOrNull(root.path, fsApi))
    .filter((root) => root && isDirectory(root, fsApi));
  if (!known.length) return [];
  const main = mainCheckoutPath(known, { fsApi }) || known.find((root) => !resolveGitDir(root, { fsApi })?.isWorktree) || null;
  const checkouts = new Map();
  if (main) {
    checkouts.set(main, { path: main, isMain: true, isWorktree: false, label: null });
    const git = resolveGitDir(main, { fsApi });
    if (git) for (const worktree of linkedWorktrees(git.commonDir, fsApi)) checkouts.set(worktree.path, worktree);
  }
  for (const root of known) {
    if (checkouts.has(root)) continue;
    const git = resolveGitDir(root, { fsApi });
    checkouts.set(root, { path: root, isMain: false, isWorktree: Boolean(git?.isWorktree), label: git?.isWorktree ? git.worktreeName : path.basename(root) });
  }
  const [first, ...rest] = [...checkouts.values()];
  return first?.isMain
    ? [first, ...rest.sort((a, b) => a.label.localeCompare(b.label))]
    : [first, ...rest].sort((a, b) => a.label.localeCompare(b.label));
}

// <commonDir>/worktrees/<name>/gitdir holds the path of that worktree's `.git` file.
function linkedWorktrees(commonDir, fsApi) {
  let names = [];
  try {
    names = fsApi.readdirSync(path.join(commonDir, "worktrees"));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    let gitFile;
    try {
      gitFile = fsApi.readFileSync(path.join(commonDir, "worktrees", name, "gitdir"), "utf8").trim();
    } catch {
      continue;
    }
    const root = realpathOrNull(path.dirname(path.resolve(commonDir, "worktrees", name, gitFile)), fsApi);
    if (root && isDirectory(root, fsApi)) out.push({ path: root, isMain: false, isWorktree: true, label: name });
  }
  return out;
}

function realpathOrNull(value, fsApi) {
  try {
    return fsApi.realpathSync(value);
  } catch {
    return null;
  }
}

function isDirectory(value, fsApi) {
  try {
    return fsApi.statSync(value).isDirectory();
  } catch {
    return false;
  }
}
