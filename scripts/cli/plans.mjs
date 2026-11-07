// The Plans portal's snapshot API: cached plan snapshots, documents, prompts, and Backlog order saves,
// with private fields stripped before they cross the HTTP boundary. `roborepo plans` lives in
// plans-command.mjs.
import { packageStatusSummary } from "./package-status.mjs";
import { stateRoot } from "./paths.mjs";
import { autoDiscoveryEnabled } from "./repository-sources.mjs";
import {
  buildPlanSnapshot,
  buildPrompt,
  findPlanByKey,
  planSnapshotFingerprint,
  readPlanDocument,
  domainError,
} from "../../modules/plan-suite/index.mjs";
import { saveNamespaceOrder, setNamespacePinned } from "../../modules/plan-suite/backlog-registry.mjs";
import { plannableRepositories } from "../../modules/plan-suite/canonical-scan.mjs";
import { repositoryCheckouts } from "../../modules/plan-suite/checkouts.mjs";
import { pathFreeFileError } from "../../modules/plan-suite/naming.mjs";
import { locateStore, refreshStore } from "../../modules/plan-suite/plan-store.mjs";
import { repositoryBaseBranch } from "../../modules/plan-suite/plan-git.mjs";
import { transitionPlan } from "../../modules/plan-suite/transition.mjs";
import { loadRegistry } from "../../modules/repositories/index.mjs";
import { MOCK_FIRST_RUN_VIEWS_ENABLED, mockPlanDocument, mockPlansSnapshot } from "./mock-home.mjs";

let cachedSnapshot = null;
let cachedSnapshotIsMock = false;
// planSnapshotFingerprint() as of the last real build; null whenever cachedSnapshot is not one.
let cachedFingerprint = null;

// `repositoryId` (the resolved Portal scope) filters the one cached snapshot per request; there is
// no per-repository cache, so Home's loadCachedPlansSnapshot always sees the same build.
export function loadPlansSnapshot({ repositoryId = null } = {}) {
  if (MOCK_FIRST_RUN_VIEWS_ENABLED && hasNoRegisteredRepositories()) {
    cachedSnapshot = mockPlansSnapshot({ packageState: planSuitePackageState() });
    cachedSnapshotIsMock = true;
    cachedFingerprint = null;
    return scopeSnapshot(cachedSnapshot, repositoryId);
  }
  rebuildSnapshot(loadRegistry({ stateRoot }));
  return scopeSnapshot(publicSnapshot(cachedSnapshot), repositoryId);
}

// One repository's slice of a public snapshot: its plans, its scan state (the header count and
// onboarding read it), and its scan errors. A repository with no recorded checkout has no scan
// entry; scoped to it, that is "not scanned", not "no repositories known".
export function scopeSnapshot(snapshot, repositoryId) {
  if (!repositoryId) return snapshot;
  const inScope = (id) => id === repositoryId;
  const scans = (snapshot.repositoryScans || []).filter((scan) => inScope(scan.repositoryId));
  return {
    ...snapshot,
    plans: snapshot.plans.filter((plan) => inScope(plan.repository?.repositoryId)),
    repositories: snapshot.repositories.filter((repository) => inScope(repository.repositoryId)),
    repositoryScans: scans.length ? scans : [{ repositoryId, state: "unavailable", planCount: 0, checkoutCount: 0 }],
    errors: (snapshot.errors || []).filter((error) => inScope(error.repositoryId)),
    backlog: (snapshot.backlog || []).filter((entry) => inScope(entry.repositoryId)),
    // A scoped page still needs every repo its breadcrumb can jump to.
    backlogRepositories: (snapshot.backlog || [])
      .filter((entry) => entry.urlKey && (entry.namespaces.length || entry.noNamespace.length))
      .map(({ urlKey, name }) => ({ urlKey, name })),
  };
}

