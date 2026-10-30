#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isolateGitConfig } from "./lib/git-config.mjs";

const appRoot = path.resolve(".");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-git-inventory-"));
isolateGitConfig(tempRoot);

try {
  const home = path.join(tempRoot, "home");
  const projects = path.join(home, "projects");
  const syncProjects = path.join(home, "sync-projects");
  const repo = path.join(projects, "needs-work");
  const missingUpstream = path.join(projects, "missing-upstream");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(missingUpstream, { recursive: true });

  run("git", ["init", "--initial-branch=main"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "tracked.txt"), "baseline\n");
  run("git", ["add", "tracked.txt"], { cwd: repo });
  run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "baseline"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "todo.txt"), "migrate me\n");

  run("git", ["init", "--initial-branch=main"], { cwd: missingUpstream });
  fs.writeFileSync(path.join(missingUpstream, "tracked.txt"), "baseline\n");
  run("git", ["add", "tracked.txt"], { cwd: missingUpstream });
  run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "baseline"], { cwd: missingUpstream });
  run("git", ["checkout", "-b", "production_env_prep"], { cwd: missingUpstream });
  run("git", ["remote", "add", "origin", "https://example.invalid/repo.git"], { cwd: missingUpstream });
  run("git", ["config", "branch.production_env_prep.remote", "origin"], { cwd: missingUpstream });
  run("git", ["config", "branch.production_env_prep.merge", "refs/heads/production_env_prep"], { cwd: missingUpstream });

  const result = spawnSync(process.execPath, [
    path.join(appRoot, "scripts", "cli", "main.mjs"),
    "git",
    "inventory",
    "~/projects",
    "--compact",
    "--max-depth",
    "1",
  ], {
    cwd: appRoot,
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Root: ${escapeRegExp(projects)}`));
  assert.match(result.stdout, /\.\/needs-work/);
  assert.match(result.stdout, /current: main \| dirty 1 \| ahead unknown \| behind unknown \| upstream none/);
  assert.match(result.stdout, /action: add remote \| set upstream \| commit\/stash local changes/);
  assert.doesNotMatch(result.stdout, /`/);

  const origin = path.join(tempRoot, "origin.git");
  const seed = path.join(tempRoot, "sync-seed");
  const syncRepo = path.join(syncProjects, "sync-work");
  fs.mkdirSync(syncProjects, { recursive: true });
  run("git", ["init", "--bare", "--initial-branch=main", origin]);
  run("git", ["init", "--initial-branch=main"], { cwd: seed, mkdir: true });
  fs.writeFileSync(path.join(seed, "base.txt"), "base\n");
  run("git", ["add", "."], { cwd: seed });
  run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "base"], { cwd: seed });
  run("git", ["remote", "add", "origin", origin], { cwd: seed });
  run("git", ["push", "-u", "origin", "main"], { cwd: seed });
  run("git", ["checkout", "-b", "behind-only"], { cwd: seed });
  fs.writeFileSync(path.join(seed, "remote.txt"), "remote\n");
  run("git", ["add", "."], { cwd: seed });
  run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "remote"], { cwd: seed });
  run("git", ["push", "-u", "origin", "behind-only"], { cwd: seed });
  run("git", ["clone", origin, syncRepo]);
  run("git", ["switch", "-c", "ahead", "origin/main"], { cwd: syncRepo });
  fs.writeFileSync(path.join(syncRepo, "local.txt"), "local\n");
  run("git", ["add", "."], { cwd: syncRepo });
  run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "local"], { cwd: syncRepo });
  run("git", ["switch", "-c", "behind-only", "origin/main"], { cwd: syncRepo });
  run("git", ["config", "branch.behind-only.remote", "origin"], { cwd: syncRepo });
  run("git", ["config", "branch.behind-only.merge", "refs/heads/behind-only"], { cwd: syncRepo });
  run("git", ["checkout", "behind-only"], { cwd: seed });
  fs.writeFileSync(path.join(seed, "remote-fresh.txt"), "fresh\n");
  run("git", ["add", "."], { cwd: seed });
  run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fresh remote"], { cwd: seed });
  run("git", ["push"], { cwd: seed });

  const syncResult = spawnSync(process.execPath, [
    path.join(appRoot, "scripts", "cli", "main.mjs"),
    "git",
    "remote-sync-check",
    "~/sync-projects",
    "--compact",
    "--max-depth",
    "1",
  ], {
    cwd: appRoot,
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });

  assert.equal(syncResult.status, 0, syncResult.stderr);
  assert.match(syncResult.stdout, /Remote Sync Check/);
  assert.match(syncResult.stdout, /Local branches with commits ahead of remote/);
  assert.match(syncResult.stdout, /\.\/sync-work/);
  assert.match(syncResult.stdout, /ahead — 1 ahead/);
  assert.doesNotMatch(syncResult.stdout, /behind-only/);
  assert.doesNotMatch(syncResult.stdout, /Add a remote/);
  assert.doesNotMatch(syncResult.stdout, /ahead unknown/);
  assert.doesNotMatch(syncResult.stdout, /fatal: ambiguous argument/);
  assert.doesNotMatch(syncResult.stdout, /dirty/);

  const failedSync = spawnSync(process.execPath, [
    path.join(appRoot, "scripts", "cli", "main.mjs"),
    "git",
    "remote-sync-check",
    "~/projects",
    "--compact",
    "--max-depth",
    "1",
  ], {
    cwd: appRoot,
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  assert.notEqual(failedSync.status, 0, "refresh failures make direct mode non-zero");
  assert.match(failedSync.stdout, /Could not verify remote state/);
  assert.match(failedSync.stdout, /\.\/missing-upstream/);
  console.log("git-inventory-check passed");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function run(command, args, options) {
  if (options?.mkdir) {
    fs.mkdirSync(options.cwd, { recursive: true });
    options = { cwd: options.cwd };
  }
  const result = spawnSync(command, args, { ...options, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
