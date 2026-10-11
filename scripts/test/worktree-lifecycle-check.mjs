#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { inspectBranchLanding } from "../../modules/repositories/worktree-landed.mjs";
import { linkedWorktrees } from "../../modules/repositories/worktree-inventory.mjs";
import { deriveWorktreeState, resolveWorktreeStaleDays } from "../../modules/repositories/worktree-state.mjs";
import { cleanupWorktrees } from "../cli/worktree-cleanup.mjs";
import { activeWorktreeNames, proposedWorktreeFolder } from "../cli/worktree-policy.mjs";
import { dismissWorktreeCleanupNotice, enableWorktreeCleanup } from "../cli/worktree-cleanup-optin.mjs";
import { recordRepositoryDiscovery } from "../cli/repositories.mjs";
import { loadRegistry } from "../../modules/repositories/registry.mjs";
import { rootId } from "../../modules/repositories/identity.mjs";
import { removalLogPath, withCleanupLock } from "../../modules/repositories/worktree-removal.mjs";
import { checkWorktreeRemoval } from "../../modules/repositories/worktree-guards.mjs";
import { inspectWorktreeHook, manageWorktreeHook } from "../cli/worktree-hook.mjs";
import { collectKnownWorktrees } from "../cli/worktree-observations.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-worktree-lifecycle-"));

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
    commit(worktree, "feature.txt", "feature\n");
    fs.mkdirSync(path.join(worktree, "docs/plans/active"), { recursive: true });
    commit(worktree, "docs/plans/active/story.md", "---\nid: story\n---\n");
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
    fs.mkdirSync(path.join(main, "docs/plans/completed"), { recursive: true });
    git(main, "mv", "docs/plans/active/story.md", "docs/plans/completed/story.md");
    git(main, "commit", "-qm", "close story");
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
    fs.mkdirSync(path.join(main, "docs/plans/active"), { recursive: true });
    fs.writeFileSync(path.join(main, "docs/plans/plans-config.json"), JSON.stringify({ worktreeRoot: root }));
    fs.writeFileSync(path.join(main, "docs/plans/active/story.md"), "---\nid: story1\nworktree: cleanup-work\n---\n");
    commit(worktree, "feature.txt", "feature\n");
    git(main, "merge", "--squash", "feature");
    git(main, "commit", "-qm", "landed feature");
    const options = { cwd: main, stateRoot, discover: async () => ({ instances: [] }) };
    await assert.rejects(cleanupWorktrees({ ...options, apply: true, discover: async () => { throw new Error("discovery failed"); } }), /discovery failed/);
    let rows = await cleanupWorktrees(options);
    assert.equal(rows.find((row) => row.branch === "feature").reason, "plan not closed");
    fs.mkdirSync(path.join(main, "docs/plans/completed"), { recursive: true });
    fs.renameSync(path.join(main, "docs/plans/active/story.md"), path.join(main, "docs/plans/completed/story.md"));
    rows = await cleanupWorktrees({ ...options, plan: "story1", apply: true });
    assert.equal(rows[0].action, "removed", rows[0].reason);
    assert.equal(fs.existsSync(worktree), false);
    assert.equal(git(main, "branch", "--list", "feature"), "");
    const log = fs.readFileSync(removalLogPath(stateRoot), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(log.length, 1);
    assert.equal(log[0].branch, "feature");
    const locked = await withCleanupLock(stateRoot, async () => withCleanupLock(stateRoot, async () => "wrong"));
    assert.equal(locked.result.locked, true, "a second cleanup cannot enter the lock");
  }
  {
    const { main, worktree } = repository("confirmed");
    const stateRoot = path.join(root, "confirmed-state");
    const tip = git(worktree, "rev-parse", "HEAD");
    commit(worktree, "feature.txt", "unmerged\n");
    const branchTip = git(worktree, "rev-parse", "HEAD");
    let rows = await cleanupWorktrees({ cwd: main, stateRoot, remove: "feature", confirm: true, apply: true, discover: async () => ({ instances: [] }) });
    assert.equal(rows[0].action, "removed", rows[0].reason);
    assert.equal(git(main, "rev-parse", "refs/roborepo/abandoned/feature"), branchTip);
    git(main, "branch", "feature", "refs/roborepo/abandoned/feature");
    assert.equal(git(main, "rev-parse", "feature"), branchTip, "archive ref restores the original tip");
    assert.notEqual(tip, branchTip);
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
    assert.match((await checkWorktreeRemoval({ ...base, worktreeRoot: main })).reason, /not in your worktree folder/);
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
    fs.mkdirSync(path.join(main, "docs/plans/active"), { recursive: true });
    fs.writeFileSync(path.join(main, "docs/plans/plans-config.json"), JSON.stringify({ worktreeRoot: root }));
    fs.writeFileSync(path.join(main, "docs/plans/active/story.md"), "---\nid: hookstory\nworktree: hook-pull-feature\n---\n");
    git(main, "add", "docs/plans");
    git(main, "commit", "-qm", "plan");
    git(main, "remote", "add", "origin", remote);
    git(main, "push", "-q", "-u", "origin", "main");
    const receiver = path.join(root, "hook-pull-receiver");
    const sender = path.join(root, "hook-pull-sender");
    git(root, "clone", "-q", "-b", "main", remote, receiver);
    git(root, "clone", "-q", "-b", "main", remote, sender);
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
    fs.mkdirSync(path.join(receiver, "docs/plans/completed"), { recursive: true });
    git(receiver, "mv", "docs/plans/active/story.md", "docs/plans/completed/story.md");
    git(receiver, "commit", "-qm", "close plan");
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
    fs.mkdirSync(path.join(main, "docs/plans"), { recursive: true });
    fs.writeFileSync(path.join(main, "docs/plans/plans-config.json"), JSON.stringify({ worktreeRoot: root }));
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
    fs.mkdirSync(path.join(main, "docs/plans"), { recursive: true });
    fs.writeFileSync(path.join(main, "docs/plans/plans-config.json"), JSON.stringify({ worktreeRoot: root }));
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
    fs.mkdirSync(path.join(main, "docs/plans/active"), { recursive: true });
    fs.writeFileSync(path.join(main, "docs/plans/active/story.md"), "---\nid: quoted\nworktree: \"quoted-plan-work\"\n---\n");
    assert.equal(activeWorktreeNames(main).has("quoted-plan-work"), true, "a quoted worktree field still protects its worktree");
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
    assert.match(rows.find((row) => row.branch === "inside").reason, /not in your worktree folder/, "with no folder, landed work is only suggested");
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
    assert.match(rows.find((row) => row.branch === "outside").reason, /not in your worktree folder/);
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
  }
  console.log("worktree lifecycle: inventory and landing ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
