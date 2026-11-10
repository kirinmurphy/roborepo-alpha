import path from "node:path";
import { locateStore, readStoreConfig } from "../../modules/plan-suite/plan-store.mjs";

function appendPathSegment(root, segment) {
  return `${root.replace(/[\\/]+$/, "")}/${segment}`;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// The current repository's implementation worktrees, and its reserved plans worktree, sit under
// <worktreeRoot>/<worktreeRepoName>. A repository with no plans store contributes no roots, so
// rendering outside a plan-suite repository widens nothing.
export function loadPermissionWorkspaceRootsForCwd(cwd = process.cwd()) {
  const store = locateStore(cwd);
  if (!store || store.missing) return [];
  const config = readStoreConfig(store.root);
  if (!config) return [];
  const roots = [];
  const worktreeRoot = nonEmpty(config.worktreeRoot);
  if (worktreeRoot) roots.push(appendPathSegment(worktreeRoot, nonEmpty(config.worktreeRepoName) ?? path.basename(store.primary)));
  if (Array.isArray(config.workspaceRoots)) {
    for (const root of config.workspaceRoots) {
      if (nonEmpty(root)) roots.push(root.trim());
    }
  }
  return [...new Set(roots)];
}
