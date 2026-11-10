#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isolateGitConfig } from "./lib/git-config.mjs";
import { inventoryDiscard, previewWorktreeDiscard, applyWorktreeDiscard } from "../../modules/repositories/worktree-discard.mjs";
import { deleteTransaction, readTransaction, saveTransaction } from "../../modules/repositories/worktree-transactions.mjs";
import { linkedWorktrees } from "../../modules/repositories/worktree-inventory.mjs";
import { cleanupWorktrees } from "../cli/worktree-cleanup.mjs";
import { appendRemoval, removalLogPath, retryBranchRetirement } from "../../modules/repositories/worktree-removal.mjs";
import { addPlansStore } from "./lib/plan-store-fixture.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-discard-check-"));
const restore = isolateGitConfig(root);
const cli = fileURLToPath(new URL("../cli/main.mjs", import.meta.url));
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
  const retryState = path.join(root, "shared-retry-state");
  const retryRepos = [fixture(), fixture()];
  for (const repo of retryRepos) {
    git(repo.mainPath, "branch", "pending");
    await saveTransaction(retryState, { id: randomUUID(), state: "checkout-removed", createdAt: new Date().toISOString(), target: { repositoryId: repo.mainPath, path: path.join(repo.mainPath, "absent-checkout"), name: "pending", branch: "pending", tip: git(repo.mainPath, "rev-parse", "HEAD") } });
  }
  const detached = retryRepos[0];
  const detachedTip = git(detached.mainPath, "rev-parse", "HEAD");
  git(detached.mainPath, "branch", "null", detachedTip);
  await saveTransaction(retryState, { id: randomUUID(), state: "checkout-removed", createdAt: new Date().toISOString(), target: { repositoryId: detached.mainPath, path: path.join(detached.mainPath, "absent-detached"), name: "detached", branch: null, tip: detachedTip } });
  assert.equal((await retryBranchRetirement(detached.mainPath, "detached", { stateRoot: retryState, apply: true })).action, "removed");
  assert.equal(git(detached.mainPath, "rev-parse", "refs/heads/null"), detachedTip, "detached retry cannot retire a branch named null");
  git(detached.mainPath, "symbolic-ref", "refs/heads/alias", "refs/heads/main");
  await saveTransaction(retryState, {
    id: randomUUID(), state: "checkout-removed", createdAt: new Date().toISOString(),
    target: { repositoryId: detached.mainPath, path: path.join(detached.mainPath, "absent-alias"), name: "alias", branch: "alias", tip: detachedTip },
  });
  const aliasRetry = await retryBranchRetirement(detached.mainPath, "alias", { stateRoot: retryState, apply: true });
  assert.equal(aliasRetry.action, "removed");
  assert.equal(git(detached.mainPath, "show-ref", "--verify", "refs/heads/main"), `${detachedTip} refs/heads/main`, "retirement preserves a symbolic branch's target");
  assert.equal(git(detached.mainPath, "branch", "--list", "alias"), "");
  const occupiedAliasPath = path.join(root, "occupied-alias");
  git(detached.mainPath, "symbolic-ref", "refs/heads/occupied-alias", "refs/heads/main");
  git(detached.mainPath, "worktree", "add", "-q", occupiedAliasPath, "occupied-alias");
  await saveTransaction(retryState, {
    id: randomUUID(), state: "checkout-removed", createdAt: new Date().toISOString(),
    target: { repositoryId: detached.mainPath, path: path.join(detached.mainPath, "previous-checkout"), name: "previous-checkout", branch: "occupied-alias", tip: detachedTip },
  });
  const occupiedAlias = await retryBranchRetirement(detached.mainPath, "occupied-alias", { stateRoot: retryState });
  assert.equal(occupiedAlias.eligible, false, "a checkout through a branch alias still occupies that alias");
  assert.equal((await retryBranchRetirement(detached.mainPath, "occupied-alias", { stateRoot: retryState, apply: true })).action, "kept");
  assert.equal(git(occupiedAliasPath, "rev-parse", "HEAD"), detachedTip);
  git(detached.mainPath, "symbolic-ref", "refs/heads/intermediate", "refs/heads/main");
  git(detached.mainPath, "symbolic-ref", "refs/heads/occupied-alias", "refs/heads/intermediate");
  await saveTransaction(retryState, {
    id: randomUUID(), state: "checkout-removed", createdAt: new Date().toISOString(),
    target: { repositoryId: detached.mainPath, path: path.join(detached.mainPath, "previous-intermediate"), name: "previous-intermediate", branch: "intermediate", tip: detachedTip },
  });
  const occupiedIntermediate = await retryBranchRetirement(detached.mainPath, "intermediate", { stateRoot: retryState });
  assert.equal(occupiedIntermediate.eligible, false, "an intermediate alias still supports the occupied checkout");
  assert.equal((await retryBranchRetirement(detached.mainPath, "intermediate", { stateRoot: retryState, apply: true })).action, "kept");
  assert.equal(git(occupiedAliasPath, "rev-parse", "HEAD"), detachedTip);
  for (const repo of retryRepos) {
    assert.equal(git(repo.mainPath, "branch", "--list", "pending"), "pending", "other repo's retirement leaves this branch intact");
    const retry = await retryBranchRetirement(repo.mainPath, "pending", { stateRoot: retryState, apply: true });
    assert.equal(retry.action, "removed", "another repo's matching branch cannot block a pending retirement");
    assert.equal(git(repo.mainPath, "branch", "--list", "pending"), "");
  }
  console.log("worktree discard: shared-state branch retirement is isolated by repo");
  const f = fixture();
  fs.writeFileSync(path.join(f.work, "private-settings"), "synthetic private value");
  fs.writeFileSync(path.join(f.work, "new file\nname"), "new");
  fs.writeFileSync(path.join(f.work, "base.txt"), "changed");
  fs.mkdirSync(path.join(f.work, "node_modules"));
  fs.writeFileSync(path.join(f.work, "node_modules", "generated"), "output");
  const first = await preview(f);
  let activePlan = false;
  const claimOptions = { ...f, activePlans: () => new Set(activePlan ? [f.worktree.name] : []) };
  const unclaimed = await preview(claimOptions);
  assert.deepEqual(unclaimed.warnings, []);
  activePlan = true;
  let stopAttempted = false;
  const stop = async () => { stopAttempted = true; return { ok: false }; };
  const changedClaim = await applyWorktreeDiscard({ ...claimOptions, receipt: unclaimed.receipt, stop });
  assert.match(changedClaim.reason, /state changed after preview/);
  assert.equal(stopAttempted, false);
  assert.deepEqual((await preview(claimOptions)).warnings, ["plan still active"]);
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
  record.expiresAt = new Date(0).toISOString(); await saveTransaction(f.stateRoot, record);
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
  consumedRecord.state = "applying"; await saveTransaction(f.stateRoot, consumedRecord);
  assert.match((await applyWorktreeDiscard({ ...f, receipt: consumed.receipt })).reason, /consumed/);
  assert.equal(git(f.mainPath, "for-each-ref", "--format=%(refname)", "refs/roborepo/"), "");

  const unmerged = fixture();
  fs.writeFileSync(path.join(unmerged.work, "unique"), "unique"); git(unmerged.work, "add", "."); git(unmerged.work, "commit", "-qm", "unique commit");
  assert.equal((await previewWorktreeDiscard({ ...unmerged, scope: "leftovers" })).eligible, false);
  const unmergedTip = git(unmerged.work, "rev-parse", "HEAD");
  git(unmerged.mainPath, "symbolic-ref", "refs/heads/feature-alias", "refs/heads/feature");
  for (const base of ["feature", "refs/heads/feature", "feature-alias", unmergedTip]) {
    const refused = await previewWorktreeDiscard({ ...unmerged, scope: "leftovers", base });
    assert.equal(refused.action, "kept", `unmerged branch cannot prove its own landing via ${base}`);
    assert.equal(refused.receipt, undefined);
  }
  git(unmerged.mainPath, "branch", "integration", unmergedTip);
  const preserved = await preview({ ...unmerged, scope: "leftovers", base: "integration" });
  assert.equal(preserved.target.baseRef, "refs/heads/integration");
  assert.equal(preserved.commits.landed, true);
  const cleanup = await cleanupWorktrees({ cwd: unmerged.mainPath, stateRoot: unmerged.stateRoot, remove: "feature", confirm: true, apply: true, discover: async () => ({ instances: [] }) });
  assert.equal(cleanup[0].action, "kept"); assert.match(cleanup[0].reason, /discard/); assert.ok(fs.existsSync(unmerged.work));
  const all = await preview(unmerged); assert.deepEqual(all.commits.subjects, ["unique commit"]);
  assert.match((await applyWorktreeDiscard({ ...unmerged, receipt: all.receipt, requiredScope: "leftovers" })).reason, /scope/);
  assert.ok(fs.existsSync(unmerged.work), "a plan operation cannot apply whole-branch consent");
  git(unmerged.work, "commit", "-q", "--allow-empty", "--allow-empty-message", "-m", "");
  const blankSubject = await preview(unmerged);
  assert.equal(blankSubject.commits.unmerged, 2);
  assert.deepEqual(blankSubject.commits.subjects, ["(no commit subject)", "unique commit"]);

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
  const prunedPreview = await preview(intent);
  const pruned = await applyWorktreeDiscard({ ...intent, receipt: prunedPreview.receipt, stop: async () => {
    await deleteTransaction(intent.stateRoot, prunedPreview.receipt);
    return { ok: true };
  } });
  assert.equal(pruned.action, "kept");
  assert.match(pruned.reason, /removal intent/);
  assert.ok(fs.existsSync(intent.work), "removal cannot recreate a pruned receipt");
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
  git(master.mainPath, "branch", "-m", "master", "trunk");
  assert.equal((await preview(master)).target.baseRef, "refs/heads/trunk");
  git(master.work, "branch", "-m", "main");
  master.worktree = linkedWorktrees(path.join(master.mainPath, ".git"))[0];
  assert.equal((await preview(master)).target.baseRef, "refs/heads/trunk", "implicit all-scope base falls back when the default is the target");
  git(master.mainPath, "checkout", "--detach", "-q");
  assert.equal((await preview(master)).target.baseRef, "HEAD");
  const logState = path.join(root, "logs");
  await Promise.all(Array.from({ length: 20 }, (_, i) => appendRemoval(logState, { at: new Date().toISOString(), i })));
  assert.equal(fs.readFileSync(removalLogPath(logState), "utf8").trim().split("\n").length, 20);
  console.log("worktree discard: stale receipts, scopes, raw inventory, intent-write refusal and serialized log assertions passed");
  const planFixture = fixture();
  const planName = planFixture.worktree.name;
  const planStore = addPlansStore(planFixture.mainPath);
  const planFile = (stage) => path.join(planStore, "plans", stage, "story.md");
  const planText = `---\nid: abc12345\nworktree: ${planName}\n---\n\n# Story\n`;
  function planStage(stage) {
    for (const folder of ["active", "completed"]) fs.rmSync(planFile(folder), { force: true });
    fs.mkdirSync(path.dirname(planFile(stage)), { recursive: true });
    fs.writeFileSync(planFile(stage), planText);
  }
  const discardCommand = (cwd, ...args) => spawnSync(process.execPath, [cli, "git", "worktrees", "discard", ...args], {
    cwd, encoding: "utf8", env: { ...process.env, ROBOREPO_STATE_ROOT: planFixture.stateRoot },
  });
  const subdir = path.join(planFixture.work, "nested");
  fs.mkdirSync(subdir);
  fs.writeFileSync(path.join(subdir, "leftover"), "local work");
  const currentCheckout = discardCommand(subdir, "feature", "--scope", "all", "--json");
  assert.equal(currentCheckout.status, 1, currentCheckout.stderr);
  assert.match(currentCheckout.stdout, /current or main checkout/);
  planStage("active");
  const activePreview = discardCommand(planFixture.mainPath, "--plan", "abc12345", "--json");
  assert.equal(activePreview.status, 1);
  assert.match(activePreview.stderr, /plan must be completed/);
  planStage("completed");
  const planPreview = discardCommand(planFixture.mainPath, "--plan", "abc12345", "--json");
  assert.equal(planPreview.status, 0, planPreview.stderr || planPreview.stdout);
  const { receipt, scope } = JSON.parse(planPreview.stdout);
  assert.ok(receipt);
  assert.equal(scope, "leftovers");
  planStage("active");
  const activeApply = discardCommand(planFixture.mainPath, "--plan", "abc12345", "--receipt", receipt, "--apply", "--json");
  assert.equal(activeApply.status, 1);
  assert.match(activeApply.stderr, /plan must be completed/);
  assert.ok(fs.existsSync(planFixture.work));
  console.log("worktree discard: current-checkout and plan lifecycle guards passed");
  planStage("completed");
  const planApply = discardCommand(planFixture.mainPath, "--plan", "abc12345", "--receipt", receipt, "--apply", "--json");
  assert.equal(planApply.status, 0, planApply.stderr || planApply.stdout);
  assert.equal(JSON.parse(planApply.stdout).action, "removed");
  assert.equal(fs.existsSync(planFixture.work), false, "completed plan can discard approved leftovers at a reachable tip");
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
