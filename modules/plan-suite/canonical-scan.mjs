// The Plans snapshot, built from the repositories RoboRepo knows about rather than from folders
// Plans owns. Each visible repository is read from its one plans worktree (plan-store.mjs); a known
// repository without one is reported as not set up, never as having zero plans.
import { checkoutRootsFor, loadRegistry } from "../repositories/index.mjs";
import { repositoryCheckouts } from "./checkouts.mjs";
import { buildBacklogIndex } from "./backlog-registry.mjs";
import { discoverPlansInRepository, publicPlan, publicRepository, repositoryRecord, withRelationshipFindings } from "./index.mjs";
import { LIFECYCLE_MODEL, lifecycleProjection } from "./lifecycle-manifest.mjs";
import { locateStore, pendingCommitCount } from "./plan-store.mjs";

export function buildPlanSnapshot({ stateRoot, packageState = null, registry = null } = {}) {
  const known = registry || loadRegistry({ stateRoot });
  const repositories = [];
  const repositoryScans = [];
  const plans = [];
  const backlog = [];
  const errors = [];
  for (const record of plannableRepositories(known)) {
    // A repository with no recorded checkout (known only from agent sessions, say) has nothing for
    // Plans to read; it gets no scan entry and Home reports it as not scanned.
    if (!checkoutRootsFor(known, record.id).length) continue;
    const checkouts = repositoryCheckouts(known, record.id);
    // No readable checkout is not "zero plans": the repository was not scanned at all.
    if (!checkouts.length) {
      repositoryScans.push({ repositoryId: record.id, state: "unavailable", planCount: 0, checkoutCount: 0 });
      continue;
    }
    // Linked worktree names straight from Git's administrative files, running or not, so Home can
    // tell a plan's idle worktree from one that no longer exists.
    const worktrees = checkouts.filter((checkout) => checkout.isWorktree).map((checkout) => checkout.label);
    const store = locateStore(checkouts[0].path);
    const identity = { repositoryId: record.id, name: record.displayName, urlKey: record.urlKey ?? null };
    if (!store || store.missing) {
      repositoryScans.push({ repositoryId: record.id, name: record.displayName, urlKey: identity.urlKey, state: "not-set-up", planCount: 0, checkoutCount: checkouts.length, worktrees });
      continue;
    }
    try {
      const repository = { ...repositoryRecord(store.root, identity), codeRoot: store.primary };
      const repositoryPlans = discoverPlansInRepository(repository);
      repositories.push(repository);
      plans.push(...repositoryPlans);
      backlog.push({ repositoryId: record.id, name: record.displayName, urlKey: identity.urlKey, ...buildBacklogIndex(store.root, repositoryPlans) });
      errors.push(...scanErrors(repositoryPlans, repository, record));
      repositoryScans.push({ repositoryId: record.id, state: "scanned", planCount: repositoryPlans.length, checkoutCount: checkouts.length, worktrees, pendingCommits: pendingCommitCount(store) ?? 0 });
    } catch (err) {
      errors.push({ repository: record.displayName, repositoryId: record.id, error: pathFreeError(err) });
      repositoryScans.push({ repositoryId: record.id, state: "error", planCount: 0, checkoutCount: checkouts.length });
    }
  }
  return {
    ok: true,
    repositories: repositories.map(publicRepository),
    repositoryScans,
    plans: withRelationshipFindings(plans).map(publicPlan),
    errors,
    // One entry per scanned repository: its namespaces and each one's effective order (backlog-registry.mjs).
    backlog,
    truncated: plans.some((plan) => plan.repository.truncated),
    planSuitePackage: packageState || { available: false, enabled: false, status: "missing" },
    // The portal reads states, tabs, and actions from here rather than keeping its own copy.
    lifecycle: lifecycleProjection(LIFECYCLE_MODEL),
  };
}

// Visible canonical records only: an alias points at another record that is scanned in its place,
// and a hidden (ignored) repository is left out of normal Plans entries.
export function plannableRepositories(registry) {
  return Object.values(registry.repositories || {})
    .filter((record) => record.visibility !== "hidden" && !registry.aliases?.[record.id])
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

// Store-relative paths only: /api/plans never carries an absolute path.
function scanErrors(plans, repository, record) {
  const walk = plans[0]?.repository?.errors ?? repository.errors ?? [];
  return walk.map((error) => ({ repository: record.displayName, repositoryId: record.id, path: error.path, error: "could not be read" }));
}

// Filesystem and Git error messages embed absolute paths, so only the error code crosses over.
function pathFreeError(err) {
  return err?.code ? `scan failed (${err.code})` : "scan failed";
}
