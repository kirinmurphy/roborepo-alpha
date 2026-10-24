import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function assertCleanWorktree(repoRoot) {
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(status.status, 0, "git status failed");
  assert.equal(
    status.stdout.trim(),
    "",
    "retained-artifact mode requires a clean Git worktree so the recorded source commit describes the bytes being transferred",
  );
}

export function packTarball(repoRoot, packDest) {
  const result = spawnSync(
    "npm",
    ["pack", "--json", "--pack-destination", packDest],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `npm pack failed\n${result.stderr}`);
  // npm 11 and earlier print an array of pack entries; npm 12 prints an object keyed by package name.
  const report = JSON.parse(result.stdout);
  const [entry] = Array.isArray(report) ? report : Object.values(report);
  assert.ok(entry?.filename, "npm pack did not report a filename");
  return { tarballPath: path.join(packDest, entry.filename), tarballName: entry.filename };
}

export function installTarball(dirs, tarballPath, env) {
  const result = spawnSync(
    "npm",
    ["install", "-g", "--prefix", dirs.prefix, "--cache", dirs.cache, tarballPath],
    { cwd: dirs.cwd, env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `npm install of packed tarball failed\n${result.stderr}`);
}

export function smokeEnv(dirs) {
  const toolBin = path.join(dirs.sandbox, "tools");
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, "npm_execpath must be set when running package smoke through npm");
  fs.mkdirSync(toolBin, { recursive: true });
  try {
    fs.symlinkSync(process.execPath, path.join(toolBin, "node"));
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
  fs.writeFileSync(
    path.join(toolBin, "npm"),
    `#!/bin/sh\nexec "${process.execPath}" "${npmCli}" "$@"\n`,
    { mode: 0o755 },
  );
  const pathEntries = [
    toolBin,
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].filter(Boolean);
  return {
    PATH: [...new Set(pathEntries)].join(path.delimiter),
    HOME: dirs.home,
    ROBOREPO_MODE: "package",
    ROBOREPO_STATE_ROOT: dirs.stateRoot,
    ROBOREPO_WORKSPACE_ROOT: dirs.workspaceRoot,
    ROBOREPO_PRESETS_ONBOARD: "skip",
  };
}
