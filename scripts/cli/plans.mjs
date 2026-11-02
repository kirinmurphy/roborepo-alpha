// The Plans portal's snapshot API: cached plan snapshots, documents, prompts, and priority edits,
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
  updatePlanPriority as updatePlanPriorityInDocs,
} from "../../modules/plan-suite/index.mjs";
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
  return publicSnapshot(cachedSnapshot);
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

export function updatePlanPriority({ id, key, priority, expectedPriority, mtimeMs, repositoryId }) {
  // Writes resolve current evidence/worktree authority rather than a cached recovery selection.
  const snapshot = buildPlanSnapshot({ stateRoot, packageState: planSuitePackageState() });
  const result = updatePlanPriorityInDocs(snapshot, { id, key, priority, expectedPriority, mtimeMs, repositoryId });
  cachedSnapshot = null;
  return publicMutationResult(result);
}

export function refreshPlans({ repositoryId = null } = {}) {
  cachedSnapshot = null;
  cachedSnapshotIsMock = false;
  return loadPlansSnapshot({ repositoryId });
}

// The fingerprint is taken before the build, so a file that changes mid-build shows up as a
// mismatch on the next check rather than being masked.
function rebuildSnapshot(registry, fingerprint = planSnapshotFingerprint({ registry })) {
  cachedSnapshot = buildPlanSnapshot({ stateRoot, registry, packageState: planSuitePackageState() });
  cachedSnapshotIsMock = false;
  cachedFingerprint = fingerprint;
}

// Strips the same private fields (absolutePath, repository.root) from a mutation result's record
// that publicSnapshot() strips from every plan in a full snapshot — the domain layer's record
// shape always carries them internally, but they must never cross the HTTP boundary.
function publicMutationResult(result) {
  const { absolutePath, repository, ...plan } = result.record;
  return { change: result.change, record: { ...plan, repository: stripRepositoryRoot(repository) } };
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
