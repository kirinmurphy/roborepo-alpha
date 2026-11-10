#!/usr/bin/env node
import assert from "node:assert/strict";
import { isolateGitConfig } from "./lib/git-config.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { repositoriesRoutes } from "../cli/portal-routes-repositories.mjs";
import { dispatchRoutes } from "../cli/portal-router.mjs";
import { inspectBranchLanding } from "../../modules/repositories/worktree-landed.mjs";
import { withTemporaryStorage } from "../../modules/repositories/temporary-storage.mjs";
import { assessWorktreePreservation } from "../../modules/repositories/worktree-preservation.mjs";
import { runGitProcess } from "../../modules/repositories/git-exec.mjs";
import { linkedWorktrees } from "../../modules/repositories/worktree-inventory.mjs";
import { deriveWorktreeState, resolveWorktreeStaleDays } from "../../modules/repositories/worktree-state.mjs";
import { cleanupWorktrees, previewRepositoryWorktree, removeRepositoryWorktree, stopRepositoryWorktreeServers, worktreeCleanupCommand } from "../cli/worktree-cleanup.mjs";
import { activeWorktreeNames, proposedWorktreeFolder } from "../cli/worktree-policy.mjs";
import { dismissWorktreeCleanupNotice, enableWorktreeCleanup } from "../cli/worktree-cleanup-optin.mjs";
import { recordRepositoryDiscovery } from "../cli/repositories.mjs";
import { loadRegistry } from "../../modules/repositories/registry.mjs";
import { rootId } from "../../modules/repositories/identity.mjs";
import { removeWorktree, removalLogPath } from "../../modules/repositories/worktree-removal.mjs";
import { withCleanupLock } from "../../modules/repositories/worktree-cleanup-lock.mjs";
import { checkWorktreeRemoval } from "../../modules/repositories/worktree-guards.mjs";
import { inspectWorktreeHook, manageWorktreeHook } from "../cli/worktree-hook.mjs";
import { collectKnownWorktrees } from "../cli/worktree-observations.mjs";
import { addPlansStore, writePlansFiles } from "./lib/plan-store-fixture.mjs";

// Injected filesystem failures below are simulations, not native permission evidence.
{
  const denied = () => { throw Object.assign(new Error("directory denied"), { code: "EPERM" }); };
  // A tiny filesystem double covers complete removal even when native rmdir is blocked.
  let removed = false;
  const complete = await withTemporaryStorage("landing", async () => ({ landed: true }), { fsApi: {
    mkdtempSync: () => "/synthetic/owned",
    lstatSync() { if (removed) throw Object.assign(new Error("gone"), { code: "ENOENT" }); return { dev: 1, ino: 1, isDirectory: () => true }; },
    readdirSync: () => [], rmdirSync() { removed = true; },
  } });
  assert.equal(complete.landed, true);
  assert.deepEqual(complete.cleanupWarnings, []);
  assert.equal(removed, true);
  const warnings = [];
  const fixtures = [];
  const options = { fsApi: { ...fs, mkdtempSync(prefix) { const directory = fs.mkdtempSync(prefix); fixtures.push(directory); return directory; }, rmdirSync: denied }, warn: (message) => warnings.push(message) };
  let temporary;
  const result = await withTemporaryStorage("landing", async (directory) => {
    temporary = directory;
    for (const sibling of ["first", "second"]) {
      fs.mkdirSync(path.join(directory, sibling));
      fs.writeFileSync(path.join(directory, sibling, "object"), "synthetic");
    }
    return { landed: false, reason: "not absorbed" };
  }, options);
  assert.equal(result.landed, false);
  assert.equal(result.cleanupWarnings.length, 1);
  assert.equal(warnings.length, 1);
  for (const sibling of ["first", "second"]) assert.deepEqual(fs.readdirSync(path.join(temporary, sibling)), []);
  assert.match(path.basename(temporary), /^roborepo-disposable-landing-/);
  const original = new Error("assessment failed");
  await assert.rejects(withTemporaryStorage("landing", async () => { throw original; }, options), (error) => error === original && error.cleanupWarnings.length === 1);
  await assert.rejects(withTemporaryStorage("preservation", async (directory) => {
    fs.writeFileSync(path.join(directory, "object"), "synthetic");
    throw original;
  }, { ...options, fsApi: { ...options.fsApi, unlinkSync: denied } }), (error) => error.cause === original && error.errors.includes(original) && /cleanup failed/.test(error.message));
  await assert.rejects(withTemporaryStorage("landing", async (directory) => {
    fs.writeFileSync(path.join(directory, "object"), "synthetic");
    return { landed: true };
  }, { ...options, fsApi: { ...options.fsApi, unlinkSync() {} } }), /left a file/);
  await assert.rejects(withTemporaryStorage("landing", async () => ({ landed: true }), {
    ...options, fsApi: { ...options.fsApi, readdirSync: denied },
  }), /cleanup failed/);
  await assert.rejects(withTemporaryStorage("landing", async () => ({ landed: true }), {
    ...options, fsApi: { ...fs, rmdirSync() { throw Object.assign(new Error("io failed"), { code: "EIO" }); } },
  }), /io failed/);
  await assert.rejects(withTemporaryStorage("preservation", async (directory) => {
    fs.writeFileSync(path.join(directory, "object"), "synthetic");
    return { state: "unknown", reason: "original assessment failure" };
  }, { ...options, fsApi: { ...options.fsApi, unlinkSync: denied } }), (error) =>
    error.assessment.state === "unknown" && /original assessment failure/.test(error.message) && /cleanup failed/.test(error.message));
  await assert.rejects(withTemporaryStorage("landing", async (directory) => {
    fs.writeFileSync(path.join(directory, "unexpected"), "synthetic");
    return { landed: true };
  }, { ...options, fsApi: { ...options.fsApi, lstatSync(file) {
    if (path.basename(file) === "unexpected") return { isDirectory: () => false, isFile: () => false, isSymbolicLink: () => false };
    return fs.lstatSync(file);
  } } }), /unexpected entry/);
  let replaced = false;
  await assert.rejects(withTemporaryStorage("landing", async () => {
    replaced = true;
    return { landed: true };
  }, { ...options, fsApi: { ...options.fsApi, lstatSync(file) {
    const stat = fs.lstatSync(file);
    if (replaced) return { dev: stat.dev, ino: stat.ino + 1, isDirectory: () => true };
    return stat;
  } } }), /replaced/);
  const removal = await removeWorktree("unused", { path: "/unused/worktree", branch: "feature" }, {
    kind: "automatic", runGit: async () => ({ ok: false, error: "EPERM: worktree removal denied" }),
  });
  assert.equal(removal.ok, false);
  assert.equal(removal.entry, undefined);
  assert.match(removal.reason, /preservation proof or validated receipt required/);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-cleanup-outside-"));
  fixtures.push(outside);
  fs.writeFileSync(path.join(outside, "keep"), "untouched");
  await withTemporaryStorage("landing", async (directory) => {
    fs.symlinkSync(outside, path.join(directory, "link"));
    return { landed: true };
  }, options);
  assert.equal(fs.readFileSync(path.join(outside, "keep"), "utf8"), "untouched");
  // Remove synthetic file contents even when the host retains the test directory shells.
  for (const directory of fixtures) {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name);
      if (!fs.lstatSync(file).isDirectory()) fs.unlinkSync(file);
    }
  }
  // Exercise each public assessment under simulated directory denial.
  const rmdir = fs.rmdirSync;
  const warn = console.warn;
  fs.rmdirSync = denied;
  console.warn = () => {};
  try {
    const landing = await inspectBranchLanding("unused", "feature", { runGit: async () => ({ ok: false }) });
    assert.equal(landing.reason, "unsupported Git drivers");
    assert.equal(landing.cleanupWarnings.length, 1);
    const preservation = await assessWorktreePreservation("unused", { runGit: async () => { throw new Error(original.message); } });
    assert.equal(preservation.state, "unknown");
    assert.equal(preservation.reason, original.message);
    assert.equal(preservation.cleanupWarnings.length, 1);
    await assert.rejects(inspectBranchLanding("unused", "feature", { runGit: async () => { throw original; } }), (error) => error === original);
  } finally { fs.rmdirSync = rmdir; console.warn = warn; }
  // Reach historical attribute reads and the content merge, not just early Git failures.
  const rm = fs.rmSync;
  const unlink = fs.unlinkSync;
  const indexes = [];
  const historicalGit = async (_cwd, args, options = {}) => {
    const output = (stdout) => ({ ok: true, code: 0, stdout });
    if (args[0] === "config") return output("");
    if (args[0] === "symbolic-ref") return output("main");
    if (args[0] === "merge-base") return output("fork");
    if (args[0] === "reflog") return output("tip\nfork");
    if (args[0] === "rev-list") return output(args.includes("--reverse") ? "landed" : args.includes("--first-parent") ? "landed\nfork" : "tip");
    if (args[0] === "ls-tree") return output("file.txt\0");
    if (args.includes("read-tree")) {
      indexes.push(options.plumbing.indexFile);
      fs.writeFileSync(options.plumbing.indexFile, "temporary index");
      return output("");
    }
    if (args[0] === "check-attr") return output("file.txt\0filter\0unspecified\0file.txt\0merge\0unspecified\0");
    if (args[0] === "merge-tree") return output("tree");
    if (args[0] === "rev-parse") return output(args.includes("--git-common-dir") ? os.tmpdir() : args[1].endsWith("^{tree}") ? "tree" : "tip");
    throw new Error(`unexpected Git command: ${args.join(" ")}`);
  };
  fs.rmdirSync = denied;
  fs.rmSync = denied;
  console.warn = () => {};
  try {
    for (const recorded of [null, "landed"]) {
      const landing = await inspectBranchLanding("unused", "feature", { recorded, runGit: historicalGit });
      assert.equal(landing.landed, true, JSON.stringify(landing));
      assert.equal(landing.reused, Boolean(recorded));
      assert.equal(landing.cleanupWarnings.length, 1);
      assert.ok(indexes.every((file) => !fs.existsSync(file)), "temporary indexes must be removed");
    }
    for (const command of ["ls-tree", "read-tree", "check-attr", "merge-tree", "landed^{tree}"]) {
      const failed = await inspectBranchLanding("unused", "feature", { runGit: (cwd, args, options) =>
        args.includes(command) ? { ok: false, code: 128, stdout: "", stderr: `${command} denied` } : historicalGit(cwd, args, options) });
      assert.equal(failed.reason, "scan unavailable");
      assert.equal(failed.error, `${command} denied`);
    }
    const unsupported = await inspectBranchLanding("unused", "feature", { runGit: (cwd, args, options) =>
      args[0] === "check-attr" ? { ok: true, code: 0, stdout: "file.txt\0filter\0custom\0" } : historicalGit(cwd, args, options) });
    assert.equal(unsupported.landed, false);
    assert.match(unsupported.error, /unsupported attribute filter=custom/);
    fs.unlinkSync = denied;
    await assert.rejects(inspectBranchLanding("unused", "feature", { runGit: historicalGit }), /temporary cleanup failed/);
  } finally {
    fs.rmSync = rm; fs.rmdirSync = rmdir; fs.unlinkSync = unlink; console.warn = warn;
    for (const file of indexes) if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  // Native disposable fixture: a successful return must mean either removal or verified shells.
  let native;
  const nativeResult = await withTemporaryStorage("preservation", async (directory) => {
    native = directory;
    fs.mkdirSync(path.join(directory, "nested"));
    fs.writeFileSync(path.join(directory, "nested", "object"), "synthetic");
    return { state: "preserved" };
  });
  assert.equal(nativeResult.state, "preserved");
  assert.equal(fs.existsSync(path.join(native, "nested", "object")), false);
  if (!nativeResult.cleanupWarnings.length) assert.equal(fs.existsSync(native), false);
  console.log(`native temporary cleanup: ${nativeResult.cleanupWarnings.length ? "verified directory shells deferred" : "fully removed"}`);
}

