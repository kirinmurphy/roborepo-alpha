#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isolateGitConfig } from "./lib/git-config.mjs";
import { inventoryDiscard, previewWorktreeDiscard, applyWorktreeDiscard, readTransaction, saveTransaction } from "../../modules/repositories/worktree-discard.mjs";
import { linkedWorktrees } from "../../modules/repositories/worktree-inventory.mjs";
import { cleanupWorktrees } from "../cli/worktree-cleanup.mjs";
import { appendRemoval, removalLogPath } from "../../modules/repositories/worktree-removal.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-discard-check-"));
const restore = isolateGitConfig(root);
function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
let sequence = 0;
function fixture() {
  const mainPath = path.join(root, `repo-${++sequence}`), work = path.join(root, `work-${sequence}`), stateRoot = path.join(root, `state-${sequence}`);
  fs.mkdirSync(mainPath); git(mainPath, "init", "-q", "-b", "main");
  git(mainPath, "config", "user.name", "Test"); git(mainPath, "config", "user.email", "test@example.test");
  fs.writeFileSync(path.join(mainPath, "base.txt"), "base\n");
  fs.writeFileSync(path.join(mainPath, ".gitignore"), "node_modules/\n.venv/\nprivate-settings\n");
  git(mainPath, "add", "."); git(mainPath, "commit", "-qm", "base");
  git(mainPath, "worktree", "add", "-qb", "feature", work);
  const worktree = linkedWorktrees(path.join(mainPath, ".git"))[0];
  return { mainPath: fs.realpathSync(mainPath), work, worktree, stateRoot, repositoryId: fs.realpathSync(mainPath), scope: "all", stop: async () => ({ ok: true }) };
}
async function preview(options) { const result = await previewWorktreeDiscard(options); assert.ok(result.receipt, result.reason); return result; }
try {
  const f = fixture();
  fs.writeFileSync(path.join(f.work, "private-settings"), "synthetic private value");
  fs.writeFileSync(path.join(f.work, "new file\nname"), "new");
  fs.writeFileSync(path.join(f.work, "base.txt"), "changed");
  fs.mkdirSync(path.join(f.work, "node_modules"));
  fs.writeFileSync(path.join(f.work, "node_modules", "generated"), "output");
  const first = await preview(f);
  assert.equal(first.groups.tracked[0].path, "base.txt");
  assert.equal(first.groups.ignored[0].path, "private-settings");
  assert.equal(first.groups.untracked[0].path, "new file\nname");
  assert.equal(first.groups.disposable[0].path, "node_modules");
  assert.equal(JSON.stringify(readTransaction(f.stateRoot, first.receipt)).includes("synthetic private value"), false);
  assert.equal((await applyWorktreeDiscard({ ...f, receipt: undefined })).action, "kept");
  assert.equal((await applyWorktreeDiscard({ ...f, receipt: first.receipt, repositoryId: "wrong" })).action, "kept");
  fs.writeFileSync(path.join(f.work, "base.txt"), "newer");
  let rejected = await applyWorktreeDiscard({ ...f, receipt: first.receipt });
  assert.equal(rejected.action, "kept"); assert.ok(rejected.differences.changed.includes("base.txt"));
  const second = await preview(f);
  fs.writeFileSync(path.join(f.work, "added"), "added");
  rejected = await applyWorktreeDiscard({ ...f, receipt: second.receipt });
  assert.ok(rejected.differences.added.includes("added"));
  const third = await preview(f);
  fs.unlinkSync(path.join(f.work, "added"));
  rejected = await applyWorktreeDiscard({ ...f, receipt: third.receipt });
  assert.ok(rejected.differences.removed.includes("added"));
  const fourth = await preview(f);
  rejected = await applyWorktreeDiscard({ ...f, receipt: fourth.receipt, stop: async () => { fs.writeFileSync(path.join(f.work, "server-write"), "late"); return { ok: true }; } });
  assert.equal(rejected.action, "kept"); assert.ok(rejected.differences.added.includes("server-write"));
  const expired = await preview(f), record = readTransaction(f.stateRoot, expired.receipt);
  record.expiresAt = new Date(0).toISOString(); saveTransaction(f.stateRoot, record);
  assert.match((await applyWorktreeDiscard({ ...f, receipt: expired.receipt })).reason, /expired/);
  fs.writeFileSync(path.join(f.work, "<index>"), "tracked arbitrary name");
  git(f.work, "add", "<index>"); git(f.work, "commit", "-qm", "unusual tracked path");
  const indexNamed = await preview(f);
  fs.writeFileSync(path.join(f.work, "<index>"), "changed arbitrary name");
  assert.ok((await applyWorktreeDiscard({ ...f, receipt: indexNamed.receipt })).differences.changed.includes("<index>"));
  const prototype = await preview(f);
  fs.writeFileSync(path.join(f.work, "__proto__"), "must be inventoried");
  assert.ok((await applyWorktreeDiscard({ ...f, receipt: prototype.receipt })).differences.added.includes("__proto__"));
  const beforeArtifacts = await inventoryDiscard(f.work);
  fs.writeFileSync(path.join(f.work, "node_modules", "new-generated"), "output");
  assert.equal((await inventoryDiscard(f.work)).digest, beforeArtifacts.digest);
  const staged = await preview(f); git(f.work, "add", "base.txt");
  assert.equal((await applyWorktreeDiscard({ ...f, receipt: staged.receipt })).action, "kept");
  const mode = await preview(f); fs.chmodSync(path.join(f.work, "base.txt"), 0o755);
  assert.equal((await applyWorktreeDiscard({ ...f, receipt: mode.receipt })).action, "kept");
  const changedTip = await preview(f);
  git(f.work, "commit", "-qm", "staged change");
  assert.equal((await applyWorktreeDiscard({ ...f, receipt: changedTip.receipt })).action, "kept");
  const changedBase = await preview(f);
  fs.writeFileSync(path.join(f.mainPath, "base-new"), "later main");
  git(f.mainPath, "add", "base-new"); git(f.mainPath, "commit", "-qm", "base advances");
  assert.equal((await applyWorktreeDiscard({ ...f, receipt: changedBase.receipt })).action, "kept");
  const consumed = await preview(f), consumedRecord = readTransaction(f.stateRoot, consumed.receipt);
  consumedRecord.state = "applying"; saveTransaction(f.stateRoot, consumedRecord);
  assert.match((await applyWorktreeDiscard({ ...f, receipt: consumed.receipt })).reason, /consumed/);
  assert.equal(git(f.mainPath, "for-each-ref", "--format=%(refname)", "refs/roborepo/"), "");

  const unmerged = fixture();
  fs.writeFileSync(path.join(unmerged.work, "unique"), "unique"); git(unmerged.work, "add", "."); git(unmerged.work, "commit", "-qm", "unique commit");
  assert.equal((await previewWorktreeDiscard({ ...unmerged, scope: "leftovers" })).eligible, false);
  const cleanup = await cleanupWorktrees({ cwd: unmerged.mainPath, stateRoot: unmerged.stateRoot, remove: "feature", confirm: true, apply: true, discover: async () => ({ instances: [] }) });
  assert.equal(cleanup[0].action, "kept"); assert.match(cleanup[0].reason, /discard/); assert.ok(fs.existsSync(unmerged.work));
  const all = await preview(unmerged); assert.deepEqual(all.commits.subjects, ["unique commit"]);
  assert.match((await applyWorktreeDiscard({ ...unmerged, receipt: all.receipt, requiredScope: "leftovers" })).reason, /scope/);
  assert.ok(fs.existsSync(unmerged.work), "a plan operation cannot apply whole-branch consent");

  const raw = fixture();
  git(raw.mainPath, "config", "filter.untrusted.clean", "false");
  fs.writeFileSync(path.join(raw.work, ".gitattributes"), "* filter=untrusted\n");
  const large = fs.openSync(path.join(raw.work, "large"), "w"); fs.ftruncateSync(large, 65 * 1024 * 1024); fs.closeSync(large);
  assert.ok((await preview(raw)).groups.untracked.some((entry) => entry.path === "large" && entry.bytes > 64 * 1024 * 1024));
  git(raw.work, "checkout", "--detach", "-q"); raw.worktree = linkedWorktrees(path.join(raw.mainPath, ".git"))[0];
  assert.ok((await preview(raw)).receipt);
  const nested = fixture(); fs.mkdirSync(path.join(nested.work, "nested")); fs.writeFileSync(path.join(nested.work, "nested", ".git"), "synthetic");
  assert.match((await previewWorktreeDiscard(nested)).reason, /nested repo/);
  const locked = fixture(); git(locked.mainPath, "worktree", "lock", locked.work); locked.worktree = linkedWorktrees(path.join(locked.mainPath, ".git"))[0];
  assert.match((await previewWorktreeDiscard(locked)).reason, /locked/);
  const unreadable = fixture();
  fs.writeFileSync(path.join(unreadable.work, "unreadable"), "content");
  const originalLstat = fs.lstatSync;
  try {
    fs.lstatSync = (file, ...args) => { if (String(file).endsWith(`${path.sep}unreadable`)) throw new Error("unreadable entry: unreadable"); return originalLstat(file, ...args); };
    assert.match((await previewWorktreeDiscard(unreadable)).reason, /unreadable/);
  } finally { fs.lstatSync = originalLstat; }
  await assert.rejects(inventoryDiscard(unreadable.work, { timeoutMs: 0 }), /time limit/);
  const intent = fixture();
  const intentPreview = await preview(intent);
  const originalWrite = fs.writeFileSync;
  try {
    fs.writeFileSync = (file, ...args) => { if (String(file).endsWith(".tmp")) throw new Error("injected intent write failure"); return originalWrite(file, ...args); };
    const refused = await applyWorktreeDiscard({ ...intent, receipt: intentPreview.receipt });
    assert.equal(refused.action, "kept"); assert.match(refused.reason, /intent/);
    assert.ok(fs.existsSync(intent.work), "failed intent write preserves the checkout");
  } finally { fs.writeFileSync = originalWrite; }
  const master = fixture(); git(master.mainPath, "branch", "-m", "main", "master");
  assert.equal((await preview(master)).target.baseRef, "refs/heads/master");
  const logState = path.join(root, "logs");
  await Promise.all(Array.from({ length: 20 }, (_, i) => appendRemoval(logState, { at: new Date().toISOString(), i })));
  assert.equal(fs.readFileSync(removalLogPath(logState), "utf8").trim().split("\n").length, 20);
  console.log("worktree discard: stale receipts, scopes, raw inventory, intent-write refusal and serialized log assertions passed");
  const recreated = await preview(f);
  fs.renameSync(f.work, `${f.work}-original`);
  fs.mkdirSync(f.work);
  fs.copyFileSync(path.join(`${f.work}-original`, ".git"), path.join(f.work, ".git"));
  assert.equal((await applyWorktreeDiscard({ ...f, receipt: recreated.receipt })).action, "kept");
  console.log("worktree discard: preview, stale receipts, scopes, raw inventory and serialized log assertions passed");
} finally {
  restore();
  try { fs.rmSync(root, { recursive: true, force: true }); }
  catch (error) { console.error(`Fixture cleanup failed: ${error.message}`); process.exitCode = 1; }
}
