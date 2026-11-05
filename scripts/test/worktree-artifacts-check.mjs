#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isolateGitConfig } from "./lib/git-config.mjs";
import { inventoryWorktree } from "../../modules/repositories/worktree-snapshot.mjs";
import { checkWorktreeRemoval } from "../../modules/repositories/worktree-guards.mjs";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-artifacts-")));
const restoreConfig = isolateGitConfig(root);
let cwd;
function git(...args) {
  const result = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function write(name, content = "fixture\n") {
  const file = path.join(cwd, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
try {
  function fixture(name) {
    cwd = path.join(root, name);
  fs.mkdirSync(cwd);
  git("init", "-qb", "main");
  write(".gitignore", ".venv/\n__pycache__/\n*.egg-info/\nbuild/\nnode_modules/\ntest-results/\nsrc/\nunknown file\n");
  write("pyproject.toml");
  write("nested/package.json", "{}\n");
  git("add", "."); git("commit", "-qm", "seed");
  for (const file of [".venv/pyvenv.cfg", "__pycache__/a.pyc", "pkg.egg-info/PKG-INFO", "build/output", "node_modules/output", "test-results/output", "nested/node_modules/output", "nested/test-results/output", "nested/build/output", "src/.venv/pyvenv.cfg"]) { if (name !== "symlink-root" || file !== ".venv/pyvenv.cfg") write(file); }
  }
  fixture("recognized");
  const guard = () => checkWorktreeRemoval({ worktree: { path: cwd, branch: "main" }, kind: "automatic", landed: true, worktreeRoot: root, mainPath: path.join(root, "other"), currentPath: path.join(root, "other") });
  assert.equal((await inventoryWorktree(cwd)).entries.some((entry) => entry.path.startsWith(".venv/")), false, "Python environment is excluded from preservation inventory");
  assert.equal((await guard()).ok, true, "only recognized ignored artifacts permit cleanup");
  const all = await inventoryWorktree(cwd, { pruneDisposable: false });
  assert.ok(all.entries.some((entry) => entry.path === ".venv/pyvenv.cfg"), "legacy verification includes artifacts");
  for (const file of ["unknown file", "unshaped/build/output", "unshaped/node_modules/output", "__pycache__/source.py", "src/valuable"]) {
    fixture(`protected-${file.replaceAll("/", "-")}`);
    write(file);
    assert.equal((await guard()).ok, false, `${file} is protected`);
    assert.ok((await inventoryWorktree(cwd)).entries.some((entry) => entry.path === file), `${file} remains in preservation inventory`);
  }
  fixture("tracked");
  write("build/tracked"); git("add", "-f", "build/tracked"); git("commit", "-qm", "tracked build file");
  write("build/tracked", "changed\n");
  assert.ok((await inventoryWorktree(cwd)).entries.some((entry) => entry.path === "build/tracked" && entry.layer === "tracked"));
  assert.equal((await guard()).ok, false, "tracked descendants prevent artifact exemption");
  fixture("nested-git");
  write(".venv/child/.git", "gitdir: /nonexistent\n");
  assert.equal((await guard()).ok, false, "nested Git metadata prevents disposable classification");
  await assert.rejects(() => inventoryWorktree(cwd), /nested repository/);
  fixture("symlink-child");
  const outside = path.join(root, "outside"); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "safe"), "safe");
  fs.symlinkSync(outside, path.join(cwd, ".venv/link"));
  assert.equal((await guard()).ok, true, "symlinks inside artifacts are not traversed");
  fixture("symlink-root");
  fs.symlinkSync(outside, path.join(cwd, ".venv"));
  assert.equal((await guard()).ok, false, "environment symlink itself is protected");
  assert.equal(fs.readFileSync(path.join(outside, "safe"), "utf8"), "safe");
  console.log("worktree artifacts: passed");
} finally {
  restoreConfig();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (error) { console.error(`Fixture cleanup failed: ${error.message}`); process.exitCode = 1; }
}