// Home polls this every few seconds. A full build runs Git subprocesses per checkout, so it is
// rebuilt only when the stat-only fingerprint says plan files or checkouts changed (or nothing is
// cached yet). Without that check, Home kept whatever the Plans page last loaded.
export function loadCachedPlansSnapshot() {
  if (MOCK_FIRST_RUN_VIEWS_ENABLED && hasNoRegisteredRepositories()) return mockPlansSnapshot({ packageState: planSuitePackageState() });
  const registry = loadRegistry({ stateRoot });
  const fingerprint = planSnapshotFingerprint({ registry });
  if (!cachedSnapshot || cachedSnapshotIsMock || fingerprint !== cachedFingerprint) rebuildSnapshot(registry, fingerprint);
  // Home offers each plan's file path to copy, as it already does each checkout's. /api/plans does not.
  const paths = new Map(cachedSnapshot.plans.map((record) => [record.key, record.absolutePath]));
  const snapshot = publicSnapshot(cachedSnapshot);
  return { ...snapshot, plans: snapshot.plans.map((record) => ({ ...record, absolutePath: paths.get(record.key) })) };
}

export function loadPlanDocument({ key }) {
  if (MOCK_FIRST_RUN_VIEWS_ENABLED && hasNoRegisteredRepositories()) return mockPlanDocument({ key });
  const snapshot = cachedSnapshot || buildPlanSnapshot({ stateRoot, packageState: planSuitePackageState() });
  return readPlanDocument(snapshot, key);
}

export function buildPlansPrompt({ action, keys, mode }) {
  if (MOCK_FIRST_RUN_VIEWS_ENABLED && hasNoRegisteredRepositories()) {
    const snapshot = mockPlansSnapshot({ packageState: planSuitePackageState() });
    const selected = (Array.isArray(keys) ? keys : []).map((key) => snapshot.plans.find((plan) => plan.key === key));
    if (selected.length === 0 || selected.some((plan) => !plan)) throw new Error("select at least one plan");
    return { prompt: buildPrompt(action, selected, { mode }) };
  }
  const snapshot = cachedSnapshot || buildPlanSnapshot({ stateRoot, packageState: planSuitePackageState() });
  const selected = (Array.isArray(keys) ? keys : []).map((key) => findPlanByKey(snapshot, key));
  if (selected.length === 0) throw new Error("select at least one plan");
  return { prompt: buildPrompt(action, selected, { mode }) };
}

// A Backlog Save: one namespace's whole order, against the revision the draft was opened from.
export async function saveBacklogOrder({ repositoryId, namespace, order, unprioritized, revision }) {
  const snapshot = buildPlanSnapshot({ stateRoot, packageState: planSuitePackageState() });
  const repository = snapshot.repositories.find((item) => item.repositoryId === repositoryId);
  if (!repository) throw domainError("PLAN_NOT_FOUND", "This repo can no longer be found. Refresh and try again.");
  try {
    return await saveNamespaceOrder({ store: locateStore(repository.root), namespace, order, unprioritized, revision });
  } finally {
    cachedSnapshot = null;
  }
}

// Lifts one namespace to the top of its repo's Backlog, or returns it to alphabetical order.
export async function setBacklogNamespacePinned({ repositoryId, namespace, pinned }) {
  const snapshot = buildPlanSnapshot({ stateRoot, packageState: planSuitePackageState() });
  const repository = snapshot.repositories.find((item) => item.repositoryId === repositoryId);
  if (!repository) throw domainError("PLAN_NOT_FOUND", "This repo can no longer be found. Refresh and try again.");
  try {
    return await setNamespacePinned({ store: locateStore(repository.root), namespace, pinned });
  } finally {
    cachedSnapshot = null;
  }
}

