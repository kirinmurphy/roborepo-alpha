#!/usr/bin/env node
// Makes sure this checkout has its own node_modules matching package-lock.json before anything
// imports @playwright/test, and runs `npm ci` when it does not.
//
// Most work happens in git worktrees, and a fresh worktree has no node_modules. One outside the main
// checkout then fails with ERR_MODULE_NOT_FOUND; one nested inside it silently resolves the main
// checkout's packages through Node's parent-directory lookup, so a branch that bumps Playwright
// would test against main's version. Checking this checkout's own node_modules covers both.
//
// The dev dependency graph is a few packages (~18 MB), and `npm ci --prefer-offline` reuses npm's
// cache, so the install is cheap enough to run on demand. The Chromium browser is not handled here:
// it lives in Playwright's per-user cache, shared by every checkout.
//
// Use as a module (`await ensureDevDependencies(repoRoot)`) before a dynamic import of Playwright,
// or run directly: exits 0 when node_modules is current or the install succeeded, 1 otherwise.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// npm writes node_modules/.package-lock.json (the "hidden lockfile") describing what it installed.
// Returns the lockfile entries the hidden lockfile does not match, as "<path>@<version>" strings;
// an empty list means node_modules is current. Optional packages skipped for another platform
// (fsevents on Linux) are absent from the hidden lockfile by design and do not count.
export function staleDependencies(lockfile, hiddenLockfile) {
  const installed = hiddenLockfile?.packages ?? {};
  const stale = [];
  for (const [entryPath, entry] of Object.entries(lockfile?.packages ?? {})) {
    if (entryPath === "") continue;
    const have = installed[entryPath];
    if (!have && entry.optional) continue;
    if (have?.version !== entry.version) stale.push(`${entryPath}@${entry.version}`);
  }
  return stale;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Returns null when node_modules is current, otherwise a short reason for the install.
export function installReason(repoRoot) {
  const lockfile = readJson(path.join(repoRoot, "package-lock.json"));
  if (!lockfile) return null;
  const hidden = readJson(path.join(repoRoot, "node_modules", ".package-lock.json"));
  if (!hidden) return "node_modules is missing";
  const stale = staleDependencies(lockfile, hidden);
  if (stale.length === 0) return null;
  return `node_modules does not match package-lock.json (${stale.slice(0, 3).join(", ")}${stale.length > 3 ? ", ..." : ""})`;
}

export function ensureDevDependencies(repoRoot) {
  const reason = installReason(repoRoot);
  if (!reason) return true;
  console.error(`portal UI: ${reason}; running npm ci`);
  const result = spawnSync("npm", ["ci", "--prefer-offline", "--no-audit", "--no-fund"], {
    cwd: repoRoot,
    // npm output goes to stderr so callers that read this process's stdout see only their own.
    stdio: ["ignore", process.stderr, "inherit"],
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    console.error(`portal UI: npm ci failed (${result.error?.message ?? `exit ${result.status}`})`);
    return false;
  }
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  process.exit(ensureDevDependencies(repoRoot) ? 0 : 1);
}
