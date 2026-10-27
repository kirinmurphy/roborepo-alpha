#!/usr/bin/env node
import assert from "node:assert/strict";
import { isolateGitConfig } from "./lib/git-config.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runGitProcess } from "../../modules/repositories/git-exec.mjs";
import { removeWorktree, retryArchivedBranchRetirement } from "../../modules/repositories/worktree-removal.mjs";
import { createWorktreeSnapshot, restoreWorktreeSnapshot, listWorktreeSnapshots, inventoryWorktree } from "../../modules/repositories/worktree-snapshot.mjs";
import { recordRepositoryDiscovery } from "../cli/repositories.mjs";
import { archiveRepositoryWorktree, cleanupWorktrees } from "../cli/worktree-cleanup.mjs";
import { assessWorktreePreservation } from "../../modules/repositories/worktree-preservation.mjs";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-snapshot-test-")));
const restoreGitConfig = isolateGitConfig(root);
function git(cwd, ...args) {
  const result = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function write(cwd, name, bytes) { fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true }); fs.writeFileSync(path.join(cwd, name), bytes); }
try {
  const main = path.join(root, "repo"); fs.mkdirSync(main);
  git(main, "init", "-qb", "main");
  write(main, "seed", "seed\n"); git(main, "add", "."); git(main, "commit", "-qm", "seed");
  const initialTip = git(main, "rev-parse", "HEAD");
  const explicitMergeBase = spawnSync("git", ["merge-tree", "--write-tree", `--merge-base=${initialTip}`, initialTip, initialTip], { cwd: main, encoding: "utf8" }).status === 0;
  const work = path.join(root, "feature"); git(main, "worktree", "add", "-qb", "feature", work);
  write(work, "code", "feature\n"); git(work, "add", "code"); git(work, "commit", "-qm", "feature");
  git(main, "merge", "--squash", "feature"); git(main, "commit", "-qm", "squash");
  const cleanProof = await assessWorktreePreservation(work, { branch: "feature" });
  assert.equal(cleanProof.state, "preserved", JSON.stringify(cleanProof));
  write(work, "code", "staged\n"); git(work, "add", "code"); write(work, "code", "unstaged\n");
  write(work, "binary", Buffer.from([0, 255, 254, 10]));
  write(work, "large-binary", Buffer.alloc(2 * 1024 * 1024, 0xff));
  write(work, ".gitignore", "valuable/\nnode_modules/\n");
  write(work, "valuable/secret", "private bytes\n"); write(work, "node_modules/disposable", "excluded\n");
  fs.mkdirSync(path.join(work, "empty"));
  fs.symlinkSync("/outside/target", path.join(work, "link"));
  write(work, "executable", "#!/bin/sh\nexit 1\n"); fs.chmodSync(path.join(work, "executable"), 0o755);
  const status = git(work, "status", "--porcelain");
  const objects = git(work, "count-objects", "-v");
  const assessment = await assessWorktreePreservation(work, { branch: "feature" });
  assert.equal(assessment.state, explicitMergeBase ? "remaining" : "unknown", JSON.stringify(assessment));
  assert.equal(git(work, "count-objects", "-v"), objects, "assessment writes no persistent objects");
  assert.equal(git(work, "status", "--porcelain"), status, "assessment leaves index and files untouched");
  const snapshot = await createWorktreeSnapshot(work);
  assert.equal(snapshot.ok, true, snapshot.reason);
  assert.equal(git(work, "status", "--porcelain"), status);
  const listed = await listWorktreeSnapshots(main);
  assert.equal(listed[0].id, snapshot.id);
  const symlinkParent = path.join(root, "destination-link"); fs.symlinkSync(main, symlinkParent);
  assert.equal((await restoreWorktreeSnapshot(main, snapshot.id, path.join(symlinkParent, "unsafe"), { apply: true })).ok, false);
  assert.equal(fs.existsSync(path.join(main, "unsafe")), false);
  const originalManifest = JSON.parse(git(main, "show", `${snapshot.ref}:manifest.json`));
  for (const hostile of ["../escape", ".git/config", "CON", "Link/child"]) {
    const id = "00000000-0000-4000-8000-000000000000";
    const manifest = structuredClone(originalManifest); manifest.id = id;
    manifest.entries[0].path = hostile;
    if (hostile === "Link/child") manifest.entries.push({ path: "Link", mode: "120000", layer: "untracked", oid: manifest.index[0].oid, checksum: manifest.index[0].checksum });
    const hash = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: main, encoding: "utf8", input: JSON.stringify(manifest) });
    assert.equal(hash.status, 0);
    const payload = git(main, "ls-tree", snapshot.ref).replace(/([a-f0-9]+)(\tmanifest\.json)/, `${hash.stdout.trim()}$2`);
    const tree = spawnSync("git", ["mktree"], { cwd: main, encoding: "utf8", input: payload + "\n" }); assert.equal(tree.status, 0, tree.stderr);
    const forged = git(main, "commit-tree", tree.stdout.trim(), "-p", manifest.tip, "-m", "hostile snapshot fixture");
    git(main, "update-ref", `refs/roborepo/worktree-archives/${id}`, forged);
    const rejected = await restoreWorktreeSnapshot(main, id, path.join(root, "hostile-restore"), { apply: true });
    assert.equal(rejected.ok, false, hostile); assert.equal(fs.existsSync(path.join(root, "hostile-restore")), false, hostile);
    git(main, "update-ref", "-d", `refs/roborepo/worktree-archives/${id}`);
  }
  const destination = path.join(root, "restored");
  const preview = await restoreWorktreeSnapshot(main, snapshot.id, destination);
  assert.equal(preview.action, "preview", JSON.stringify(preview));
  assert.equal(fs.existsSync(destination), false);
  const restored = await restoreWorktreeSnapshot(main, snapshot.id, destination, { apply: true });
  assert.equal(restored.ok, true, restored.reason);
  assert.equal(fs.readFileSync(path.join(destination, "code"), "utf8"), "unstaged\n");
  assert.equal(git(destination, "show", ":code"), "staged");
  assert.deepEqual(fs.readFileSync(path.join(destination, "binary")), Buffer.from([0, 255, 254, 10]));
  assert.deepEqual(fs.readFileSync(path.join(destination, "large-binary")), Buffer.alloc(2 * 1024 * 1024, 0xff));
  assert.equal(fs.readFileSync(path.join(destination, "valuable/secret"), "utf8"), "private bytes\n");
  assert.equal(fs.readlinkSync(path.join(destination, "link")), "/outside/target");
  assert.equal(fs.statSync(path.join(destination, "executable")).mode & 0o111, 0o111);
  assert.equal(fs.existsSync(path.join(destination, "node_modules")), false);
  assert.equal((await restoreWorktreeSnapshot(main, snapshot.id, destination, { apply: true })).ok, false);
  // An index-only unique version survives assessment even when the filesystem cancels it.
  write(work, "code", "feature\n");
  assert.equal((await assessWorktreePreservation(work, { branch: "feature" })).state, explicitMergeBase ? "remaining" : "unknown");
  git(work, "config", "filter.evil.clean", `touch ${path.join(root, "executed")}`);
  const refused = await createWorktreeSnapshot(work);
  assert.equal(refused.ok, false); assert.match(refused.reason, /driver configuration/);
  assert.equal(fs.existsSync(path.join(root, "executed")), false);
  git(work, "config", "--remove-section", "filter.evil");
  git(work, "update-index", "--assume-unchanged", "code");
  await assert.rejects(() => inventoryWorktree(work), /index flag/);
  git(work, "update-index", "--no-assume-unchanged", "code");
  for (const shape of ["redundant", "deletion", "rename", "binary", "mode", "plan-move", "conflict"]) {
    const repo = path.join(root, shape); fs.mkdirSync(repo);
    git(repo, "init", "-qb", "main");
    write(repo, "seed", "seed\n");
    write(repo, "docs/plans/plans-config.json", JSON.stringify({ worktreeRoot: root }));
    git(repo, "add", "."); git(repo, "commit", "-qm", "seed");
    const checkout = path.join(root, `${shape}-work`); git(repo, "worktree", "add", "-qb", "feature", checkout);
    write(checkout, "code", "feature\n");
    if (shape === "plan-move") write(checkout, "docs/plans/review/story.md", "---\nid: abc12345\n---\n\n# Story\n");
    git(checkout, "add", "."); git(checkout, "commit", "-qm", "feature");
    git(repo, "merge", "--squash", "feature"); git(repo, "commit", "-qm", "squash");
    if (shape === "deletion") { fs.unlinkSync(path.join(repo, "code")); git(repo, "add", "code"); }
    else if (shape === "rename") git(repo, "mv", "code", "renamed");
    else if (shape === "mode") { fs.chmodSync(path.join(repo, "code"), 0o755); git(repo, "add", "code"); }
    else if (shape === "plan-move") {
      fs.mkdirSync(path.join(repo, "docs/plans/completed"));
      git(repo, "mv", "docs/plans/review/story.md", "docs/plans/completed/story.md");
      write(repo, "docs/plans/completed/story.md", "---\nid: abc12345\n---\n\n# Story\n\nEvidence on base\n");
      git(repo, "add", ".");
    } else { write(repo, "code", shape === "binary" ? Buffer.from([0, 255, 1]) : "redundant\n"); git(repo, "add", "code"); }
    git(repo, "commit", "-qm", "later base change");
    if (shape === "deletion") { fs.unlinkSync(path.join(checkout, "code")); git(checkout, "add", "code"); }
    else if (shape === "rename") git(checkout, "mv", "code", "renamed");
    else if (shape === "mode") { fs.chmodSync(path.join(checkout, "code"), 0o755); git(checkout, "add", "code"); }
    else if (shape === "plan-move") write(checkout, "docs/plans/review/story.md", fs.readFileSync(path.join(repo, "docs/plans/completed/story.md")));
    else { write(checkout, "code", fs.readFileSync(path.join(repo, "code"))); git(checkout, "add", "code"); }
    if (shape === "conflict") { write(checkout, "code", "conflicting local work\n"); git(checkout, "add", "code"); }
    const proof = await assessWorktreePreservation(checkout, { branch: "feature" });
    if (!explicitMergeBase) { assert.equal(proof.state, "unknown", JSON.stringify(proof)); assert.match(proof.reason, /merge-base|unknown option/); continue; }
    if (shape === "conflict") { assert.equal(proof.state, "unknown", JSON.stringify(proof)); assert.match(proof.reason, /conflict/); continue; }
    assert.equal(proof.state, "preserved", `${shape}: ${JSON.stringify(proof)}`);
    assert.equal(proof.hasLocalContent, true);
    if (shape === "redundant") {
      const rows = await cleanupWorktrees({ cwd: repo, apply: true, stateRoot: path.join(root, "cleanup-state"), discover: async () => ({ instances: [] }) });
      assert.equal(rows[0].action, "removed", JSON.stringify(rows));
      assert.ok(rows[0].snapshotRef, "automatic dirty cleanup creates a verified snapshot");
      assert.equal(fs.existsSync(checkout), false);
      const after = await restoreWorktreeSnapshot(repo, rows[0].snapshotRef, path.join(root, "automatic-restored"), { apply: true });
      assert.equal(after.ok, true, after.reason);
    }
  }
  {
    const repo = path.join(root, "explicit"); fs.mkdirSync(repo);
    git(repo, "init", "-qb", "main"); git(repo, "remote", "add", "origin", "https://github.com/example/archive.git");
    write(repo, "seed", "seed\n"); git(repo, "add", "."); git(repo, "commit", "-qm", "seed");
    const checkout = path.join(root, "explicit-work"); git(repo, "worktree", "add", "-qb", "feature", checkout);
    write(checkout, "code", "unmerged\n"); git(checkout, "add", "code"); git(checkout, "commit", "-qm", "unmerged work");
    write(checkout, "code", "staged\n"); git(checkout, "add", "code"); write(checkout, "code", "unstaged\n");
    write(checkout, "untracked", "remaining\n");
    const stateRoot = path.join(root, "explicit-state");
    const repositoryId = "git:github.com/example/archive";
    recordRepositoryDiscovery({ repositoryId, kind: "git", displayName: "archive", source: "developer-runtime", evidence: "git-remote", confidence: "high", localRoot: "main", localRootKind: "clone", localRootPath: repo, stateRoot });
    const discover = async () => ({ instances: [] });
    const [cliPreview] = await cleanupWorktrees({ cwd: repo, stateRoot, archive: true, remove: "feature", confirm: true, discover });
    const portalPreview = await archiveRepositoryWorktree({ repositoryId, branch: "feature", stateRoot, discover });
    assert.deepEqual(portalPreview, cliPreview, "CLI and portal share archive assessment");
    const fingerprint = (await inventoryWorktree(checkout)).fingerprint;
    write(checkout, "untracked", "concurrent edit\n");
    assert.equal((await createWorktreeSnapshot(checkout, { expectedFingerprint: fingerprint })).ok, false);
    let stops = 0;
    const stop = async () => { stops++; return { ok: true, servers: [] }; };
    git(checkout, "config", "filter.evil.clean", "false");
    const refused = await archiveRepositoryWorktree({ repositoryId, branch: "feature", stateRoot, discover, stop, apply: true, confirm: true });
    assert.equal(refused.action, "kept"); assert.equal(stops, 0, "failed snapshot eligibility stops no servers");
    assert.equal(fs.existsSync(checkout), true);
    git(checkout, "config", "--remove-section", "filter.evil");
    const removed = await archiveRepositoryWorktree({ repositoryId, branch: "feature", stateRoot, discover, stop, apply: true, confirm: true });
    assert.equal(removed.action, "removed", JSON.stringify(removed));
    assert.equal(stops, 1);
    fs.rmSync(stateRoot, { recursive: true, force: true });
    git(repo, "gc", "--prune=now");
    assert.equal((await listWorktreeSnapshots(repo)).some((entry) => entry.ref === removed.snapshotRef), true);
    const restored = await restoreWorktreeSnapshot(repo, removed.snapshotRef, path.join(root, "explicit-restored"), { apply: true });
    assert.equal(restored.ok, true, restored.reason);
    assert.equal(git(restored.destination, "show", ":code"), "staged");
    assert.equal(fs.readFileSync(path.join(restored.destination, "code"), "utf8"), "unstaged\n");
    assert.equal(fs.readFileSync(path.join(restored.destination, "untracked"), "utf8"), "concurrent edit\n");
  }
  for (const outcome of ["retry", "moved", "occupied", "remove-failure"]) {
    const repo = path.join(root, `partial-${outcome}`); fs.mkdirSync(repo);
    git(repo, "init", "-qb", "main"); write(repo, "seed", "seed\n"); git(repo, "add", "."); git(repo, "commit", "-qm", "seed");
    const checkout = path.join(root, `partial-${outcome}-work`); git(repo, "worktree", "add", "-qb", "feature", checkout);
    write(checkout, "pending", "untracked bytes\n");
    const tip = git(checkout, "rev-parse", "HEAD");
    const snapshot = await createWorktreeSnapshot(checkout); assert.equal(snapshot.ok, true, snapshot.reason);
    const before = git(checkout, "status", "--porcelain");
    const stateRoot = path.join(root, `partial-${outcome}-state`);
    const failStep = outcome === "remove-failure" ? "worktree" : "update-ref";
    const runGit = (cwd, args, options) => args[0] === failStep
      ? Promise.resolve({ ok: false, code: 1, stdout: "", error: "injected removal/retirement failure" }) : runGitProcess(cwd, args, options);
    const result = await removeWorktree(repo, { path: checkout, branch: "feature", name: path.basename(checkout) }, { kind: "confirmed", stateRoot, tip, snapshot, runGit });
    assert.equal(result.ok, false);
    if (outcome === "remove-failure") {
      assert.equal(fs.existsSync(checkout), true); assert.equal(git(checkout, "status", "--porcelain"), before);
      assert.equal((await createWorktreeSnapshot(checkout)).ref, snapshot.ref, "retry reuses the verified capture");
      continue;
    }
    assert.equal(fs.existsSync(checkout), false); assert.equal(git(repo, "rev-parse", "feature"), tip);
    if (outcome === "moved") {
      const next = git(repo, "commit-tree", git(repo, "rev-parse", "HEAD^{tree}"), "-p", tip, "-m", "concurrent branch work");
      git(repo, "update-ref", "refs/heads/feature", next, tip);
    }
    if (outcome === "occupied") git(repo, "worktree", "add", path.join(root, "new-occupied-checkout"), "feature");
    assert.equal((await listWorktreeSnapshots(repo))[0].kind, "snapshot", JSON.stringify(await listWorktreeSnapshots(repo)));
    const rows = await cleanupWorktrees({ cwd: repo, stateRoot, archive: true, remove: "feature", confirm: true, apply: true, discover: async () => ({ instances: [] }) });
    assert.equal(rows[0].action, outcome === "retry" ? "removed" : "kept", JSON.stringify(rows));
    assert.equal(rows[0].snapshotRef, snapshot.ref);
    if (outcome === "retry") {
      const again = await retryArchivedBranchRetirement(repo, "feature", { stateRoot, apply: true });
      assert.equal(again.action, "removed", "a completed retry is idempotent");
    } else assert.equal(git(repo, "show-ref", "--verify", "--quiet", "refs/heads/feature"), "");
  }
  console.log("worktree snapshots: raw binary/staged/unstaged/ignored/symlink/mode round trip, preview nonmutation, refusal checks passed");
} finally { restoreGitConfig(); fs.rmSync(root, { recursive: true, force: true }); }
