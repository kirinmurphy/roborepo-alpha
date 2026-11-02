import fs from "node:fs";
import { rootId as computeRootId } from "../../modules/repositories/identity.mjs";
import { checkoutRootsFor, forgetWorktreeRoot, markLocalRootRunning, registerLocalRoot, registerLocalRootPath, updateRegistry } from "../../modules/repositories/registry.mjs";
import { repositoryWorktrees } from "../../modules/repositories/worktree-inventory.mjs";
import { inspectBranchLanding } from "../../modules/repositories/worktree-landed.mjs";
import { deriveWorktreeState, resolveWorktreeStaleDays } from "../../modules/repositories/worktree-state.mjs";
import { runGitProcess } from "../../modules/repositories/git-exec.mjs";
import { checkWorktreeRemoval } from "../../modules/repositories/worktree-guards.mjs";
import { activeWorktreeNames, configuredRoot, proposedWorktreeFolder, worktreeFolder } from "./worktree-policy.mjs";
import { inspectWorktreeHook } from "./worktree-hook.mjs";

// One survey feeds Runtime and the cleanup command. Only live admin entries are registered; a
// prunable entry is shown as a finding but never turned into a new checkout record. A registered
// worktree that Git no longer lists and whose folder is gone was removed, so its record is dropped;
// otherwise a repository with nothing running would keep listing it on Home.
export async function collectKnownWorktrees(registry, { stateRoot, settings, now = new Date(), readGit = async () => null, runningRootIds = new Set(), sessionActivity = new Map() } = {}) {
  const raw = new Map();
  const departed = [];
  for (const repositoryId of Object.keys(registry?.repositories || {})) {
    const { worktrees, commonDirs } = repositoryWorktrees(registry, repositoryId);
    raw.set(repositoryId, worktrees);
    // Without a readable Git directory the inventory proves nothing about which worktrees exist.
    if (!commonDirs.length) continue;
    const listed = new Set(worktrees.map((worktree) => computeRootId(worktree.path)));
    for (const root of checkoutRootsFor(registry, repositoryId)) {
      if (root.kind === "worktree" && !listed.has(root.rootId) && !fs.existsSync(root.path)) departed.push({ repositoryId, rootId: root.rootId });
    }
  }
  const live = [...raw].flatMap(([repositoryId, worktrees]) => worktrees
    .filter((worktree) => !worktree.prunable)
    .map((worktree) => ({ repositoryId, worktree, rootId: computeRootId(worktree.path) })));
  if ((live.length || departed.length) && stateRoot) {
    registry = updateRegistry({ stateRoot, mutate: (next) => {
      let changed = false;
      for (const { repositoryId, worktree, rootId } of live) {
        if (registerLocalRoot(next, repositoryId, { rootId, kind: "worktree", now: now.toISOString(), refreshSeen: false })) changed = true;
        if (registerLocalRootPath(next, repositoryId, { rootId, path: worktree.path, now: now.toISOString() })) changed = true;
        if (runningRootIds.has(rootId) && markLocalRootRunning(next, repositoryId, rootId, { now: now.toISOString() })) changed = true;
      }
      for (const { repositoryId, rootId } of departed) {
        if (next.repositories?.[repositoryId] && forgetWorktreeRoot(next, repositoryId, rootId, { now: now.toISOString() })) changed = true;
      }
      return changed;
    } });
  }
  const threshold = resolveWorktreeStaleDays({ preference: settings?.preferences?.worktreeStaleDays, environment: process.env.ROBOREPO_WORKTREE_STALE_DAYS });
  const policy = new Map();
  for (const { repositoryId, worktree } of live) {
    if (!policy.has(worktree.mainPath)) policy.set(worktree.mainPath, {
      root: worktreeFolder(worktree.mainPath, registry.repositories?.[repositoryId]), activePlans: activeWorktreeNames(worktree.mainPath),
    });
  }
  const byRepository = new Map();
  for (const [repositoryId, worktrees] of raw) {
    const observations = await Promise.all(worktrees.map(async (worktree) => {
      const rootId = computeRootId(worktree.path);
      const root = registry.repositories?.[repositoryId]?.localRoots?.find((item) => item.rootId === rootId);
      if (worktree.prunable) return { ...worktree, rootId, projectRoot: worktree.path, git: null, state: "stale", reason: "prunable worktree" };
      const [git, landing, lastCommit] = await Promise.all([
        readGit(worktree.path, repositoryId),
        worktree.branch ? inspectBranchLanding(worktree.path, worktree.branch) : Promise.resolve({ landed: false }),
        worktree.branch ? runGitProcess(worktree.path, ["log", "-1", "--format=%cI", worktree.branch]) : Promise.resolve({ ok: false }),
      ]);
      const activityAt = [root?.lastRunningAt, lastCommit.ok ? lastCommit.stdout.trim() : null, sessionActivity.get(`${repositoryId}\0${worktree.branch}`)].filter(Boolean);
      const state = deriveWorktreeState({ running: runningRootIds.has(rootId), landed: landing.landed, activityAt, staleDays: threshold.days, now });
      const guard = landing.landed ? await checkWorktreeRemoval({
        worktree, kind: "automatic", landed: true, worktreeRoot: policy.get(worktree.mainPath)?.root,
        mainPath: worktree.mainPath, currentPath: null,
        activePlan: policy.get(worktree.mainPath)?.activePlans.has(worktree.name), running: runningRootIds.has(rootId),
      }) : null;
      const count = worktree.branch && landing.base
        ? await runGitProcess(worktree.path, ["rev-list", "--count", `${landing.base}..${worktree.branch}`])
        : { ok: false };
      return {
        ...worktree, rootId, projectRoot: worktree.path, git, ...state, landing, preservation: "unknown", remainingPaths: [], blockingPaths: [], running: runningRootIds.has(rootId),
        mergedInto: landing.landed ? shortBranchName(landing.base) : null,
        unmergedCommits: count.ok ? Number(count.stdout.trim()) : null, reason: guard?.reason || null,
      };
    }));
    byRepository.set(repositoryId, observations);
  }
  const cleanup = new Map();
  for (const [repositoryId, worktrees] of raw) {
    const mainPath = worktrees.find((worktree) => !worktree.prunable)?.mainPath;
    if (mainPath) cleanup.set(repositoryId, await cleanupStatus(mainPath, worktrees, registry.repositories?.[repositoryId]));
  }
  return { registry, worktrees: byRepository, cleanup, findings: threshold.finding ? [threshold.finding] : [] };
}

// `refs/remotes/origin/main` and `refs/heads/main` both read as "main".
function shortBranchName(ref) {
  return ref ? ref.replace(/^refs\/(remotes\/[^/]+|heads)\//, "") : null;
}

// What Home needs to offer opt-in cleanup for one repository: whether the hook is in place, the
// folder automatic removal would act in (and where that came from), a proposal when there is none,
// and whether the user dismissed the offer.
async function cleanupStatus(mainPath, worktrees, record) {
  let hook;
  try { hook = await inspectWorktreeHook({ cwd: mainPath }); } catch { hook = { state: "unknown", reason: null }; }
  const configured = configuredRoot(mainPath);
  const folder = worktreeFolder(mainPath, record);
  return {
    hook: hook.state,
    hookReason: hook.reason || null,
    folder,
    folderSource: configured ? "plans-config" : folder ? "recorded" : null,
    proposedFolder: folder ? null : proposedWorktreeFolder(worktrees),
    dismissed: Boolean(record?.worktreeCleanup?.noticeDismissedAt),
  };
}
