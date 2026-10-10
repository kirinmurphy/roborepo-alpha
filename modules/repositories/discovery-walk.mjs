// Bounded repository traversal for directory sources and `roborepo plans repair`. Moved here from
// modules/plan-suite so repository discovery has one owner; limits and eligibility are unchanged
// (pljvmyh §2), so a directory source finds exactly what the old Plans folder scan found.
import fs from "node:fs";
import path from "node:path";
import { resolveGitDir } from "./identity.mjs";

export const DEFAULT_IGNORED_DIRECTORIES = Object.freeze([
  "node_modules", ".git", "vendor", "dist", "build",
  ".cache", "coverage", ".next", ".venv", "__pycache__",
]);
export const DISCOVERY_MAX_DEPTH = 6;
export const DISCOVERY_MAX_REPOSITORIES = 250;

// Overridable so tests can force truncation deterministically (0ms against a normal-size tree)
// instead of needing a real slow scan or a huge synthetic directory tree.
function discoveryTimeBudgetMs() {
  return process.env.DISCOVERY_TIME_BUDGET_MS !== undefined ? Number(process.env.DISCOVERY_TIME_BUDGET_MS) : 5000;
}

// A folder is a repository root when it has a `.git` entry or a `docs/plans` directory. Linked
// worktrees are not roots of their own: the main checkout stands for the repository, and Plans
// reaches its worktrees through Git.
export function isRepositoryRoot(dir, { fsApi = fs } = {}) {
  return fsApi.existsSync(path.join(dir, ".git")) || fsApi.existsSync(path.join(dir, "docs", "plans"));
}

// Walks each root and returns the realpaths of eligible repository roots beneath it, stopping at
// each one found. `errors` lists unreadable folders and missing roots; `truncated` means the time
// budget or repository cap cut the walk short, so the result must not be presented as complete.
export function walkRepositoryRoots(roots, {
  ignored = DEFAULT_IGNORED_DIRECTORIES,
  maxDepth = DISCOVERY_MAX_DEPTH,
  maxRepositories = DISCOVERY_MAX_REPOSITORIES,
  timeBudgetMs = discoveryTimeBudgetMs(),
  fsApi = fs,
} = {}) {
  const ignoredNames = new Set(ignored);
  const repositories = [];
  const errors = [];
  const seen = new Set();
  const visitedReal = new Set(); // realpath'd dirs already descended into (symlink-cycle guard)
  let truncated = false;
  const deadline = Date.now() + timeBudgetMs;

  const addRepository = (dir) => {
    if (repositories.length >= maxRepositories) {
      truncated = true;
      return;
    }
    const real = fsApi.realpathSync(dir);
    const git = fsApi.existsSync(path.join(real, ".git")) ? resolveGitDir(real, { fsApi }) : null;
    if (git?.isWorktree) return;
    if (!seen.has(real)) {
      seen.add(real);
      repositories.push(real);
    }
  };

  const walk = (dir, depth) => {
    if (truncated) return;
    // >= not >: with a 0ms budget the deadline equals the start time, and a walk that begins within
    // the same millisecond would otherwise skip the check entirely.
    if (Date.now() >= deadline) {
      truncated = true;
      return;
    }
    if (depth > maxDepth) return;
    let real;
    try {
      real = fsApi.realpathSync(dir);
    } catch {
      return;
    }
    if (visitedReal.has(real)) return;
    visitedReal.add(real);

    if (isRepositoryRoot(dir, { fsApi })) {
      addRepository(dir);
      return;
    }

    let entries = [];
    try {
      entries = fsApi.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      // Unreadable mid-walk: skip this branch rather than abort the whole scan.
      errors.push({ root: dir, error: String(err?.message || err) });
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      if (ignoredNames.has(entry.name)) continue;
      if (truncated) return;
      walk(path.join(dir, entry.name), depth + 1);
    }
  };

  for (const root of roots) {
    try {
      if (!fsApi.statSync(root).isDirectory()) throw new Error("not a directory");
    } catch (err) {
      errors.push({ root, error: String(err?.message || err) });
      continue;
    }
    walk(root, 0);
  }

  return { repositories, errors, truncated };
}

// How a user-entered path should be treated, decided only when it can be read: an eligible
// repository root is `repository`, any other readable directory is `directory`. A missing or
// unreadable path is `unresolved` and the user must choose — guessing would let the path broaden
// discovery later once it becomes readable.
export function classifySourcePath(sourcePath, { fsApi = fs } = {}) {
  try {
    if (!fsApi.statSync(sourcePath).isDirectory()) return "unresolved";
    fsApi.readdirSync(sourcePath);
  } catch {
    return "unresolved";
  }
  return isRepositoryRoot(sourcePath, { fsApi }) ? "repository" : "directory";
}