// Retires one unprioritized Backlog plan through the same transition `roborepo plans archive` runs: a
// commit on the plans branch, pushed. A ranked plan is refused, so a page working from an older
// snapshot cannot archive what has since been prioritized.
export async function archiveBacklogPlan({ repositoryId, id, reason }) {
  if (typeof id !== "string" || !id) throw domainError("INVALID_CHANGE", "id must name the plan to archive.");
  const snapshot = buildPlanSnapshot({ stateRoot, packageState: planSuitePackageState() });
  const repository = snapshot.repositories.find((item) => item.repositoryId === repositoryId);
  const entry = snapshot.backlog.find((item) => item.repositoryId === repositoryId);
  if (!repository || !entry) throw domainError("PLAN_NOT_FOUND", "This repo can no longer be found. Refresh and try again.");
  const unprioritized = new Set(entry.namespaces.flatMap((view) => view.needsPrioritization.flatMap((block) => block.ids)));
  if (!unprioritized.has(id)) throw domainError("INVALID_CHANGE", `Only unprioritized Backlog plans can be archived here: ${id}.`);
  try {
    const result = await transitionPlan({ cwd: repository.root, transition: "archive", selector: id, reason, base: repositoryBaseBranch(repository.root) || "main" });
    if (result.verdict !== "APPROVED") throw domainError("INVALID_CHANGE", `${id} moved, but its post-commit checks failed.`);
    return { archived: id, references: result.references, synchronized: result.synchronized };
  } catch (err) {
    throw browserSafeArchiveError(err);
  } finally {
    cachedSnapshot = null;
  }
}

// Git's stderr and filesystem messages embed absolute paths, and this answer reaches the browser. The
// `roborepo plans archive` command keeps them, since its reader is at the machine they name.
function browserSafeArchiveError(err) {
  if (err?.code !== "MOVE_FAILED" && err?.code !== "PLAN_STORE_FAILED" && !err?.syscall) {
    // A transition's refusals advise the agent running the command, which the dialog's reader is not.
    delete err.resolution;
    return err;
  }
  const detail = err.syscall ? pathFreeFileError(err) : err.message;
  return domainError("MOVE_FAILED", `This plan could not be archived: ${detail}`, {
    resolution: "Run `git status` in the repo, resolve what it shows, then try again.",
  });
}

// Fetches each store and pushes pending commits, so remote changes and sandboxed saves arrive here,
// not on every render. Awaits network Git without blocking the server's event loop. A remote that
// cannot be reached leaves the local plans showing; a pending commit that needs a person is reported
// for its repo.
export async function refreshPlans({ repositoryId = null } = {}) {
  const registry = loadRegistry({ stateRoot });
  const sync = {};
  for (const record of plannableRepositories(registry)) {
    if (repositoryId && record.id !== repositoryId) continue;
    const [checkout] = repositoryCheckouts(registry, record.id);
    const store = checkout ? locateStore(checkout.path) : null;
    if (!store || store.missing) continue;
    try {
      const { synchronized, reason } = await refreshStore(store);
      sync[record.id] = { synchronized, reason };
    } catch (err) {
      if (!err?.code) throw err;
      sync[record.id] = { synchronized: false, reason: err.message };
    }
  }
  cachedSnapshot = null;
  cachedSnapshotIsMock = false;
  return { ...loadPlansSnapshot({ repositoryId }), sync };
}

// The fingerprint is taken before the build, so a file that changes mid-build shows up as a
// mismatch on the next check rather than being masked.
function rebuildSnapshot(registry, fingerprint = planSnapshotFingerprint({ registry })) {
  cachedSnapshot = buildPlanSnapshot({ stateRoot, registry, packageState: planSuitePackageState() });
  cachedSnapshotIsMock = false;
  cachedFingerprint = fingerprint;
}

function planSuitePackageState() {
  return { ...packageStatusSummary("plan-suite"), message: "" };
}

function hasNoRegisteredRepositories() {
  return Object.keys(loadRegistry({ stateRoot }).repositories || {}).length === 0;
}

// `autoDiscovery` lets the Plans page show the same repository empty state Home does.
function publicSnapshot(snapshot) {
  return {
    ...snapshot,
    autoDiscovery: { enabled: autoDiscoveryEnabled({ stateRoot }) },
    plans: snapshot.plans.map(({ absolutePath, repository, ...plan }) => ({
      ...plan,
      repository: stripRepositoryRoot(repository),
    })),
    repositories: snapshot.repositories.map(({ root, ...repo }) => repo),
  };
}

function stripRepositoryRoot(repository) {
  const { root, ...publicRepository } = repository || {};
  return publicRepository;
}
