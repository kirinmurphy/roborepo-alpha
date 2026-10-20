// Every checkout of one known repository that Plans should read (pljvmyh §9): the main checkout
// plus each linked worktree and any other registered clone. Read from Git's administrative files,
// not from `git worktree list`, so enumerating checkouts costs no subprocess per repository.
import fs from "node:fs";
import path from "node:path";
import { checkoutRootsFor, mainCheckoutPath, resolveGitDir } from "../repositories/index.mjs";
import { linkedWorktrees } from "../repositories/worktree-inventory.mjs";

// Returns [{ path, isMain, isWorktree, label, branch }], main first. `label` names a non-main checkout
// for display: the worktree's administrative name, or a second clone's directory name. `branch` is a
// linked worktree's checked-out branch, null when detached and for every other checkout. The main checkout
// comes from Git's common directory, never from the registry's first-registered root, which can be a
// worktree.
export function repositoryCheckouts(registry, repositoryId, { fsApi = fs } = {}) {
  const known = checkoutRootsFor(registry, repositoryId)
    .map((root) => realpathOrNull(root.path, fsApi))
    .filter((root) => root && isDirectory(root, fsApi));
  if (!known.length) return [];
  const main = mainCheckoutPath(known, { fsApi }) || known.find((root) => !resolveGitDir(root, { fsApi })?.isWorktree) || null;
  const checkouts = new Map(main ? mainAndLinkedCheckouts(main, { fsApi }).map((checkout) => [checkout.path, checkout]) : []);
  for (const root of known) {
    if (checkouts.has(root)) continue;
    const git = resolveGitDir(root, { fsApi });
    checkouts.set(root, { path: root, isMain: false, isWorktree: Boolean(git?.isWorktree), label: git?.isWorktree ? git.worktreeName : path.basename(root), branch: null });
  }
  const [first, ...rest] = [...checkouts.values()];
  return first?.isMain
    ? [first, ...rest.sort((a, b) => a.label.localeCompare(b.label))]
    : [first, ...rest].sort((a, b) => a.label.localeCompare(b.label));
}

// The main checkout at `main` followed by each of its linked worktrees that still exists, in the
// shape repositoryCheckouts returns. Needs no registry, so a CLI run inside one repository can use it.
export function mainAndLinkedCheckouts(main, { fsApi = fs } = {}) {
  const checkouts = [{ path: main, isMain: true, isWorktree: false, label: null, branch: null }];
  const git = resolveGitDir(main, { fsApi });
  if (git) for (const worktree of linkedWorktrees(git.commonDir, { fsApi })) {
    if (!worktree.prunable) checkouts.push({ path: worktree.path, isMain: false, isWorktree: true, label: worktree.name, branch: worktree.branch });
  }
  return checkouts;
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
