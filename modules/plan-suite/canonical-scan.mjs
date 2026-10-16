// The Plans snapshot, built from the repositories RoboRepo knows about rather than from folders
// Plans owns (pljvmyh §9). Every visible repository with a readable checkout is scanned across all
// of its checkouts; copies of one plan are merged by plan `id`, and the one authoritative copy is
// returned (plan-authority.mjs).
import { checkoutRootsFor, loadRegistry } from "../repositories/index.mjs";
import { repositoryCheckouts } from "./checkouts.mjs";
import { scanCheckout, selectRecords } from "./plan-copies.mjs";
import { publicPlan, publicRepository, withRelationshipFindings } from "./index.mjs";
import { LIFECYCLE_MODEL, lifecycleProjection } from "./lifecycle-manifest.mjs";

export function buildPlanSnapshot({ stateRoot, packageState = null, registry = null } = {}) {
  const known = registry || loadRegistry({ stateRoot });
  const repositories = [];
  const repositoryScans = [];
  const plans = [];
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
    try {
      const scan = scanRepository(checkouts, { repositoryId: record.id, name: record.displayName });
      repositories.push(scan.repository);
      plans.push(...scan.plans);
      errors.push(...scan.errors.map((error) => ({ repository: record.displayName, repositoryId: record.id, ...error })));
      // Linked worktree names straight from Git's administrative files, running or not, so Home can
      // tell a plan's idle worktree from one that no longer exists.
      const worktrees = checkouts.filter((checkout) => checkout.isWorktree).map((checkout) => checkout.label);
      repositoryScans.push({ repositoryId: record.id, state: "scanned", planCount: scan.plans.length, checkoutCount: checkouts.length, worktrees });
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
    truncated: plans.some((plan) => plan.repository.truncated),
    planWritePackage: packageState || { available: false, enabled: false, status: "missing" },
    // The portal reads states, tabs, and actions from here rather than keeping its own copy.
    lifecycle: lifecycleProjection(LIFECYCLE_MODEL),
  };
}

// Visible canonical records only: an alias points at another record that is scanned in its place,
// and a hidden (ignored) repository is left out of normal Plans entries (§8).
export function plannableRepositories(registry) {
  return Object.values(registry.repositories || {})
    .filter((record) => record.visibility !== "hidden" && !registry.aliases?.[record.id])
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function scanRepository(checkouts, canonical) {
  const scanned = checkouts.map((checkout) => scanCheckout(checkout, canonical));
  // Repository-relative paths only: /api/plans never carries an absolute path (§6).
  const errors = scanned.flatMap(({ checkout, scoped }) => scoped.errors.map((error) => ({ checkout: checkout.label, path: error.path, error: "could not be read" })));
  return { repository: scanned[0].scoped, plans: selectRecords(scanned), errors };
}

// Filesystem and Git error messages embed absolute paths, so only the error code crosses over.
function pathFreeError(err) {
  return err?.code ? `scan failed (${err.code})` : "scan failed";
}
