import { rootId as computeRootId } from "../../modules/repositories/identity.mjs";
import { registerLocalRoot, registerLocalRootPath, updateRegistry } from "../../modules/repositories/registry.mjs";
import { repositoryWorktrees } from "../../modules/repositories/worktree-inventory.mjs";
import { inspectBranchLanding } from "../../modules/repositories/worktree-landed.mjs";
import { deriveWorktreeState, resolveWorktreeStaleDays } from "../../modules/repositories/worktree-state.mjs";
import { runGitProcess } from "../../modules/repositories/git-exec.mjs";
import { checkWorktreeRemoval } from "../../modules/repositories/worktree-guards.mjs";
import { activeWorktreeNames, configuredRoot, proposedWorktreeFolder, worktreeFolder } from "./worktree-policy.mjs";
import { inspectWorktreeHook } from "./worktree-hook.mjs";

// One survey feeds Runtime and the cleanup command. Only live admin entries are registered; a
// prunable entry is shown as a finding but never turned into a new checkout record.
export async function collectKnownWorktrees(registry, { stateRoot, settings, now = new Date(), readGit = async () => null, runningRootIds = new Set(), sessionActivity = new Map() } = {}) {
  const raw = new Map();
  for (const repositoryId of Object.keys(registry?.repositories || {})) {
    const { worktrees } = repositoryWorktrees(registry, repositoryId);
    raw.set(repositoryId, worktrees);
  }
  const live = [...raw].flatMap(([repositoryId, worktrees]) => worktrees
    .filter((worktree) => !worktree.prunable)
    .map((worktree) => ({ repositoryId, worktree, rootId: computeRootId(worktree.path) })));
  if (live.length && stateRoot) {
    registry = updateRegistry({ stateRoot, mutate: (next) => {
      let changed = false;
      for (const { repositoryId, worktree, rootId } of live) {
        if (registerLocalRoot(next, repositoryId, { rootId, kind: "worktree", now: now.toISOString(), refreshSeen: false })) changed = true;
        if (registerLocalRootPath(next, repositoryId, { rootId, path: worktree.path, now: now.toISOString() })) changed = true;
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
      const activityAt = [root?.lastSeenAt, lastCommit.ok ? lastCommit.stdout.trim() : null, sessionActivity.get(`${repositoryId}\0${worktree.branch}`)].filter(Boolean);
      const state = deriveWorktreeState({ running: runningRootIds.has(rootId), landed: landing.landed, activityAt, staleDays: threshold.days, now });
      const guard = landing.landed ? await checkWorktreeRemoval({
        worktree, kind: "automatic", landed: true, worktreeRoot: policy.get(worktree.mainPath)?.root,
        mainPath: worktree.mainPath, currentPath: null,
        activePlan: policy.get(worktree.mainPath)?.activePlans.has(worktree.name), running: runningRootIds.has(rootId),
      }) : null;
      const count = worktree.branch && landing.base
        ? await runGitProcess(worktree.path, ["rev-list", "--count", `${landing.base}..${worktree.branch}`])
        : { ok: false };
      return { ...worktree, rootId, projectRoot: worktree.path, git, ...state, landing, unmergedCommits: count.ok ? Number(count.stdout.trim()) : null, reason: guard?.reason || null };
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
