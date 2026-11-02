#!/usr/bin/env node
import assert from "node:assert/strict";
import { isolateGitConfig } from "./lib/git-config.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { GIT_MAX_BUFFER, GIT_MAX_BINARY_BUFFER, runGitProcessSync, runGitProcess } from "../../modules/repositories/git-exec.mjs";
import { removeWorktree, retryArchivedBranchRetirement } from "../../modules/repositories/worktree-removal.mjs";
import { createWorktreeSnapshot, restoreWorktreeSnapshot, listWorktreeSnapshots, inventoryWorktree, readSnapshot } from "../../modules/repositories/worktree-snapshot.mjs";
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
  const largeText = "x".repeat(GIT_MAX_BUFFER + 1024);
  const largeBlob = await runGitProcess(main, ["hash-object", "-w", "--stdin"], { input: largeText });
  assert.equal(largeBlob.ok, true);
  const blobArgs = ["cat-file", "blob", largeBlob.stdout.trim()];
  assert.equal((await runGitProcess(main, blobArgs)).ok, false, "small reads retain the default bound");
  for (const result of [await runGitProcess(main, blobArgs, { maxBuffer: GIT_MAX_BINARY_BUFFER }), runGitProcessSync(main, blobArgs, { maxBuffer: GIT_MAX_BINARY_BUFFER })]) {
    assert.equal(result.ok, true, result.error);
    assert.equal(result.stdout.length, largeText.length, "async and sync reads accept a larger bound");
    assert.ok(result.stdout === largeText, "bulk blob bytes are preserved");
  }
  const initialTip = git(main, "rev-parse", "HEAD");
  const explicitMergeBase = spawnSync("git", ["merge-tree", "--write-tree", `--merge-base=${initialTip}`, initialTip, initialTip], { cwd: main, encoding: "utf8" }).status === 0;
  const work = path.join(root, "feature"); git(main, "worktree", "add", "-qb", "feature", work);
  write(work, "code", "feature\n"); git(work, "add", "code"); git(work, "commit", "-qm", "feature");
  git(main, "merge", "--squash", "feature"); git(main, "commit", "-qm", "squash");
  const cleanProof = await assessWorktreePreservation(work, { branch: "feature" });
  assert.equal(cleanProof.state, "preserved", JSON.stringify(cleanProof));
  {
    fs.mkdirSync(path.join(work, "directory-only"));
    const before = (await inventoryWorktree(work)).fingerprint;
    let hashes = 0;
    let merges = 0;
    const proof = await assessWorktreePreservation(work, { branch: "feature", runGit: (cwd, args, options) => {
      if (args[0] === "hash-object") hashes++;
      if (args[0] === "merge-tree") merges++;
      return runGitProcess(cwd, args, options);
    } });
    assert.equal(proof.state, explicitMergeBase ? "preserved" : "unknown", JSON.stringify(proof));
    assert.equal(proof.hasLocalContent, explicitMergeBase ? true : null, "empty directories still require preservation");
    assert.ok(merges >= (explicitMergeBase ? 3 : 1), "landing and both local layers are still checked");
    assert.equal(hashes, 0, "unchanged filesystem blobs already exist in the assessed trees");
    assert.equal((await inventoryWorktree(work)).fingerprint, before, "assessment does not change local state");
    fs.rmdirSync(path.join(work, "directory-only"));
  }
  write(work, "code", "staged\n"); git(work, "add", "code"); write(work, "code", "unstaged\n");
  write(work, "binary", Buffer.from([0, 255, 254, 10]));
  write(work, "large-binary", Buffer.alloc(2 * 1024 * 1024, 0xff));
  write(work, ".gitignore", "valuable/\nnode_modules/\n");
  write(work, "valuable/secret", "private bytes\n"); write(work, "node_modules/disposable", "excluded\n");
  fs.mkdirSync(path.join(work, "empty"));
  fs.symlinkSync("/outside/target", path.join(work, "link"));
  const rawLinkTarget = Buffer.from([0x66, 0x80]);
  fs.symlinkSync(rawLinkTarget, path.join(work, "raw-link"));
  write(work, "executable", "#!/bin/sh\nexit 1\n"); fs.chmodSync(path.join(work, "executable"), 0o755);
  const status = git(work, "status", "--porcelain");
  const objects = git(work, "count-objects", "-v");
  const assessment = await assessWorktreePreservation(work, { branch: "feature" });
  assert.equal(assessment.state, explicitMergeBase ? "remaining" : "unknown", JSON.stringify(assessment));
  assert.equal(git(work, "count-objects", "-v"), objects, "assessment writes no persistent objects");
  assert.equal(git(work, "status", "--porcelain"), status, "assessment leaves index and files untouched");
  const invalidRef = "refs/roborepo/worktree-archives/00000000-0000-4000-8000-000000000001";
  git(main, "update-ref", invalidRef, initialTip);
  const snapshot = await createWorktreeSnapshot(work);
  assert.equal(snapshot.ok, true, snapshot.reason);
  assert.equal(git(work, "status", "--porcelain"), status);
  git(main, "update-ref", "-d", invalidRef);
  const listed = await listWorktreeSnapshots(main);
  assert.equal(listed[0].id, snapshot.id);
  const symlinkParent = path.join(root, "destination-link"); fs.symlinkSync(main, symlinkParent);
  assert.equal((await restoreWorktreeSnapshot(main, snapshot.id, path.join(symlinkParent, "unsafe"), { apply: true })).ok, false);
  assert.equal(fs.existsSync(path.join(main, "unsafe")), false);
  const originalManifest = JSON.parse(git(main, "show", `${snapshot.ref}:manifest.json`));
  const paddedManifest = { ...originalManifest, padding: largeText };
  const paddedBlob = await runGitProcess(main, ["hash-object", "-w", "--stdin"], { input: JSON.stringify(paddedManifest) });
  assert.equal(paddedBlob.ok, true);
  const paddedTree = await runGitProcess(main, ["mktree"], { input: git(main, "ls-tree", snapshot.ref).replace(/([a-f0-9]+)(\tmanifest\.json)/, `${paddedBlob.stdout.trim()}$2`) + "\n" });
  assert.equal(paddedTree.ok, true);
  const paddedCommit = git(main, "commit-tree", paddedTree.stdout.trim(), "-p", originalManifest.tip, "-m", "large manifest");
  assert.equal((await readSnapshot(main, paddedCommit)).manifest.padding.length, largeText.length, "large manifests can be fully verified");
  // A matching fingerprint is only a candidate; invalid payloads cannot be reused.
  const corruptManifest = structuredClone(originalManifest);
  corruptManifest.index[0].checksum = "0".repeat(64);
  const corruptBlob = await runGitProcess(main, ["hash-object", "-w", "--stdin"], { input: JSON.stringify(corruptManifest) });
  assert.equal(corruptBlob.ok, true);
  const corruptTree = await runGitProcess(main, ["mktree"], { input: git(main, "ls-tree", snapshot.ref).replace(/([a-f0-9]+)(\tmanifest\.json)/, `${corruptBlob.stdout.trim()}$2`) + "\n" });
  assert.equal(corruptTree.ok, true);
  git(main, "update-ref", invalidRef, git(main, "commit-tree", corruptTree.stdout.trim(), "-p", originalManifest.tip, "-m", "corrupt matching capture"));
  const reused = await createWorktreeSnapshot(work);
  assert.equal(reused.ok, true, reused.reason);
  assert.equal(reused.ref, snapshot.ref, "only a fully verified capture is reused");
  assert.equal(reused.reused, true);
  git(main, "update-ref", "-d", invalidRef);
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
  assert.deepEqual(fs.readlinkSync(path.join(destination, "raw-link"), { encoding: "buffer" }), rawLinkTarget);
  assert.equal(fs.statSync(path.join(destination, "executable")).mode & 0o111, 0o111);
  assert.equal(fs.statSync(path.join(destination, "empty")).isDirectory(), true, "meaningful empty directories survive restore");
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
  for (const shape of ["redundant", "directory-only", "deletion", "rename", "binary", "mode", "plan-move", "conflict", "concurrent-file", "concurrent-index", "concurrent-tip", "concurrent-config", "concurrent-base"]) {
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
    else if (shape === "directory-only") {
      fs.mkdirSync(path.join(checkout, "generated/packages/__char_test_pkg__/claude"), { recursive: true });
      assert.equal(git(checkout, "status", "--porcelain"), "", "directory-only local content is invisible to Git status");
    }
    else { write(checkout, "code", fs.readFileSync(path.join(repo, "code"))); git(checkout, "add", "code"); }
    if (shape === "conflict") { write(checkout, "code", "conflicting local work\n"); git(checkout, "add", "code"); }
    const proof = await assessWorktreePreservation(checkout, { branch: "feature" });
    if (!explicitMergeBase) { assert.equal(proof.state, "unknown", JSON.stringify(proof)); assert.match(proof.reason, /merge-base|unknown option/); continue; }
    if (shape === "conflict") { assert.equal(proof.state, "unknown", JSON.stringify(proof)); assert.match(proof.reason, /conflict/); continue; }
    assert.equal(proof.state, "preserved", `${shape}: ${JSON.stringify(proof)}`);
    assert.equal(proof.hasLocalContent, true);
    assert.deepEqual(proof.remainingPaths, [], "absorbed local paths no longer remain");
    if (shape.startsWith("concurrent-")) {
      let surveys = 0;
      const rows = await cleanupWorktrees({ cwd: repo, apply: true, stateRoot: path.join(root, `${shape}-state`), discover: async () => {
        if (++surveys === 2) {
          if (shape === "concurrent-file") write(checkout, "code", "new unsnapshotted work\n");
          if (shape === "concurrent-index") {
            const content = path.join(root, "unique-index-content"); fs.writeFileSync(content, "unique staged work\n");
            const blob = git(checkout, "hash-object", "-w", content);
            git(checkout, "update-index", "--cacheinfo", `100644,${blob},code`);
          }
          if (shape === "concurrent-tip") {
            const tip = git(checkout, "rev-parse", "HEAD");
            const next = git(checkout, "commit-tree", git(checkout, "rev-parse", "HEAD^{tree}"), "-p", tip, "-m", "concurrent commit");
            git(checkout, "update-ref", "refs/heads/feature", next, tip);
          }
          if (shape === "concurrent-config") git(checkout, "config", "core.fileMode", "false");
          if (shape === "concurrent-base") git(repo, "update-ref", "refs/heads/main", git(repo, "rev-list", "--max-parents=0", "HEAD"), git(repo, "rev-parse", "HEAD"));
        }
        return { instances: [] };
      } });
      assert.equal(surveys, 2, `${shape}: mutation occurs in the final survey`);
      assert.equal(rows[0].action, "kept", `${shape}: ${JSON.stringify(rows)}`);
      assert.equal(fs.existsSync(checkout), true, `${shape}: concurrent changes must retain checkout`);
      assert.ok(rows[0].snapshotRef, `${shape}: verified snapshot remains discoverable`);
    }
    if (["redundant", "directory-only"].includes(shape)) {
      const rows = await cleanupWorktrees({ cwd: repo, apply: true, stateRoot: path.join(root, `${shape}-cleanup-state`), discover: async () => ({ instances: [] }) });
      assert.equal(rows[0].action, "removed", JSON.stringify(rows));
      assert.ok(rows[0].snapshotRef, "automatic dirty cleanup creates a verified snapshot");
      assert.equal(fs.existsSync(checkout), false);
      const after = await restoreWorktreeSnapshot(repo, rows[0].snapshotRef, path.join(root, `${shape}-automatic-restored`), { apply: true });
      assert.equal(after.ok, true, after.reason);
      if (shape === "directory-only") assert.equal(fs.statSync(path.join(after.destination, "generated/packages/__char_test_pkg__/claude")).isDirectory(), true);
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
    if (outcome === "occupied") {
      const live = path.join(root, "new-occupied-checkout");
      git(repo, "worktree", "add", live, "feature");
      write(live, "new-work", "new local bytes\n");
      const preview = await cleanupWorktrees({ cwd: repo, stateRoot, archive: true, remove: "feature", confirm: true, discover: async () => ({ instances: [] }) });
      assert.equal(preview[0].path, live, "a live checkout takes precedence over old archive retirement");
      assert.ok(preview[0].remainingPaths.includes("new-work"), JSON.stringify(preview));
      // Keep this fixture occupied so the mutation path exercises its normal lock guard.
      git(repo, "worktree", "lock", live);
    }
    assert.equal((await listWorktreeSnapshots(repo))[0].kind, "snapshot", JSON.stringify(await listWorktreeSnapshots(repo)));
    const rows = await cleanupWorktrees({ cwd: repo, stateRoot, archive: true, remove: "feature", confirm: true, apply: true, discover: async () => ({ instances: [] }) });
    assert.equal(rows[0].action, outcome === "retry" ? "removed" : "kept", JSON.stringify(rows));
    if (outcome !== "occupied") assert.equal(rows[0].snapshotRef, snapshot.ref);
    if (outcome === "retry") {
      const again = await retryArchivedBranchRetirement(repo, "feature", { stateRoot, apply: true });
      assert.equal(again.action, "removed", "a completed retry is idempotent");
    } else assert.equal(git(repo, "show-ref", "--verify", "--quiet", "refs/heads/feature"), "");
  }
  {
    const repo = path.join(root, "bulk-inventory"); fs.mkdirSync(repo);
    git(repo, "init", "-qb", "main");
    for (let i = 0; i < 4800; i++) write(repo, `${String(i).padStart(4, "0")}-${"p".repeat(185)}`, "same bytes\n");
    git(repo, "add", "."); git(repo, "commit", "-qm", "many tracked paths");
    const inventory = await inventoryWorktree(repo);
    assert.equal(inventory.index.length, 4800, "repository-wide index reads exceed the small query bound");
    assert.ok(inventory.attributes.length > GIT_MAX_BUFFER, "repository-wide attribute reads exceed the small query bound");
  }
  for (const format of ["sha1", "sha256"]) {
    const repo = path.join(root, `raw-identities-${format}`); fs.mkdirSync(repo);
    git(repo, "init", "-qb", "main", `--object-format=${format}`);
    write(repo, "seed", "seed\n"); git(repo, "add", "."); git(repo, "commit", "-qm", "seed");
    const checkout = path.join(root, `raw-identities-${format}-work`);
    git(repo, "worktree", "add", "-qb", "feature", checkout);
    write(checkout, "code", "feature\n"); git(checkout, "add", "."); git(checkout, "commit", "-qm", "feature");
    git(repo, "merge", "--squash", "feature"); git(repo, "commit", "-qm", "squash");
    const binary = Buffer.from([0, 255, 128, 13, 10]);
    write(checkout, "code", binary); git(checkout, "add", "code");
    // Identical raw bytes at another path already exist in the index, regardless of file mode.
    write(checkout, "same-bytes", binary); fs.chmodSync(path.join(checkout, "same-bytes"), 0o755);
    write(checkout, "empty", "");
    fs.symlinkSync("raw-target", path.join(checkout, "link"));
    write(checkout, "code", Buffer.from([0, 254, 129, 13, 10]));
    write(checkout, "duplicate-unstaged", Buffer.from([0, 254, 129, 13, 10]));
    const before = (await inventoryWorktree(checkout)).fingerprint;
    const objects = git(checkout, "count-objects", "-v");
    const hashes = [];
    const proof = await assessWorktreePreservation(checkout, { branch: "feature", runGit: async (cwd, args, options) => {
      const result = await runGitProcess(cwd, args, options);
      if (args[0] === "hash-object") {
        assert.equal(result.ok, true, result.error);
        const expected = await runGitProcess(cwd, ["hash-object", "--stdin"], { input: options.input });
        assert.equal(expected.ok, true, expected.error);
        assert.equal(result.stdout.trim(), expected.stdout.trim(), "raw blob identities match Git");
        hashes.push(Buffer.from(options.input));
      }
      return result;
    } });
    assert.equal(proof.state, explicitMergeBase ? "remaining" : "unknown", JSON.stringify(proof));
    assert.equal(hashes.length, 3, "only unstaged binary, empty file, and symlink bytes require new objects");
    assert.ok(!hashes.some((bytes) => bytes.equals(binary)), "index blobs are reused across paths and modes");
    const [row] = await cleanupWorktrees({ cwd: repo, apply: true, stateRoot: path.join(root, `${format}-remaining-state`), discover: async () => ({ instances: [] }) });
    assert.equal(row.preservation, explicitMergeBase ? "remaining" : "unknown", JSON.stringify(row));
    assert.equal(row.action, "kept", "automatic cleanup keeps genuinely distinct staged and unstaged versions");
    assert.equal((await inventoryWorktree(checkout)).fingerprint, before);
    assert.equal(git(checkout, "count-objects", "-v"), objects, "raw identity checks publish no objects");
  }
  console.log("worktree snapshots: raw binary/staged/unstaged/ignored/symlink/mode round trip, preview nonmutation, refusal checks passed");
} finally { restoreGitConfig(); fs.rmSync(root, { recursive: true, force: true }); }