if (process.argv.includes("--temporary-cleanup-only")) {
  console.log("temporary cleanup regressions: passed");
  process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-worktree-lifecycle-"));
const restoreGitConfig = isolateGitConfig(root);

function git(cwd, ...args) {
  const result = spawnSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function repository(name) {
  const main = path.join(root, name);
  fs.mkdirSync(main, { recursive: true });
  git(main, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(main, "seed.txt"), "seed\n");
  git(main, "add", "seed.txt");
  git(main, "commit", "-qm", "seed");
  const worktree = path.join(root, `${name}-work`);
  git(main, "worktree", "add", "-q", "-b", "feature", worktree);
  return { main, worktree };
}

function commit(cwd, file, content) {
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, "add", file);
  git(cwd, "commit", "-qm", file);
}

async function waitFor(check, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for cleanup hook");
}

try {
  {
    const now = new Date("2026-10-10T00:00:00Z");
    const twoDaysAgo = "2026-10-08T00:00:00Z";
    assert.equal(deriveWorktreeState({ activityAt: [twoDaysAgo], now }).state, "idle");
    assert.equal(deriveWorktreeState({ activityAt: [twoDaysAgo], now, staleDays: 1 }).state, "stale");
    assert.equal(deriveWorktreeState({ activityAt: [twoDaysAgo], now, landed: true }).state, "landed");
    assert.equal(deriveWorktreeState({ activityAt: [twoDaysAgo], now, running: true }).state, "running");
    assert.equal(resolveWorktreeStaleDays().days, 7);
    assert.equal(resolveWorktreeStaleDays({ preference: 4 }).days, 4);
    assert.equal(resolveWorktreeStaleDays({ preference: 4, environment: "1" }).days, 1);
    assert.equal(deriveWorktreeState({ activityAt: [twoDaysAgo], now, staleDays: resolveWorktreeStaleDays({ environment: "1" }).days }).state, "stale");
    assert.equal(deriveWorktreeState({ activityAt: [twoDaysAgo], now, staleDays: resolveWorktreeStaleDays().days }).state, "idle");
    assert.match(resolveWorktreeStaleDays({ environment: "nope" }).finding, /invalid environment/);
  }
  {
    const { main, worktree } = repository("fresh");
    assert.equal((await inspectBranchLanding(main, "feature")).reason, "no own work");
    commit(main, "transition.txt", "on main\n");
    git(worktree, "merge", "-q", "--ff-only", "main");
    assert.equal((await inspectBranchLanding(main, "feature")).reason, "no own work", "base first-parent commits are not own work");
  }
  {
    const { main, worktree } = repository("squash");
    commit(worktree, ".gitattributes", "* text=auto eol=lf\n");
    commit(worktree, "feature.txt", "feature\n");
    fs.mkdirSync(path.join(worktree, "notes/active"), { recursive: true });
    commit(worktree, "notes/active/story.md", "---\nid: story\n---\n");
    assert.equal((await inspectBranchLanding(main, "feature")).landed, false);
    git(main, "merge", "--squash", "feature");
    git(main, "commit", "-qm", "squash feature");
    const first = await inspectBranchLanding(main, "feature");
    assert.equal(first.landed, true, first.reason);
    assert.equal(first.absorbingCommit, git(main, "rev-parse", "HEAD"));
    const candidateOptions = { cwd: main, stateRoot: path.join(root, "no-gh-state"), discover: async () => ({ instances: [] }) };
    const withNormalPath = await cleanupWorktrees(candidateOptions);
    const gitExecutable = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    const noGhBin = path.join(root, "no-gh-bin");
    fs.mkdirSync(noGhBin);
    fs.symlinkSync(gitExecutable, path.join(noGhBin, "git"));
    const originalPath = process.env.PATH;
    let withoutGh;
    try {
      process.env.PATH = noGhBin;
      withoutGh = await cleanupWorktrees(candidateOptions);
    } finally { process.env.PATH = originalPath; }
    assert.deepEqual(withoutGh, withNormalPath, "gh availability cannot change the candidate list");
    fs.mkdirSync(path.join(main, "notes/completed"), { recursive: true });
    git(main, "mv", "notes/active/story.md", "notes/completed/story.md");
    git(main, "commit", "-qm", "move story");
    commit(main, "feature.txt", "later edit\n");
    assert.equal((await inspectBranchLanding(main, "feature")).landed, true, "a later base edit cannot undo landing");
    commit(worktree, "extra.txt", "new branch work\n");
    assert.equal((await inspectBranchLanding(main, "feature")).landed, false, "branch work after merge is unlanded");
  }
  {
    const { main, worktree } = repository("rebase");
    commit(worktree, "feature.txt", "feature\n");
    commit(main, "base.txt", "base moved\n");
    git(main, "cherry-pick", "feature");
    assert.equal((await inspectBranchLanding(main, "feature")).landed, true, "a cherry-picked branch is landed");
  }
  {
    const { main, worktree } = repository("recorded");
    commit(worktree, "feature.txt", "feature\n");
    commit(main, "base.txt", "base moved\n");
    const beforeLanding = git(main, "rev-parse", "HEAD");
    git(main, "merge", "--squash", "feature");
    git(main, "commit", "-qm", "squash feature");
    const squash = git(main, "rev-parse", "HEAD");
    commit(main, "later.txt", "later base work\n");
    let mergeChecks = 0;
    let tipInspections = 0;
    const featureTip = git(worktree, "rev-parse", "HEAD");
    const counting = (cwd, args, options) => {
      if (args[0] === "merge-tree") mergeChecks += 1;
      if (args[0] === "ls-tree" && args.at(-1) === featureTip) tipInspections += 1;
      return runGitProcess(cwd, args, options);
    };

    const scanned = await inspectBranchLanding(main, "feature", { runGit: counting });
    assert.equal(tipInspections, 1, "the branch tip attributes are inspected once across landing candidates");
    mergeChecks = 0;
    assert.equal(scanned.absorbingCommit, squash);
    assert.equal(scanned.reused, false, "without a recorded commit the scan finds the absorbing commit");

    const verified = await inspectBranchLanding(main, "feature", { recorded: squash, runGit: counting });
    assert.equal(verified.landed, true);
    assert.equal(verified.absorbingCommit, squash);
    assert.equal(verified.reused, true, "a recorded commit that still absorbs the branch is reused");
    assert.equal(mergeChecks, 1, "verifying the recorded commit replaces the first-parent scan");

    const wrong = await inspectBranchLanding(main, "feature", { recorded: beforeLanding });
    assert.deepEqual([wrong.landed, wrong.absorbingCommit, wrong.reused], [true, squash, false], "a recorded commit that does not absorb the branch falls back to the scan");
    const outside = await inspectBranchLanding(main, "feature", { recorded: git(main, "rev-list", "--max-parents=0", "HEAD") });
    assert.deepEqual([outside.absorbingCommit, outside.reused], [squash, false], "a recorded commit before the fork is never reused");

    commit(worktree, "extra.txt", "new branch work\n");
    assert.equal((await inspectBranchLanding(main, "feature", { recorded: squash })).landed, false, "a recorded commit never vouches for later branch work");
  }
  {
    const { main, worktree } = repository("merge");
    commit(worktree, "feature.txt", "feature\n");
    git(main, "merge", "--no-ff", "-qm", "merge feature", "feature");
    assert.equal((await inspectBranchLanding(main, "feature")).landed, true, "merge commit with reflog is landed");
    git(main, "reflog", "expire", "--expire=now", "--all");
    assert.equal((await inspectBranchLanding(main, "feature")).reason, "no own work", "expired reflog gives a conservative verdict");
  }
  {
    const { main, worktree } = repository("inventory");
    const commonDir = path.join(main, ".git");
    let items = linkedWorktrees(commonDir);
    assert.equal(items.length, 1);
    assert.equal(items[0].branch, "feature");
    assert.equal(items[0].prunable, false);
    git(main, "worktree", "lock", worktree);
    items = linkedWorktrees(commonDir);
    assert.equal(items[0].locked, true);
    git(main, "worktree", "unlock", worktree);
    git(worktree, "checkout", "--detach", "-q");
    items = linkedWorktrees(commonDir);
    assert.equal(items[0].detached, true);
    assert.equal(items[0].branch, null);
    assert.equal((await checkWorktreeRemoval({ worktree: items[0], kind: "automatic", landed: true, worktreeRoot: fs.realpathSync(root), mainPath: main })).reason, "detached worktree; suggested for removal");
    assert.equal((await checkWorktreeRemoval({ worktree: items[0], kind: "confirmed", mainPath: main })).ok, true);
    fs.rmSync(worktree, { recursive: true });
    items = linkedWorktrees(commonDir);
    assert.equal(items[0].prunable, true);
    assert.equal((await checkWorktreeRemoval({ worktree: items[0], kind: "automatic", landed: true, worktreeRoot: root, mainPath: main })).reason, "prunable worktree");
    assert.equal((await checkWorktreeRemoval({ worktree: items[0], kind: "confirmed", mainPath: main })).reason, "prunable worktree");
  }
  {
    const { main, worktree } = repository("cap");
    commit(worktree, "feature.txt", "feature\n");
    commit(main, "other.txt", "other\n");
    assert.equal((await inspectBranchLanding(main, "feature", { scanLimit: 0 })).reason, "scan limit exceeded");
  }
  {
    const { main, worktree } = repository("cleanup");
    const stateRoot = path.join(root, "cleanup-state");
    const store = addPlansStore(main, { "plans-config.json": JSON.stringify({ worktreeRoot: root }), "active/story.md": "---\nid: story1\nworktree: cleanup-work\n---\n" });
    commit(worktree, "feature.txt", "feature\n");
    git(main, "merge", "--squash", "feature");
    git(main, "commit", "-qm", "landed feature");
    const options = { cwd: main, stateRoot, discover: async () => ({ instances: [] }) };
    await assert.rejects(cleanupWorktrees({ ...options, apply: true, discover: async () => { throw new Error("discovery failed"); } }), /discovery failed/);
    let rows = await cleanupWorktrees(options);
    assert.equal(rows.find((row) => row.branch === "feature").reason, "plan not closed");
    fs.mkdirSync(path.join(store, "plans/completed"), { recursive: true });
    fs.renameSync(path.join(store, "plans/active/story.md"), path.join(store, "plans/completed/story.md"));
    assert.equal(rows.find((row) => row.branch === "feature").landingEvidence, "scanned");
    fs.appendFileSync(path.join(store, "plans/completed/story.md"), `\n## Verification\n\n- Absorbing commit: ${git(main, "rev-parse", "HEAD")}\n`);
    rows = await cleanupWorktrees({ ...options, plan: "story1", apply: true });
    assert.equal(rows[0].action, "removed", rows[0].reason);
    assert.equal(rows[0].landingEvidence, "reused", "plan-scoped cleanup verifies the plan's recorded absorbing commit");
    assert.equal(fs.existsSync(worktree), false);
    assert.equal(git(main, "branch", "--list", "feature"), "");
    const log = fs.readFileSync(removalLogPath(stateRoot), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(log.length, 1);
    assert.equal(log[0].branch, "feature");
    const locked = await withCleanupLock(stateRoot, async () => withCleanupLock(stateRoot, async () => "wrong"));
    assert.equal(locked.result.locked, true, "a second cleanup cannot enter the lock");
  }
  {
    // /plan-close commits the absorbing commit on local main and cleans up before anything is
    // pushed. Plan-scoped cleanup must check that same base, not `origin/HEAD`, which lags behind.
    const { main, worktree } = repository("unpushed-close");
    const remote = path.join(root, "unpushed-close-remote.git");
    git(root, "init", "-q", "--bare", remote);
    git(main, "remote", "add", "origin", remote);
    git(main, "push", "-q", "-u", "origin", "main");
    git(main, "remote", "set-head", "origin", "main");
    const stateRoot = path.join(root, "unpushed-close-state");
    const store = addPlansStore(main, { "plans-config.json": JSON.stringify({ worktreeRoot: root }) });
    commit(worktree, "feature.txt", "feature\n");
    git(main, "merge", "--squash", "feature");
    git(main, "commit", "-qm", "landed feature");
    writePlansFiles(store, { "completed/story.md": `---\nid: unpushed1\nworktree: unpushed-close-work\n---\n\n## Verification\n\n- Absorbing commit: ${git(main, "rev-parse", "HEAD")}\n` });
    const options = { cwd: main, stateRoot, discover: async () => ({ instances: [] }) };
    const unscoped = await cleanupWorktrees(options);
    assert.equal(unscoped.find((row) => row.branch === "feature").state, "not landed", "unscoped cleanup still checks origin/HEAD");
    const rows = await cleanupWorktrees({ ...options, plan: "unpushed1", apply: true });
    assert.equal(rows[0].action, "removed", rows[0].reason);
    assert.equal(rows[0].landingEvidence, "reused");
    assert.equal(fs.existsSync(worktree), false);
    await assert.rejects(worktreeCleanupCommand(["--plan", "unpushed1", "--base"]), /--base needs a value/);
  }
  {
    const { main, worktree } = repository("confirmed");
    const stateRoot = path.join(root, "confirmed-state");
    commit(worktree, "feature.txt", "unmerged\n");
    const branchTip = git(worktree, "rev-parse", "HEAD");
    const rows = await cleanupWorktrees({ cwd: main, stateRoot, remove: "feature", confirm: true, apply: true, discover: async () => ({ instances: [] }) });
    assert.equal(rows[0].action, "kept", rows[0].reason);
    assert.match(rows[0].reason, /discard/);
    assert.equal(fs.existsSync(worktree), true, "clean unmerged work requires a loss preview");
    assert.equal(git(main, "rev-parse", "feature"), branchTip);
    assert.equal(git(main, "for-each-ref", "--format=%(refname)", "refs/roborepo/abandoned", "refs/roborepo/worktree-archives"), "", "refused cleanup creates no recovery refs");
  }
  {
    // A value-taking option must get a value, not the next flag.
    for (const args of [["--remove"], ["--plan", "--apply"], ["--current", ""]]) {
      await assert.rejects(worktreeCleanupCommand(args), /needs a value/, args.join(" "));
    }
  }
  {
    const { main, worktree } = repository("ignored");
    commit(worktree, ".gitignore", ".env\nnode_modules/\n");
    fs.writeFileSync(path.join(worktree, ".env"), "secret\n");
    fs.mkdirSync(path.join(worktree, "node_modules"));
    fs.writeFileSync(path.join(worktree, "node_modules", "package.txt"), "disposable\n");
    const item = linkedWorktrees(path.join(main, ".git"))[0];
    for (const kind of ["automatic", "confirmed"]) {
      const result = await checkWorktreeRemoval({ worktree: item, kind, landed: true, worktreeRoot: fs.realpathSync(root), mainPath: main, currentPath: main });
      assert.match(result.reason, /\.env/);
    }
    fs.rmSync(path.join(worktree, ".env"));
    assert.equal((await checkWorktreeRemoval({ worktree: item, kind: "automatic", landed: true, worktreeRoot: fs.realpathSync(root), mainPath: main })).ok, true, "disposable ignored output does not block removal");
  }
  {
    const { main, worktree } = repository("branch-only");
    const stateRoot = path.join(root, "branch-only-state");
    commit(worktree, "feature.txt", "feature\n");
    git(main, "merge", "--squash", "feature");
    git(main, "commit", "-qm", "landed feature");
    git(main, "worktree", "remove", worktree);
    const rows = await cleanupWorktrees({ cwd: main, stateRoot, apply: true, discover: async () => ({ instances: [] }) });
    assert.equal(rows.find((row) => row.branch === "feature").action, "removed");
    assert.equal(git(main, "branch", "--list", "feature"), "");
    assert.equal(JSON.parse(fs.readFileSync(removalLogPath(stateRoot), "utf8")).path, null);
  }
  {
    const { main, worktree } = repository("guards");
    const item = linkedWorktrees(path.join(main, ".git"))[0];
    const base = { worktree: item, kind: "automatic", landed: true, worktreeRoot: fs.realpathSync(root), mainPath: main, currentPath: main };
    assert.equal((await checkWorktreeRemoval({ ...base, landed: false })).reason, "not landed");
    assert.match((await checkWorktreeRemoval({ ...base, worktreeRoot: main })).reason, /not in worktree folder/);
    assert.equal((await checkWorktreeRemoval({ ...base, kind: "confirmed", worktreeRoot: main })).ok, true);
    assert.equal((await checkWorktreeRemoval({ ...base, currentPath: item.path })).reason, "current or main checkout");
    assert.equal((await checkWorktreeRemoval({ ...base, kind: "confirmed", currentPath: item.path })).reason, "current or main checkout");
    assert.equal((await checkWorktreeRemoval({ ...base, activePlan: true })).reason, "plan not closed");
    assert.equal((await checkWorktreeRemoval({ ...base, running: true })).reason, "dev server running");
    assert.equal((await checkWorktreeRemoval({ ...base, kind: "confirmed", running: true })).reason, "dev server running");
    assert.equal((await checkWorktreeRemoval({ ...base, kind: "confirmed", activePlan: true })).warning, "plan still active");
    for (const kind of ["automatic", "confirmed"]) {
      assert.equal((await checkWorktreeRemoval({ ...base, kind, runGit: async () => ({ ok: false }) })).reason, "working tree status unavailable");
      let calls = 0;
      assert.equal((await checkWorktreeRemoval({ ...base, kind, runGit: async () => ++calls === 1 ? { ok: true, stdout: "" } : { ok: false } })).reason, "ignored files status unavailable");
      const mainPath = fs.realpathSync(main);
      assert.equal((await checkWorktreeRemoval({ ...base, kind, mainPath, worktree: { ...item, path: mainPath } })).reason, "current or main checkout");
    }
    commit(worktree, ".gitmodules", "[submodule \"x\"]\n path = x\n url = https://example.com/x\n");
    assert.equal((await checkWorktreeRemoval(base)).reason, "worktree has submodules");
    assert.equal((await checkWorktreeRemoval({ ...base, kind: "confirmed" })).reason, "worktree has submodules");
    fs.rmSync(path.join(worktree, ".gitmodules"));
    git(worktree, "add", "-u");
    git(worktree, "commit", "-qm", "remove modules");
    fs.writeFileSync(path.join(worktree, "dirty.txt"), "dirty\n");
    assert.equal((await checkWorktreeRemoval(base)).reason, "uncommitted or untracked changes");
    assert.equal((await checkWorktreeRemoval({ ...base, kind: "confirmed" })).reason, "uncommitted or untracked changes");
    assert.equal((await checkWorktreeRemoval({ ...base, consent: true })).reason, "uncommitted or untracked changes", "automatic cleanup cannot discard local changes");
    assert.equal((await checkWorktreeRemoval({ ...base, kind: "confirmed", consent: true })).ok, true);
    fs.writeFileSync(path.join(worktree, ".gitignore"), "valuable.txt\n");
    fs.writeFileSync(path.join(worktree, "valuable.txt"), "valuable ignored content\n");
    assert.equal((await checkWorktreeRemoval({ ...base, kind: "confirmed", consent: true })).ok, true, "validated consent covers reviewed ignored files");
    fs.rmSync(path.join(worktree, "valuable.txt"));
    fs.rmSync(path.join(worktree, ".gitignore"));
    fs.rmSync(path.join(worktree, "dirty.txt"));
    git(main, "worktree", "lock", worktree);
    assert.equal((await checkWorktreeRemoval({ ...base, worktree: linkedWorktrees(path.join(main, ".git"))[0] })).reason, "worktree locked");
    assert.equal((await checkWorktreeRemoval({ ...base, kind: "confirmed", worktree: linkedWorktrees(path.join(main, ".git"))[0] })).reason, "worktree locked");
    git(main, "worktree", "unlock", worktree);
  }
  {
    const { main } = repository("hook");
    const stateRoot = path.join(root, "hook-state");
    const installed = await manageWorktreeHook({ cwd: main, stateRoot });
    assert.equal(installed.action, "installed");
    assert.match(fs.readFileSync(installed.hook, "utf8"), /roborepo-worktree-cleanup/);
    assert.equal((await manageWorktreeHook({ cwd: main, install: false, stateRoot })).action, "uninstalled");
    fs.writeFileSync(installed.hook, "#!/bin/sh\n# foreign\n");
    assert.equal((await manageWorktreeHook({ cwd: main, stateRoot })).action, "foreign hook");
    assert.match(fs.readFileSync(installed.hook, "utf8"), /foreign/);
  }
  {
    const { main } = repository("pull-triggers");
    const remote = path.join(root, "pull-remote.git");
    git(root, "init", "-q", "--bare", remote);
    git(main, "remote", "add", "origin", remote);
    git(main, "push", "-q", "-u", "origin", "main");
    const receiver = path.join(root, "pull-receiver");
    const sender = path.join(root, "pull-sender");
    git(root, "clone", "-q", "-b", "main", remote, receiver);
    git(root, "clone", "-q", "-b", "main", remote, sender);
    const marker = path.join(root, "post-merge-events");
    const hook = path.join(receiver, ".git/hooks/post-merge");
    fs.writeFileSync(hook, `#!/bin/sh\necho event >> '${marker}'\n`, { mode: 0o755 });
    commit(sender, "one.txt", "one\n");
    git(sender, "push", "-q", "origin", "main");
    git(receiver, "pull", "-q", "--ff-only");
    const afterFastForward = fs.readFileSync(marker, "utf8").trim().split("\n").length;
    git(receiver, "pull", "-q", "--ff-only");
    const afterUpToDate = fs.readFileSync(marker, "utf8").trim().split("\n").length;
    commit(sender, "two.txt", "two\n");
    git(sender, "push", "-q", "origin", "main");
    git(receiver, "pull", "-q", "--rebase");
    const afterRebase = fs.readFileSync(marker, "utf8").trim().split("\n").length;
    assert.equal(afterFastForward, 1);
    assert.equal(afterUpToDate, 1);
    console.log(`post-merge measurements: fast-forward=${afterFastForward > 0} up-to-date=${afterUpToDate > afterFastForward} rebase-no-local=${afterRebase > afterUpToDate}`);
  }
  {
    const { main } = repository("hook-pull-seed");
    const remote = path.join(root, "hook-pull-remote.git");
    git(root, "init", "-q", "--bare", remote);
    git(main, "remote", "add", "origin", remote);
    git(main, "push", "-q", "-u", "origin", "main");
    const receiver = path.join(root, "hook-pull-receiver");
    const sender = path.join(root, "hook-pull-sender");
    git(root, "clone", "-q", "-b", "main", remote, receiver);
    git(root, "clone", "-q", "-b", "main", remote, sender);
    const store = addPlansStore(receiver, { "plans-config.json": JSON.stringify({ worktreeRoot: root }), "active/story.md": "---\nid: hookstory\nworktree: hook-pull-feature\n---\n" });
    const feature = path.join(root, "hook-pull-feature");
    git(receiver, "worktree", "add", "-q", "-b", "feature", feature);
    commit(feature, "feature.txt", "feature\n");
    git(feature, "push", "-q", "-u", "origin", "feature");
    const free = path.join(root, "hook-pull-free");
    git(receiver, "worktree", "add", "-q", "-b", "free", free);
    commit(free, "free.txt", "free\n");
    git(free, "push", "-q", "-u", "origin", "free");
    git(sender, "fetch", "-q", "origin", "feature");
    git(sender, "merge", "--squash", "origin/feature");
    git(sender, "commit", "-qm", "squash feature");
    git(sender, "fetch", "-q", "origin", "free");
    git(sender, "merge", "--squash", "origin/free");
    git(sender, "commit", "-qm", "squash free");
    git(sender, "push", "-q", "origin", "main");
    const stateRoot = path.join(root, "hook-pull-state");
    await manageWorktreeHook({ cwd: receiver, stateRoot });
    git(receiver, "pull", "-q", "--ff-only");
    const log = path.join(stateRoot, "worktree-cleanup", "hook.log");
    await waitFor(() => fs.existsSync(log) && fs.readFileSync(log, "utf8").includes("plan not closed") && fs.readFileSync(log, "utf8").includes("free: removed"));
    assert.equal(fs.existsSync(feature), true, "an active plan keeps its landed worktree");
    assert.equal(fs.existsSync(free), false, "the hook removes landed work without an active plan");
    fs.mkdirSync(path.join(store, "plans/completed"), { recursive: true });
    fs.renameSync(path.join(store, "plans/active/story.md"), path.join(store, "plans/completed/story.md"));
    const rows = await cleanupWorktrees({ cwd: receiver, stateRoot, plan: "hookstory", apply: true, discover: async () => ({ instances: [] }) });
    assert.equal(rows[0].action, "removed", rows[0].reason);
    assert.equal(fs.existsSync(feature), false);
    assert.equal(fs.readFileSync(removalLogPath(stateRoot), "utf8").trim().split("\n").length, 2);
    assert.equal(fs.existsSync(receiver), true, "the checkout that pulled survives");
  }
  {
    // A relative core.hooksPath resolves inside whichever working tree runs the hook, so the hook
    // installed for the main checkout fires for merges there and never for merges in a linked one.
    const { main, worktree } = repository("relative-hooks");
    addPlansStore(main, { "plans-config.json": JSON.stringify({ worktreeRoot: root }) });
    const done = path.join(root, "relative-hooks-done");
    git(main, "worktree", "add", "-q", "-b", "done", done);
    commit(done, "done.txt", "done\n");
    git(main, "merge", "--squash", "done");
    git(main, "commit", "-qm", "squash done");
    git(main, "config", "core.hooksPath", ".githooks");
    const stateRoot = path.join(root, "relative-hooks-state");
    const installed = await manageWorktreeHook({ cwd: worktree, stateRoot });
    assert.equal(installed.action, "installed");
    assert.equal(installed.scope, "checkout");
    assert.equal(installed.checkout, fs.realpathSync(main));
    {
      // With --separate-git-dir the common directory's parent is not the main checkout, and Git does
      // not record where that checkout is, so a relative hooks path is refused rather than resolved
      // against the wrong folder.
      const separateMain = path.join(root, "separate-main");
      const separateGit = path.join(root, "separate-store", "repo.git");
      fs.mkdirSync(path.dirname(separateGit), { recursive: true });
      git(root, "init", "-q", "-b", "main", "--separate-git-dir", separateGit, separateMain);
      commit(separateMain, "seed.txt", "seed\n");
      const separateWork = path.join(root, "separate-work");
      git(separateMain, "worktree", "add", "-q", "-b", "feature", separateWork);
      git(separateMain, "config", "core.hooksPath", ".githooks");
      const separate = await manageWorktreeHook({ cwd: separateWork, stateRoot: path.join(root, "separate-state") });
      assert.equal(separate.action, "refused");
      assert.match(separate.reason, /Git directory is outside/);
      assert.equal(fs.existsSync(path.join(path.dirname(separateGit), ".githooks")), false, "nothing is written beside the Git directory");
    }
    assert.equal(installed.hook, path.join(fs.realpathSync(main), ".githooks", "post-merge"));
    const log = path.join(stateRoot, "worktree-cleanup", "hook.log");
    git(worktree, "merge", "-q", "--no-edit", "main");
    assert.equal(fs.existsSync(log), false, "a merge in a linked worktree does not find the main checkout's relative hooks");
    commit(worktree, "side.txt", "side\n");
    git(main, "merge", "-q", "--no-edit", "feature");
    await waitFor(() => fs.existsSync(log) && /done: (removed|kept|failed)/.test(fs.readFileSync(log, "utf8")));
    assert.match(fs.readFileSync(log, "utf8"), /done: removed/);
    assert.equal(fs.existsSync(done), false, "a merge in the main checkout runs cleanup");
  }
  {
    // Git exports GIT_DIR to a hook running in a linked worktree; the cleanup it starts must still
    // read each candidate worktree's own status.
    const { main, worktree } = repository("linked-hook");
    addPlansStore(main, { "plans-config.json": JSON.stringify({ worktreeRoot: root }) });
    const done = path.join(root, "linked-hook-done");
    git(main, "worktree", "add", "-q", "-b", "done", done);
    commit(done, "done.txt", "done\n");
    git(main, "merge", "--squash", "done");
    git(main, "commit", "-qm", "squash done");
    const stateRoot = path.join(root, "linked-hook-state");
    const installed = await manageWorktreeHook({ cwd: main, stateRoot });
    assert.equal(installed.scope, "repository");
    // Its own commit gives the merging worktree an index that differs from every other checkout.
    commit(worktree, "own.txt", "own\n");
    git(worktree, "merge", "-q", "--no-edit", "main");
    const log = path.join(stateRoot, "worktree-cleanup", "hook.log");
    await waitFor(() => fs.existsSync(log) && /done: (removed|kept|failed)/.test(fs.readFileSync(log, "utf8")));
    assert.match(fs.readFileSync(log, "utf8"), /done: removed/);
    assert.equal(fs.existsSync(done), false);
    assert.equal(fs.existsSync(worktree), true, "the worktree that merged survives");
  }
  {
    const { main, worktree } = repository("hook-refusals");
    const stateRoot = path.join(root, "hook-refusals-state");
    const defaultHook = path.join(main, ".git/hooks/post-merge");
    const globalConfig = path.join(root, "hook-refusals-gitconfig");
    fs.writeFileSync(globalConfig, `[core]\n\thooksPath = ${path.join(root, "shared-hooks")}\n`);
    const originalGlobal = process.env.GIT_CONFIG_GLOBAL;
    let shared;
    try {
      process.env.GIT_CONFIG_GLOBAL = globalConfig;
      shared = await manageWorktreeHook({ cwd: main, stateRoot });
    } finally {
      if (originalGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = originalGlobal;
    }
    assert.equal(shared.action, "refused");
    assert.match(shared.reason, /global Git config/);
    assert.equal(fs.existsSync(path.join(root, "shared-hooks", "post-merge")), false, "a global hooks directory is never written");
    const cli = path.join(fs.realpathSync(worktree), "scripts/cli/main.mjs");
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(cli, "");
    const insideWorktree = await manageWorktreeHook({ cwd: main, stateRoot, cli });
    assert.equal(insideWorktree.action, "refused");
    assert.match(insideWorktree.reason, /inside linked worktree/);
    assert.equal(fs.existsSync(defaultHook), false, "a hook that cleanup could orphan is not installed");
    git(main, "config", "extensions.worktreeConfig", "true");
    const worktreeHooks = path.join(root, "hook-refusals-worktree-hooks");
    git(worktree, "config", "--worktree", "core.hooksPath", worktreeHooks);
    const perWorktree = await manageWorktreeHook({ cwd: worktree, stateRoot });
    assert.equal(perWorktree.action, "installed");
    assert.equal(perWorktree.scope, "checkout", "worktree config scopes even an absolute hooks path to one checkout");
    assert.equal(perWorktree.checkout, fs.realpathSync(worktree));
    assert.equal(perWorktree.hook, path.join(worktreeHooks, "post-merge"));
  }
  {
    const stateRoot = path.join(root, "stale-lock-state");
    const repositoryPath = path.join(root, "stale-lock-repo");
    const lockDir = path.join(stateRoot, "worktree-cleanup");
    let file;
    await withCleanupLock(stateRoot, async () => { file = path.join(lockDir, fs.readdirSync(lockDir).find((name) => name.endsWith(".lock"))); }, { repositoryPath });
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    fs.writeFileSync(file, `${deadPid}\n`);
    assert.equal((await withCleanupLock(stateRoot, async () => "ran", { repositoryPath })).result, "ran", "a lock left by a dead cleanup is taken over");
    fs.writeFileSync(file, `${process.pid}\n`);
    assert.equal((await withCleanupLock(stateRoot, async () => "ran", { repositoryPath })).locked, true, "a live holder keeps the lock");
    fs.writeFileSync(file, "");
    assert.equal((await withCleanupLock(stateRoot, async () => "ran", { repositoryPath })).locked, true, "a lock whose pid is not yet written is held");
    fs.rmSync(file);
  }
  {
    // A real dependency install lists far more than the Git output buffer holds file by file.
    const { main, worktree } = repository("installed-deps");
    commit(worktree, ".gitignore", "node_modules/\n");
    for (let pkg = 0; pkg < 300; pkg++) {
      const dir = path.join(worktree, "node_modules", `package-with-a-long-name-${pkg}`, "lib");
      fs.mkdirSync(dir, { recursive: true });
      for (let file = 0; file < 100; file++) fs.writeFileSync(path.join(dir, `module-${file}.js`), "");
    }
    const item = linkedWorktrees(path.join(main, ".git"))[0];
    const result = await checkWorktreeRemoval({ worktree: item, kind: "automatic", landed: true, worktreeRoot: fs.realpathSync(root), mainPath: main, currentPath: main });
    assert.equal(result.ok, true, result.reason);
  }
  {
    const { main } = repository("quoted-plan");
    const store = addPlansStore(main, { "active/story.md": "---\nid: quoted\nworktree: \"quoted-plan-work\"\n---\n" });
    assert.equal(activeWorktreeNames(main).has("quoted-plan-work"), true, "a quoted worktree field still protects its worktree");
    writePlansFiles(store, { "review/awaiting.md": "---\nid: awaiting\nworktree: under-review\n---\n", "completed/done.md": "---\nid: done\nworktree: finished-work\n---\n" });
    assert.equal(activeWorktreeNames(main).has("under-review"), true, "a plan under review keeps its worktree");
    assert.equal(activeWorktreeNames(main).has("finished-work"), false, "a completed plan releases its worktree");
  }
  {
    // The reserved plans worktree is out of every cleanup path, and an unreadable store stops automatic removal.
    const { main, worktree } = repository("reserved-store");
    const store = addPlansStore(main, { "plans-config.json": JSON.stringify({ worktreeRoot: root }) });
    commit(worktree, "feature.txt", "feature\n");
    git(main, "merge", "--squash", "feature");
    git(main, "commit", "-qm", "landed feature");
    const options = { cwd: main, stateRoot: path.join(root, "reserved-store-state"), discover: async () => ({ instances: [] }) };
    assert.equal(linkedWorktrees(path.join(main, ".git")).some((item) => item.branch === "repo-plans"), false, "inventory leaves the store out");
    const reserved = linkedWorktrees(path.join(main, ".git"), { includeReserved: true }).find((item) => item.branch === "repo-plans");
    const guard = await checkWorktreeRemoval({ worktree: reserved, kind: "confirmed", consent: true, mainPath: main, currentPath: main });
    assert.deepEqual([guard.ok, guard.reason], [false, "reserved plans worktree"]);
    const [named] = await cleanupWorktrees({ ...options, remove: "repo-plans", confirm: true, apply: true });
    assert.equal(named.action, "kept", "cleanup cannot target the store by name");

    let rows = await cleanupWorktrees({ ...options, apply: false });
    assert.equal(rows.some((row) => row.branch === "repo-plans"), false, "the plans branch is never a retirement candidate");
    assert.equal(rows.find((row) => row.branch === "feature").eligible, true, rows.find((row) => row.branch === "feature").reason);
    fs.rmSync(path.join(store, "plans/active"), { recursive: true, force: true });
    fs.writeFileSync(path.join(store, "plans/active"), "not a folder");
    assert.equal(activeWorktreeNames(main).unreadable, true);
    rows = await cleanupWorktrees({ ...options, apply: true });
    const row = rows.find((item) => item.branch === "feature");
    assert.deepEqual([row.action, row.reason], ["kept", "plans store unreadable"]);
    assert.equal(fs.existsSync(worktree), true, "an unreadable store removes nothing automatically");
    assert.equal(fs.existsSync(store), true);
    assert.equal(git(main, "rev-parse", "--verify", "refs/heads/repo-plans").length > 0, true, "the plans branch survives cleanup");
  }
  {
    assert.equal(proposedWorktreeFolder([
      { path: "/work/repo/.claude/worktrees/app-owned", prunable: false },
      { path: "/work/trees/repo/one", prunable: false },
      { path: "/work/trees/repo/nested/two", prunable: false },
    ]), "/work/trees/repo", "the proposal is the deepest folder holding every worktree a user owns");
    assert.equal(proposedWorktreeFolder([{ path: "/work/repo/.claude/worktrees/app-owned", prunable: false }]), null);
  }
  {
    // A repository without plans-config.json: automatic removal stays inside the folder the user
    // confirmed when turning cleanup on, and suggests everything until then.
    const { main } = repository("optin");
    const realMain = fs.realpathSync(main);
    const stateRoot = path.join(root, "optin-state");
    const repositoryId = "git:example.com/test/optin";
    recordRepositoryDiscovery({
      repositoryId, kind: "git", displayName: "optin", source: "developer-runtime", evidence: "git-remote",
      confidence: "high", localRoot: rootId(realMain), localRootKind: "clone", localRootPath: realMain, stateRoot,
    });
    const folder = path.join(root, "optin-trees");
    fs.mkdirSync(folder);
    const inside = path.join(folder, "inside");
    const outside = path.join(root, "optin-outside");
    git(main, "worktree", "add", "-q", "-b", "inside", inside);
    git(main, "worktree", "add", "-q", "-b", "outside", outside);
    commit(inside, "inside.txt", "inside\n");
    commit(outside, "outside.txt", "outside\n");
    for (const branch of ["inside", "outside"]) {
      git(main, "merge", "--squash", branch);
      git(main, "commit", "-qm", `squash ${branch}`);
    }
    const options = { cwd: main, stateRoot, discover: async () => ({ instances: [] }) };
    let rows = await cleanupWorktrees(options);
    assert.match(rows.find((row) => row.branch === "inside").reason, /not in worktree folder/, "with no folder, landed work is only suggested");
    assert.equal((await inspectWorktreeHook({ cwd: main })).state, "absent");
    await assert.rejects(enableWorktreeCleanup({ repositoryId, folder: os.homedir(), stateRoot }), /home directory/);
    await assert.rejects(enableWorktreeCleanup({ repositoryId, folder: path.join(root, "no-such-folder"), stateRoot }), /Folder not found/);
    const enabled = await enableWorktreeCleanup({ repositoryId, folder, stateRoot });
    assert.equal(enabled.action, "installed");
    assert.equal(enabled.root, fs.realpathSync(folder));
    assert.equal(loadRegistry({ stateRoot }).repositories[repositoryId].worktreeCleanup.root, fs.realpathSync(folder), "the confirmed folder is recorded");
    assert.equal((await inspectWorktreeHook({ cwd: main })).state, "installed");
    rows = await cleanupWorktrees({ ...options, apply: true });
    assert.equal(rows.find((row) => row.branch === "inside").action, "removed", rows.find((row) => row.branch === "inside").reason);
    assert.match(rows.find((row) => row.branch === "outside").reason, /not in worktree folder/);
    assert.equal(fs.existsSync(inside), false);
    assert.equal(fs.existsSync(outside), true, "a landed worktree outside the confirmed folder is kept");
    dismissWorktreeCleanupNotice({ repositoryId, stateRoot });
    assert.ok(loadRegistry({ stateRoot }).repositories[repositoryId].worktreeCleanup.noticeDismissedAt, "dismissal is recorded");
    assert.equal(loadRegistry({ stateRoot }).repositories[repositoryId].worktreeCleanup.root, fs.realpathSync(folder), "dismissal keeps the folder");
    fs.writeFileSync(path.join(main, ".git/hooks/post-merge"), "#!/bin/sh\n# another tool\n");
    assert.equal((await inspectWorktreeHook({ cwd: main })).state, "foreign");
  }
  {
    // The first inventory registers a worktree with nothing running; that must not count as
    // activity, so a worktree untouched for ten days reads stale at once. A running sighting does.
    const { main, worktree } = repository("first-inventory");
    const realMain = fs.realpathSync(main);
    const stateRoot = path.join(root, "first-inventory-state");
    const repositoryId = "git:example.com/test/first-inventory";
    recordRepositoryDiscovery({
      repositoryId, kind: "git", displayName: "first-inventory", source: "developer-runtime", evidence: "git-remote",
      confidence: "high", localRoot: rootId(realMain), localRootKind: "clone", localRootPath: realMain, stateRoot,
    });
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(path.join(worktree, "old.txt"), "old\n");
    git(worktree, "add", "old.txt");
    const dated = spawnSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "old"], {
      cwd: worktree, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: tenDaysAgo, GIT_COMMITTER_DATE: tenDaysAgo },
    });
    assert.equal(dated.status, 0, dated.stderr);
    const observe = async (runningRootIds = new Set()) => (await collectKnownWorktrees(loadRegistry({ stateRoot }), { stateRoot, settings: {}, runningRootIds }))
      .worktrees.get(repositoryId).find((item) => item.branch === "feature");
    assert.equal((await observe()).state, "stale", "registering a worktree is not activity");
    const worktreeRootId = rootId(fs.realpathSync(worktree));
    assert.equal((await observe(new Set([worktreeRootId]))).running, true);
    assert.ok(loadRegistry({ stateRoot }).repositories[repositoryId].localRoots.find((item) => item.rootId === worktreeRootId).lastRunningAt,
      "a running sighting is recorded");
    assert.equal((await observe()).state, "idle", "a recent running sighting counts as activity");
    git(main, "merge", "--squash", "feature"); git(main, "commit", "-qm", "land observed work");
    // These local attributes cannot be captured; a runtime survey should only inspect landing.
    fs.writeFileSync(path.join(worktree, ".gitattributes"), "* filter=unsupported\n");
    const landed = await observe();
    assert.equal(landed.landing.landed, true, "runtime landing inspection does not depend on local inventory support");
    assert.equal(landed.preservation, "unknown", "full preservation is assessed on demand");
  }
  {
    // A removed worktree leaves the registry on the next survey, so a repository with nothing
    // running stops listing it. One deleted by hand is still in Git's list (prunable) and stays.
    const { main, worktree } = repository("departed");
    const realMain = fs.realpathSync(main);
    const stateRoot = path.join(root, "departed-state");
    const repositoryId = "git:example.com/test/departed";
    recordRepositoryDiscovery({
      repositoryId, kind: "git", displayName: "departed", source: "developer-runtime", evidence: "git-remote",
      confidence: "high", localRoot: rootId(realMain), localRootKind: "clone", localRootPath: realMain, stateRoot,
    });
    const handDeleted = path.join(root, "departed-hand-deleted");
    git(main, "worktree", "add", "-q", "-b", "hand-deleted", handDeleted);
    const survey = async () => collectKnownWorktrees(loadRegistry({ stateRoot }), { stateRoot, settings: {} });
    await survey();
    const worktreeRoots = () => loadRegistry({ stateRoot }).repositories[repositoryId].localRoots.filter((item) => item.kind === "worktree");
    assert.equal(worktreeRoots().length, 2, "both worktrees are registered");
    git(main, "worktree", "remove", worktree);
    fs.rmSync(handDeleted, { recursive: true, force: true });
    const { worktrees } = await survey();
    assert.equal(worktrees.get(repositoryId).find((item) => item.branch === "hand-deleted")?.state, null,
      "a missing worktree has no activity state");
    const remaining = worktreeRoots().map((item) => loadRegistry({ stateRoot }).localRootPaths[item.rootId].path);
    assert.deepEqual(remaining, [path.join(fs.realpathSync(root), "departed-hand-deleted")], "a removed worktree is forgotten; a prunable one is kept");
    assert.ok(loadRegistry({ stateRoot }).repositories[repositoryId].localRoots.find((item) => item.rootId === rootId(realMain)),
      "the main checkout's record is untouched");
  }
  {
    // Home's Delete Worktree stops the worktree's servers, but only after every other guard passed.
    const { main, worktree } = repository("delete-stops");
    const realMain = fs.realpathSync(main);
    const stateRoot = path.join(root, "delete-stops-state");
    const repositoryId = "git:example.com/test/delete-stops";
    recordRepositoryDiscovery({
      repositoryId, kind: "git", displayName: "delete-stops", source: "developer-runtime", evidence: "git-remote",
      confidence: "high", localRoot: rootId(realMain), localRootKind: "clone", localRootPath: realMain, stateRoot,
    });
    commit(worktree, "work.txt", "work\n");
    const stops = [];
    const stop = (ok) => async (checkoutPath) => {
      stops.push(checkoutPath);
      return { ok, servers: ok ? [{ pid: 101, result: "stopped" }] : [{ pid: 102, result: "still-running" }], warnings: [] };
    };
    const discover = async () => ({ instances: [] });
    fs.writeFileSync(path.join(worktree, "stray.txt"), "stray\n");
    let result = await removeRepositoryWorktree({ repositoryId, branch: "feature", stateRoot, stop: stop(true), discover });
    assert.match(result.reason, /receipt required/);
    assert.deepEqual(stops, [], "a deletion without a receipt stops nothing");
    fs.rmSync(path.join(worktree, "stray.txt"));
    const preview = await previewRepositoryWorktree({ repositoryId, branch: "feature", stateRoot, discover });
    assert.equal(preview.eligible, true, preview.reason);
    result = await removeRepositoryWorktree({ repositoryId, branch: "feature", receipt: preview.receipt, stateRoot, stop: stop(false) });
    assert.match(result.reason, /did not stop/);
    assert.equal(fs.existsSync(worktree), true, "a server that keeps running keeps its worktree");
    assert.deepEqual(await stopRepositoryWorktreeServers({ repositoryId, branch: "feature", stateRoot, stop: stop(true) }), { action: "stopped", stopped: 1, reason: null });
    result = await removeRepositoryWorktree({ repositoryId, branch: "feature", receipt: preview.receipt, stateRoot, stop: stop(true) });
    assert.equal(result.action, "removed", result.reason);
    assert.equal(fs.existsSync(worktree), false);
    assert.equal(stops.length, 3);
  }
  {
    const { main, worktree } = repository("delete-dirty-confirmed");
    const realMain = fs.realpathSync(main);
    const stateRoot = path.join(root, "delete-dirty-confirmed-state");
    const repositoryId = "git:example.com/test/delete-dirty-confirmed";
    recordRepositoryDiscovery({ repositoryId, kind: "git", displayName: "delete-dirty-confirmed", source: "developer-runtime", evidence: "git-remote", confidence: "high", localRoot: rootId(realMain), localRootKind: "clone", localRootPath: realMain, stateRoot });
    commit(worktree, "work.txt", "committed work\n");
    const tip = git(worktree, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(worktree, "work.txt"), "uncommitted work\n");
    fs.writeFileSync(path.join(worktree, "stray.txt"), "untracked work\n");
    const options = { repositoryId, branch: "feature", stateRoot, stop: async () => ({ ok: true, servers: [], warnings: [] }), discover: async () => ({ instances: [] }) };
    const removeThroughRoute = (body) => new Promise((resolve) => {
      const req = Readable.from([JSON.stringify(body)]);
      req.method = "POST";
      const res = { writeHead(status) { assert.equal(status, 200); }, end(payload) { resolve(JSON.parse(payload)); } };
      const handlers = { removeRepositoryWorktree: (params) => removeRepositoryWorktree({ ...options, ...params }) };
      assert.equal(dispatchRoutes([repositoriesRoutes], req, res, `/api/repositories/${encodeURIComponent(repositoryId)}/worktrees/remove`, "", handlers), true);
    });
    const refused = await removeThroughRoute({ branch: "feature" });
    assert.equal(refused.action, "kept");
    assert.match(refused.reason, /receipt required/, "dirty deletion requires a loss preview receipt");
    assert.equal(fs.readFileSync(path.join(worktree, "work.txt"), "utf8"), "uncommitted work\n");
    for (const discardChanges of ["true", true]) {
      const invalidConsent = await removeThroughRoute({ branch: "feature", discardChanges });
      assert.equal(invalidConsent.action, "kept", "old boolean consent cannot authorize removal");
      assert.match(invalidConsent.reason, /receipt required/);
    }
    const preview = await previewRepositoryWorktree(options);
    assert.equal(preview.eligible, true, preview.reason);
    assert.equal(preview.target.path, undefined, "portal preview omits the private checkout path");
    assert.ok(preview.groups.tracked.some((entry) => entry.path === "work.txt"));
    assert.ok(preview.groups.untracked.some((entry) => entry.path === "stray.txt"));
    const removed = await removeThroughRoute({ branch: "feature", receipt: preview.receipt });
    assert.equal(removed.action, "removed", removed.reason);
    assert.equal(fs.existsSync(worktree), false);
    assert.equal(git(main, "for-each-ref", "--format=%(refname)", "refs/roborepo/abandoned", "refs/roborepo/worktree-archives"), "", "explicit deletion creates no recovery refs");
  }
  console.log("worktree lifecycle: inventory and landing ok");
} finally {
  restoreGitConfig();
  try { fs.rmSync(root, { recursive: true, force: true }); }
  catch (error) { console.error(`Fixture cleanup failed: ${error.message}`); process.exitCode = 1; }
}
