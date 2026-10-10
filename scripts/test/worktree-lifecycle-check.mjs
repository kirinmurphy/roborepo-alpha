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
import { removalLogPath, withCleanupLock } from "../../modules/repositories/worktree-removal.mjs";
import { checkWorktreeRemoval } from "../../modules/repositories/worktree-guards.mjs";
import { manageWorktreeHook } from "../cli/worktree-hook.mjs";

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
    assert.equal(deriveWorktreeState({ activityAt: [twoDaysAgo], hiddenAt: "2026-10-09T00:00:00Z", now }).hidden, true);
    assert.equal(deriveWorktreeState({ activityAt: ["2026-10-10T01:00:00Z"], hiddenAt: "2026-10-09T00:00:00Z", now }).hidden, false);
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
    assert.match((await checkWorktreeRemoval({ ...base, worktreeRoot: main })).reason, /outside worktree root/);
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
  console.log("worktree lifecycle: inventory and landing ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
