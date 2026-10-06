import { appRoot, STATE_ROOT as stateRoot } from "./paths.mjs";
import { collectGitContext } from "../../modules/developer-runtime/git.mjs";
import {
  appendHistoryEvents,
  buildDeveloperRuntimeSnapshot,
  capabilityForPlatform,
  defaultSettings,
  diffSnapshots,
  discoverInstances,
  discoverMetadataSuggestions,
  findCurrentInstanceByOpaqueKey,
  healthIndexFromSnapshot,
  loadSettings,
  readHistoryEvents,
  sortRepositoriesForDisplay,
  updateSettings,
} from "../../modules/developer-runtime/index.mjs";
import { recordRepositoryDiscovery } from "./repositories.mjs";
import { autoDiscoveryEnabled } from "./repository-sources.mjs";
import { resolveProjectIdentity } from "../../modules/developer-runtime/identity.mjs";
import { canonicalRepositoryId, rootId as computeRootId } from "../../modules/repositories/identity.mjs";
import {
  loadRegistry,
  checkoutRootsFor,
  deriveLifecycle,
  lastSeenAtFor,
  mainCheckoutPath,
  resolveGitDir,
  supersededBy,
  ageOutCandidates,
  forgetRepository,
  hideRepository,
  pinRepository,
  updateRegistry,
  resolveRegistryAlias,
  renamedInto,
  setAlias,
} from "../../modules/repositories/index.mjs";
import { createIdleGitCache } from "../../modules/repositories/idle-git-cache.mjs";

const FRESHNESS_MS = 8000;
const HISTORY_API_LIMIT = 200;

let lastSnapshot = null;
let inFlightRefresh = null;
let refreshGeneration = 0;
let portalInfo = null;
// associationKeys already present in the history file, read once. Without it, the first refresh
// after a portal restart has no previous snapshot to compare against and would emit a firstSeen for
// every running app — every restart, forever.
let knownHistoryKeys = null;

// While auto-discovery is off the refresh still runs, but only over checkouts the registry already
// knows (folder sources): no process or container is observed and nothing new is registered.
export function loadDeveloperRuntimeSnapshot() {
  const now = new Date();
  if (!lastSnapshot) {
    lastSnapshot = buildSnapshot({ discovery: emptyDiscovery({ observing: autoDiscoveryEnabled({ stateRoot }) }), refresh: { state: "idle", startedAt: null, error: null }, now });
    scheduleRefresh();
    return withAutoDiscovery(lastSnapshot);
  }
  if (Date.now() - Date.parse(lastSnapshot.generatedAt) > FRESHNESS_MS) scheduleRefresh();
  return withAutoDiscovery(withRefreshState(lastSnapshot));
}

export async function refreshDeveloperRuntimeSnapshot() {
  if (inFlightRefresh) return inFlightRefresh;
  const startedAt = new Date().toISOString();
  const generation = refreshGeneration + 1;
  refreshGeneration = generation;
  inFlightRefresh = (async () => {
    try {
      const settings = loadSettings({ stateRoot });
      const observing = autoDiscoveryEnabled({ stateRoot });
      const previous = lastSnapshot;
      const registryBeforeDiscovery = loadRegistrySafe();
      // Independent of discovery, so pay for one round of latency rather than two. Both must settle
      // before portalInstance() runs below, since it reads the collected git context synchronously.
      const [discovery] = await Promise.all([
        !observing ? emptyDiscovery({ observing }) : discoverInstances({
          settings,
          // Carrying the prior health records forward is what makes failure debouncing work: the
          // classifier is pure, so the consecutive-failure count has to travel with the snapshot.
          previousHealth: healthIndexFromSnapshot(previous),
          // Every checkout the registry knows, so a Compose stack is placed by the checkout its bind
          // mounts actually depend on rather than by the directory it was started from.
          checkoutRootsByRepository: registryCheckoutRoots(registryBeforeDiscovery),
        }),
        refreshPortalGit(),
      ]);
      if (generation !== refreshGeneration && lastSnapshot) return withRefreshState(lastSnapshot);
      const portal = observing ? portalInstance() : null;
      if (portal) {
        discovery.instances = discovery.instances.filter((instance) => !isPortalDuplicate(instance, portal));
        discovery.instances.unshift(portal);
      }
      // Re-read rather than trusting `observing`: a scan takes seconds, and if the user turned
      // auto-discovery off meanwhile, recording now would restore the evidence that was just removed.
      if (observing && autoDiscoveryEnabled({ stateRoot })) recordDiscoveredRepositories(discovery.instances, discovery.composeProjectGit);
      // After recording, so a repository discovered on THIS scan is already in the registry and is
      // counted as running rather than appearing as idle on the poll that first found it.
      const runningIds = runningRepositoryIds(discovery);
      const registryNow = loadRegistrySafe();
      const idleMainCheckouts = await collectIdleMainCheckouts(discovery, runningIds, registryNow);
      const { persistedRepositories, registry } = await collectPersistedRepositories(runningIds, {
        registry: registryNow,
        extraLiveRoots: [...idleMainCheckouts.values()].map((checkout) => checkout.projectRoot),
      });
      lastSnapshot = buildSnapshot({
        discovery,
        settings,
        refresh: { state: "idle", startedAt: null, error: null, generation },
        persistedRepositories,
        idleMainCheckouts,
        registry,
      });
      // Only refreshes produce events. updateDeveloperRuntimeSettings also rebuilds a snapshot, but from
      // cached discovery with no fresh probe, so any diff there would be a settings artifact rather
      // than a real transition. Recorded after lastSnapshot is assigned so a history failure can
      // never cost us a good snapshot.
      recordHistoryEvents(previous, lastSnapshot, settings);
      return lastSnapshot;
    } catch (err) {
      const error = String(err?.message || err);
      if (lastSnapshot) {
        lastSnapshot = markDeveloperRuntimeRefreshFailed(lastSnapshot, { startedAt, error, generation });
        return lastSnapshot;
      }
      lastSnapshot = buildSnapshot({
        discovery: { ...emptyDiscovery(), warnings: [error] },
        refresh: { state: "failed", startedAt, error, generation },
      });
      return lastSnapshot;
    } finally {
      inFlightRefresh = null;
    }
  })();
  return inFlightRefresh;
}

// Resolution is deliberately two-step. The opaque key only ever resolves against the CURRENT
// snapshot, which is the SSRF/enumeration guard on this tokenless GET route — a browser can never
// hand the server a key the server did not itself mint. But the opaque key includes the origin, so
// it changes whenever an app's port changes; history is keyed by the port-free associationKey
// instead. Hence: opaque key -> current instance -> its associationKey -> events.
//
// Consequence: an app that has stopped has no current instance and therefore no readable history,
// even though its events remain on disk. Surfacing those needs a port-free handle for inactive
// entries, which belongs with the portal's inactive-card work.
// `snapshot` is an injection seam for tests, matching how the module layer takes runCommand/probeHttp
// — it keeps a check from triggering a live listener scan. Production callers pass nothing.
export function loadDeveloperRuntimeHistory(key, { snapshot = null } = {}) {
  const instance = findCurrentInstanceByOpaqueKey(snapshot || loadDeveloperRuntimeSnapshot(), key);
  if (!instance) return { ok: false, status: 404, error: "unknown developer-runtime key" };
  const events = readHistoryEvents({ stateRoot })
    .filter((event) => event.associationKey === instance.associationKey)
    .reverse()
    .slice(0, HISTORY_API_LIMIT);
  return {
    ok: true,
    key,
    app: instance.app ? { id: instance.app.id, name: instance.app.name } : null,
    associationKey: instance.associationKey,
    events,
  };
}

export async function loadDeveloperRuntimeMetadata(key) {
  const instance = findCurrentInstanceByOpaqueKey(loadDeveloperRuntimeSnapshot(), key);
  if (!instance) return { ok: false, status: 404, error: "unknown developer-runtime key" };
  const suggestions = await discoverMetadataSuggestions(instance.origin);
  return { ok: true, key, origin: instance.origin, suggestions };
}

export function updateDeveloperRuntimeSettings(input) {
  try {
    const settings = updateSettings({ stateRoot, input });
    const discovery = snapshotDiscovery(lastSnapshot);
    lastSnapshot = buildSnapshot({ discovery, settings });
    return { ok: true, developerRuntime: lastSnapshot };
  } catch (err) {
    if (err?.code === "REVISION_CONFLICT") {
      return {
        ok: false,
        status: 409,
        error: err.message,
        developerRuntime: buildSnapshot({ discovery: snapshotDiscovery(lastSnapshot), settings: err.current }),
      };
    }
    return { ok: false, status: 400, error: String(err?.message || err), developerRuntime: loadDeveloperRuntimeSnapshot() };
  }
}

// Bring a hidden repository back, or hide one by hand. Same response contract as
// updateDeveloperRuntimeSettings so the portal's mutate-then-apply path is identical, but the write lands
// in the repository registry rather than in Runtime's settings.
//
// No revision check: repository visibility is a single boolean per record with no cross-field
// invariant, so a concurrent write can only ever agree or be the user's own later decision. The
// settings revision guard exists for edits that must not silently clobber a different field.
export function setDeveloperRuntimeRepositoryVisibility({ repositoryId, hidden }) {
  if (!repositoryId || typeof repositoryId !== "string") {
    return { ok: false, status: 400, error: "repositoryId is required", developerRuntime: loadDeveloperRuntimeSnapshot() };
  }
  try {
    updateRegistry({
      stateRoot,
      mutate: (reg) => hideRepository(reg, repositoryId, { hidden: hidden === true }),
    });
  } catch (err) {
    return { ok: false, status: 400, error: String(err?.message || err), developerRuntime: loadDeveloperRuntimeSnapshot() };
  }
  // Deliberately NOT a buildSnapshot from cached discovery, the way the settings mutations do it.
  // The persisted-repository list is assembled on the refresh path (it derives lifecycle and reads
  // git), so rebuilding here would hand back a snapshot with `persistedRepositories` defaulted to
  // empty — dropping every idle repository from the page, not just changing the one that was
  // restored. Kicking a refresh costs one scan and returns the list actually reflecting the change.
  scheduleRefresh();
  return { ok: true, developerRuntime: loadDeveloperRuntimeSnapshot() };
}

// Pin or unpin a repository. Same contract and same no-revision-check reasoning as
// setDeveloperRuntimeRepositoryVisibility above: one boolean per record, no cross-field invariant.
//
// Returns a snapshot that already reflects the write, rather than scheduling a refresh and handing
// back the cached one. scheduleRefresh is fire-and-forget: it resolves after this function has
// returned, so loadDeveloperRuntimeSnapshot would answer from the snapshot built BEFORE the pin and the
// portal would render the old state until something else re-fetched — the pin appearing to do
// nothing until a manual page refresh.
//
// Rebuilding here is cheap and safe precisely because pinning needs no fresh discovery: it is a
// registry read layered over the discovery already cached, unlike visibility (which must re-derive
// the persisted-repository list and therefore genuinely needs a scan).
export function setDeveloperRuntimeRepositoryPinned({ repositoryId, pinned }) {
  if (!repositoryId || typeof repositoryId !== "string") {
    return { ok: false, status: 400, error: "repositoryId is required", developerRuntime: loadDeveloperRuntimeSnapshot() };
  }
  try {
    updateRegistry({
      stateRoot,
      mutate: (reg) => pinRepository(reg, repositoryId, { pinned: pinned === true }),
    });
  } catch (err) {
    return { ok: false, status: 400, error: String(err?.message || err), developerRuntime: loadDeveloperRuntimeSnapshot() };
  }
  if (lastSnapshot) {
    // Patched in place rather than rebuilt. A rebuild would need persistedRepositories, which is
    // assembled only on the refresh path — passing it empty drops every idle repository from the
    // page (the trap documented on setDeveloperRuntimeRepositoryVisibility), and reconstructing it from
    // the snapshot would duplicate that logic badly. Pinning touches exactly one boolean per
    // repository and the order derived from it, so applying both directly is the whole change.
    const pinnedIds = registryPinnedIds();
    const repositories = lastSnapshot.repositories.map((repository) => ({
      ...repository,
      pinned: pinnedIds.has(repository.repositoryId),
    }));
    lastSnapshot = { ...lastSnapshot, repositories: sortRepositoriesForDisplay(repositories) };
  }
  return { ok: true, developerRuntime: loadDeveloperRuntimeSnapshot() };
}

export function forgetDeveloperRuntimeRepository({ repositoryId }) {
  if (!repositoryId || typeof repositoryId !== "string") {
    return { ok: false, status: 400, error: "repositoryId is required", developerRuntime: loadDeveloperRuntimeSnapshot() };
  }
  // Checked inside the mutation, against the registry about to be written, rather than the cached
  // snapshot: that can be stale or — before the first refresh lands — empty, which would let a
  // repository with recorded checkouts be forgotten.
  let hasCheckouts = false;
  try {
    updateRegistry({
      stateRoot,
      mutate: (reg) => {
        hasCheckouts = checkoutRootsFor(reg, repositoryId).length > 0;
        return hasCheckouts ? false : forgetRepository(reg, repositoryId);
      },
    });
  } catch (err) {
    return { ok: false, status: 400, error: String(err?.message || err), developerRuntime: loadDeveloperRuntimeSnapshot() };
  }
  if (hasCheckouts) {
    return {
      ok: false,
      status: 400,
      error: "cannot forget a repository with known checkouts; hide it instead",
      developerRuntime: loadDeveloperRuntimeSnapshot(),
    };
  }
  scheduleRefresh();
  return { ok: true, developerRuntime: loadDeveloperRuntimeSnapshot() };
}

export function setDeveloperRuntimePortalInfo(info) {
  portalInfo = info;
  if (lastSnapshot) {
    const discovery = snapshotDiscovery(lastSnapshot);
    const portal = portalInstance();
    if (portal && !discovery.instances.some((instance) => instance.project?.identity === "builtin:portal")) {
      discovery.instances.unshift(portal);
      lastSnapshot = buildSnapshot({ discovery, settings: loadSettings({ stateRoot }) });
    }
  }
}

export function markDeveloperRuntimeRefreshFailed(snapshot, { startedAt, error, generation = snapshot.refresh?.generation || null }) {
  return {
    ...snapshot,
    refresh: { state: "failed", startedAt, error, generation },
    warnings: [...(snapshot.warnings || []), error],
  };
}

export async function developerRuntimeCommand(args) {
  const flags = new Set(args);
  const allowed = new Set(["--json", "--open"]);
  for (const arg of args) {
    if (!allowed.has(arg)) {
      console.error("usage: roborepo runtime [--json] [--open]");
      process.exit(2);
    }
  }
  if (flags.has("--open")) {
    const { serveCommand } = await import("./telemetry.mjs");
    return serveCommand(["--detach"], { allowPortFallback: true, openPath: "/runtime" });
  }
  const snapshot = await refreshDeveloperRuntimeSnapshot();
  if (flags.has("--json")) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }
  printDeveloperRuntimeTable(snapshot);
}

export function printDeveloperRuntimeTable(snapshot) {
  if (snapshot.capabilities.discovery !== "supported") {
    console.log(snapshot.capabilities.message);
    if (!snapshot.projects.length && !snapshot.inactiveProjects.length) return;
  }
  const rows = [];
  for (const project of snapshot.projects) {
    for (const instance of project.instances) {
      rows.push([
        project.name,
        instance.app?.name || "Web",
        instance.origin || "(no origin)",
        statusLabel(instance),
      ]);
    }
  }
  for (const instance of snapshot.unmatchedInstances) {
    rows.push(["Other instances", instance.process.command, instance.origin || "(no origin)", statusLabel(instance)]);
  }
  if (!rows.length) {
    console.log("No active localhost HTTP apps found.");
    return;
  }
  const widths = [0, 1, 2, 3].map((i) => Math.max(...rows.map((row) => row[i].length), ["Project", "App", "Origin", "Status"][i].length));
  console.log(padRow(["Project", "App", "Origin", "Status"], widths));
  console.log(padRow(widths.map((width) => "-".repeat(width)), widths));
  for (const row of rows) console.log(padRow(row, widths));
}

// Register repositories owning running processes into the shared registry (localhost tracking only
// — NEVER enables Plans, per the discovery/enrollment separation). Best-effort: a registry failure
// must never break Runtime discovery, so each write is guarded and errors are swallowed.
function recordDiscoveredRepositories(instances, composeProjectGit = null) {
  const seen = new Set();
  // A Compose stack resolves a repository and a checkout just as a listener does — from a manual
  // repoPath, from working_dir, or from bind mounts — but its containers are not host processes, so
  // they never appear in `instances`. Without this, a repository whose only presence is a container
  // stack is registered with no path, which then makes its own stack unplaceable: the classifier has
  // no checkout to test mounts against and everything falls back to `shared`.
  const sources = [...(instances || []).map((instance) => instance.project)];
  for (const resolved of (composeProjectGit || new Map()).values()) {
    if (!resolved?.repositoryId || !resolved.projectRoot) continue;
    sources.push({
      repositoryId: resolved.repositoryId,
      projectRoot: resolved.projectRoot,
      // rootId is null for a shared/unverified stack by design, so derive it from the path here —
      // the checkout is worth remembering even when the stack is not attributed to it.
      rootId: resolved.rootId || computeRootId(resolved.projectRoot),
      identityKind: resolved.repositoryId.startsWith("git:") ? "git" : "local",
      confidence: "high",
      name: null,
    });
  }
  // Deduped per (repository, checkout), not per repository. Keying on the repository alone recorded
  // only whichever checkout was seen first and silently dropped the rest, so a repository open in
  // several worktrees at once never accumulated more than one root — and the Compose classifier,
  // which tests mounts against every known checkout, could not return `conflict` even for a stack
  // that demonstrably mounts two of them. A repository with N live checkouts is N cheap registry
  // writes on the first scan and none afterwards (registerLocalRootPath debounces on lastSeenAt).
  for (const project of sources) {
    const repositoryId = project?.repositoryId;
    if (!repositoryId) continue;
    const rootKey = `${repositoryId}\0${project.rootId || project.projectRoot || ""}`;
    if (seen.has(rootKey)) continue;
    seen.add(rootKey);
    try {
      recordRepositoryDiscovery({
        repositoryId,
        kind: repositoryId.startsWith("git:") ? "git" : "local",
        displayName: displayNameForProject(project),
        source: "developer-runtime",
        evidence: project.identityKind === "git" ? "git-remote" : "cwd-in-git-root",
        confidence: project.confidence || "medium",
        localRoot: project.rootId || null,
        // The checkout this listener actually ran from. rootId is derived from exactly this path
        // (withRepositoryFields in modules/developer-runtime/discovery.mjs), so the two always agree —
        // recording the path alongside the id is what lets a repository be located when nothing is
        // running. Server-side only; it never enters a browser payload.
        localRootPath: project.projectRoot || null,
        stateRoot,
      });
    } catch {
      // Registry unavailable/corrupt — Runtime keeps working; the failure surfaces elsewhere
      // (Phase 4 reports registry errors as a structured health finding).
    }
  }
}

// Append transition events for this refresh. Best-effort in the same spirit as
// recordDiscoveredRepositories: history is an observability nicety and must never be able to break
// discovery, so every failure is swallowed.
function recordHistoryEvents(previous, next, settings) {
  try {
    if (knownHistoryKeys === null) {
      knownHistoryKeys = new Set(readHistoryEvents({ stateRoot }).map((event) => event.associationKey));
    }
    const events = diffSnapshots(previous, next, { now: new Date(), knownKeys: knownHistoryKeys });
    if (!events.length) return;
    for (const event of events) knownHistoryKeys.add(event.associationKey);
    appendHistoryEvents(events, {
      stateRoot,
      retentionDays: settings?.preferences?.historyRetentionDays,
    });
  } catch {
    // History unavailable (unwritable state dir, corrupt file) — discovery continues unaffected.
  }
}

function displayNameForProject(project) {
  const id = project.repositoryId || "";
  if (id.startsWith("git:")) return id.split("/").pop() || id;
  // local: id — fall back to the last path segment of the resolved root when available.
  const root = project.projectRoot;
  if (typeof root === "string" && root) return root.replace(/\/+$/, "").split("/").pop() || "repository";
  return "repository";
}

function scheduleRefresh() {
  if (!inFlightRefresh) refreshDeveloperRuntimeSnapshot().catch(() => {});
}

function buildSnapshot({ discovery, settings = loadSettings({ stateRoot }), refresh = { state: "idle", startedAt: null, error: null }, now = new Date(), persistedRepositories = [], idleMainCheckouts = new Map(), registry = loadRegistrySafe() }) {
  return withAutoDiscovery(buildDeveloperRuntimeSnapshot({
    discovery,
    settings,
    refresh,
    now,
    repositoryNames: registryDisplayNames(registry),
    repositoryUrlKeys: registryUrlKeys(registry),
    persistedRepositories,
    idleMainCheckouts,
    hiddenRepositories: collectHiddenRepositories(registry),
    pinnedRepositoryIds: registryPinnedIds(registry),
  }));
}

// Cross-poll, fingerprint-guarded (see modules/repositories/idle-git-cache.mjs). Module-scoped
// because it must survive between refreshes to be worth anything, which is safe here and not in
// scan-cache.mjs precisely because every entry re-validates against the checkout's git directory.
const idleGitCache = createIdleGitCache();

// Every repository the registry knows that is NOT running right now, with its lifecycle state and —
// for the ones whose checkout is still on disk — the git context read from that path.
//
// This is what retires the "Inactive saved projects" list. That list was built from saved app slots
// in settings, so it only ever held projects the user had explicitly configured; a repository you
// merely ran once and stopped appeared nowhere. Reading the registry instead means "seen once" is
// enough to stay listed, which is the promise the persistence phases exist to keep.
//
// Best-effort in the same spirit as registryDisplayNames: an unreadable registry costs the idle
// repositories and nothing else — the running ones come from discovery and are unaffected.
async function collectPersistedRepositories(runningRepositoryIds, { registry = loadRegistrySafe(), extraLiveRoots = [] } = {}) {
  if (!registry) return { persistedRepositories: [], registry: null };
  registry = applyRenameAliases(registry);
  registry = applyAgeOut(registry);
  const out = [];
  // Seeded with the idle main checkouts of running repositories (collectIdleMainCheckouts), which
  // read git through the same cache and would otherwise be evicted on every poll.
  const liveRoots = [...extraLiveRoots];
  for (const [id, record] of Object.entries(registry.repositories || {})) {
    if (runningRepositoryIds.has(id)) continue;
    // Hidden records are out of the normal list by definition; they return through "Show hidden",
    // which reads the registry directly rather than this snapshot field.
    if (record?.visibility === "hidden") continue;
    // A record whose every checkout has been repointed to another repository — the surviving half of
    // a rename Phase 2 deliberately did not merge. Listing it renders two cards with the same name,
    // one of which is a remote nobody uses any more. The record is untouched; it is only folded out
    // of this view, and it returns the moment any checkout resolves back to it.
    if (supersededBy(registry, id)) continue;
    // An alias is the user stating outright that this record IS another one — the sanctioned fix the
    // rename decision points at when it says a visible duplicate is "fixable with one setAlias".
    // Without this the list ignored aliases entirely, so setting one changed nothing on the page and
    // the duplicate it exists to resolve stayed put. Unlike supersededBy, which infers from repointed
    // checkouts and refuses to guess, this acts on an explicit instruction.
    if (resolveRegistryAlias(registry, id) !== id) continue;
    const lifecycle = deriveLifecycle(registry, id, { runningRepositoryIds });
    const checkouts = [];
    for (const checkout of lifecycle.checkouts) {
      // Git only for checkouts confirmed present. An absent or unreadable one has nothing to read,
      // and asking would be a subprocess per poll that can only fail.
      const git = checkout.state === "present" ? await readIdleGit(checkout.path, id) : null;
      if (checkout.state === "present") liveRoots.push(checkout.path);
      checkouts.push({
        rootId: checkout.rootId,
        kind: checkout.kind || null,
        state: checkout.state,
        reason: checkout.reason || null,
        projectRoot: checkout.path,
        git,
      });
    }
    out.push({
      repositoryId: id,
      name: record?.displayName || null,
      lifecycle: { state: lifecycle.state, reason: lifecycle.reason },
      lastSeenAt: lastSeenAtFor(record),
      favorite: record?.favorite === true,
      checkouts,
    });
  }
  // Bound the cache to checkouts still in play, so a long portal session does not accumulate entries
  // for repositories that have since been removed.
  idleGitCache.retain(liveRoots);
  return { persistedRepositories: out, registry };
}

// Alias a record onto the repository that a remote rename moved it into, and return the registry as
// it now stands.
//
// Phase 2 refused to act on a rename because it believed the evidence could not distinguish one from
// a deleted-and-recloned directory. `renamedInto` shows it can: a rootId is a hash of an absolute
// path, so the two records naming the same one is direct evidence the same directory was seen under
// both remotes, and the most-recently-used root separates the two cases (see lifecycle.mjs).
//
// The action stays an ALIAS, never a merge, and that is what makes doing it automatically
// defensible. An alias leaves both records intact, renders one row instead of two, and is reversed
// by deleting one line; a wrong one costs a row until it is removed. A merge — the thing Phase 2
// actually refused — would rewrite ownership and could hide one repository's work inside another,
// and is still not done here.
//
// Only ever writes when there is something to write, so the steady-state poll stays silent.
//
// Cost is quadratic in repository count — every record is tested against every other — and it runs
// on each ~10s poll to catch an event that happens maybe once a year. Measured before leaving it
// that way: 0.075ms for the 10 records on this machine, extrapolating to ~7.5ms at 100 and ~190ms
// at 500, against a scan that takes ~5s. Pure in-memory comparison, no I/O, so it stays well inside
// the noise until a registry is far larger than any real one. If it ever does register, the fix is
// to run it only when the record set has changed since the last sweep rather than to make the
// comparison cleverer.
function applyRenameAliases(registry) {
  let pending;
  try {
    pending = Object.keys(registry.repositories || {})
      // A record that already aliases somewhere is settled.
      .filter((id) => !registry.aliases?.[id])
      .map((id) => ({ id, into: renamedInto(registry, id) }))
      .filter((entry) => entry.into);
  } catch {
    return registry;
  }
  if (!pending.length) return registry;
  try {
    updateRegistry({
      stateRoot,
      mutate: (reg) => {
        let changed = false;
        for (const { id, into } of pending) {
          // Re-checked inside the mutation: the registry may have moved since the read above, and
          // setAlias throws on a cycle rather than silently building one.
          if (reg.aliases?.[id] || !reg.repositories?.[into]) continue;
          try {
            if (setAlias(reg, id, into)) changed = true;
          } catch {
            // A cycle or invalid target — leave the pair alone rather than failing the scan.
          }
        }
        return changed;
      },
    });
    return loadRegistry({ stateRoot });
  } catch {
    return registry;
  }
}

// Hide records not seen in 30 days, and return the registry as it now stands.
//
// ageOutCandidates deliberately returns candidates rather than hiding them, so that the write stays
// with a caller who can decide — this is that caller. Nothing is ever deleted: hiding moves a record
// out of the normal list and "Show hidden" brings it back, which is the whole contract.
//
// Only ever hides. A record the user explicitly un-hid must not be re-hidden behind their back on
// the next poll, so un-hiding is a one-way door from this sweep's perspective: `lastSeenAt` is what
// ageing measures, and restoring a record does not change it. The registry's own `hiddenAt` records
// when the sweep acted, so a restored record is distinguishable from one never hidden.
function applyAgeOut(registry) {
  let candidates;
  try {
    candidates = ageOutCandidates(registry);
  } catch {
    return registry;
  }
  if (!candidates.length) return registry;
  // A record the user restored keeps its restoredAt marker; skip those so the sweep cannot undo an
  // explicit decision the moment it runs again.
  const actionable = candidates.filter(({ repositoryId }) => !registry.repositories?.[repositoryId]?.restoredAt);
  if (!actionable.length) return registry;
  try {
    updateRegistry({
      stateRoot,
      mutate: (reg) => {
        let changed = false;
        for (const { repositoryId } of actionable) {
          if (hideRepository(reg, repositoryId, { hidden: true })) changed = true;
        }
        return changed;
      },
    });
    return loadRegistry({ stateRoot });
  } catch {
    // A registry that cannot be written costs the sweep and nothing else; the scan continues.
    return registry;
  }
}

// Records the ageing sweep has hidden, for the "Show hidden" affordance. Name and last-seen only —
// enough to decide whether to bring one back, without paying to derive lifecycle or read git for
// repositories that are, by construction, not on the page.
function collectHiddenRepositories(registry = loadRegistrySafe()) {
  if (!registry) return [];
  return Object.entries(registry.repositories || {})
    .filter(([, record]) => record?.visibility === "hidden")
    .map(([repositoryId, record]) => ({
      repositoryId,
      name: record.displayName || repositoryId,
      lastSeenAt: lastSeenAtFor(record),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Every repository with something live on this scan. Both sources count: a repository whose only
// presence is a Compose stack is running just as much as one with a dev server, and omitting the
// stacks would list it as idle directly above its own running containers.
function runningRepositoryIds(discovery) {
  const ids = new Set();
  for (const instance of discovery?.instances || []) {
    const id = instance?.project?.repositoryId;
    if (id) ids.add(id);
  }
  for (const resolved of (discovery?.composeProjectGit || new Map()).values()) {
    if (resolved?.repositoryId) ids.add(resolved.repositoryId);
  }
  return ids;
}

// The main checkout of every running repository that has nothing running in it, with its git read
// from disk the same way an idle repository's checkouts are. Without it, a repository whose
// worktrees are running but whose main checkout is not renders the main row blank: the running path
// only knows checkouts something runs in, and the persisted path skips running repositories.
//
// Found through git rather than the registry's root `kind`, which records whichever checkout
// happened to be seen first and so is not a reliable "main" marker. Every checkout of a repository —
// main or linked worktree — shares one common git directory, and a non-bare common directory is
// `<main checkout>/.git`. Any known checkout path is a starting point: a running member's own, or
// any path the registry recorded for the repository.
//
// repositoryId -> { rootId, projectRoot, git, state }. A repository whose main checkout cannot be
// found, is bare, or no longer resolves to the same repository is absent, leaving the row as it was.
// Exported for scripts/test/developer-runtime-check.mjs.
export async function collectIdleMainCheckouts(discovery, runningIds, registry) {
  const candidatesByRepository = new Map();
  const runningRootIds = new Set();
  const addCandidate = (repositoryId, projectRoot) => {
    if (!repositoryId || !projectRoot || !runningIds.has(repositoryId)) return;
    if (!candidatesByRepository.has(repositoryId)) candidatesByRepository.set(repositoryId, new Set());
    candidatesByRepository.get(repositoryId).add(projectRoot);
  };
  for (const instance of discovery?.instances || []) {
    const project = instance?.project;
    if (project?.rootId) runningRootIds.add(project.rootId);
    addCandidate(project?.repositoryId, project?.projectRoot);
  }
  for (const resolved of (discovery?.composeProjectGit || new Map()).values()) {
    if (resolved?.rootId) runningRootIds.add(resolved.rootId);
  }
  if (registry) {
    for (const id of runningIds) {
      for (const root of checkoutRootsFor(registry, id)) addCandidate(id, root.path);
    }
  }

  const out = new Map();
  for (const [repositoryId, candidates] of candidatesByRepository) {
    const mainRoot = mainCheckoutPath(candidates);
    if (!mainRoot) continue;
    const rootId = computeRootId(mainRoot);
    // Something runs there, so the running path already builds this row, members and all.
    if (runningRootIds.has(rootId)) continue;
    // readIdleGit also confirms the path still resolves to this repository. Null means it does not,
    // or could not be read — and a wrong branch is worse than the empty row.
    const git = await readIdleGit(mainRoot, repositoryId);
    if (!git) continue;
    out.set(repositoryId, { rootId, projectRoot: mainRoot, git, state: "present" });
  }
  return out;
}

// Git for a persisted checkout path, but only once that path is confirmed to still BE this
// repository.
//
// The plan's "reused directory" risk: a checkout is deleted and a different repository cloned to the
// same path. The registry still records the path against the old record, so reading git from it
// blind would print the new repository's branch on the old repository's card — a wrong fact stated
// confidently, which is worse than the missing one it replaces. A running repository never has this
// problem, because its identity is resolved from the process's own cwd on every scan; only a
// persisted path is trusted from storage.
//
// So the path is re-resolved through exactly the derivation discovery uses
// (canonicalRepositoryId(resolveProjectIdentity(root))) and the answer must still match. A mismatch
// yields no git rather than an error: the repository is genuinely still known, its checkout is just
// no longer where the record says, which is the same "listed, honest about what it does not know"
// state as a checkout with no recorded path at all.
async function readIdleGit(projectRoot, repositoryId) {
  try {
    const resolved = resolveGitDir(projectRoot);
    if (!resolved) return null;
    if (canonicalRepositoryId(resolveProjectIdentity(projectRoot)) !== repositoryId) return null;
    return await idleGitCache.get(projectRoot, resolved.gitDir, () => collectGitContext(projectRoot));
  } catch {
    // A checkout that disappears mid-scan reports no git rather than failing the refresh.
    return null;
  }
}

// Canonical repository names from the registry, so a card is titled by its repository rather than by
// whichever checkout happens to be running. Without this a repository whose only running checkout is
// a worktree is titled with the worktree's branch/directory name.
//
// Best-effort in the same spirit as recordDiscoveredRepositories: an unreadable or corrupt registry
// costs the canonical name and nothing else, so naming falls back to the running checkouts.
// repositoryId -> [{ rootId, path }] for every checkout with a recorded path. Best-effort for the
// same reason as registryDisplayNames: without it, stacks classify as shared/unverified rather than
// being placed under a wrong checkout.
function registryCheckoutRoots(registry = loadRegistrySafe()) {
  if (!registry) return new Map();
  const byRepository = new Map();
  for (const id of Object.keys(registry.repositories || {})) {
    const roots = checkoutRootsFor(registry, id);
    if (roots.length) byRepository.set(id, roots);
  }
  return byRepository;
}

function registryDisplayNames(registry = loadRegistrySafe()) {
  if (!registry) return new Map();
  const names = new Map();
  for (const [id, record] of Object.entries(registry.repositories || {})) {
    if (record.displayName) names.set(id, record.displayName);
  }
  return names;
}

function registryUrlKeys(registry = loadRegistrySafe()) {
  if (!registry) return new Map();
  const keys = new Map();
  for (const [id, record] of Object.entries(registry.repositories || {})) {
    if (record.urlKey) keys.set(id, record.urlKey);
  }
  return keys;
}

// Same read-and-degrade shape as registryDisplayNames: an unreadable registry costs the pins, not
// the page.
function registryPinnedIds(registry = loadRegistrySafe()) {
  if (!registry) return new Set();
  const pinned = new Set();
  for (const [id, record] of Object.entries(registry.repositories || {})) {
    if (record.pinned === true) pinned.add(id);
  }
  return pinned;
}

function loadRegistrySafe() {
  try {
    return loadRegistry({ stateRoot });
  } catch {
    return null;
  }
}

function withRefreshState(snapshot) {
  if (!inFlightRefresh) return snapshot;
  return { ...snapshot, refresh: { state: "refreshing", startedAt: snapshot.refresh?.startedAt || new Date().toISOString(), error: null } };
}

function emptyDiscovery({ observing = true } = {}) {
  return { capabilities: capabilityForPlatform(process.platform), warnings: [], instances: observing ? [portalInstance()].filter(Boolean) : [] };
}

// The Runtime page reads this to choose between its normal view and the Enable call to action.
function withAutoDiscovery(snapshot) {
  return { ...snapshot, autoDiscovery: { enabled: autoDiscoveryEnabled({ stateRoot }) } };
}

function snapshotDiscovery(snapshot) {
  if (!snapshot) return emptyDiscovery();
  return {
    capabilities: snapshot.capabilities,
    warnings: snapshot.warnings || [],
    instances: [
      ...snapshot.projects.flatMap((project) => project.instances || []),
      ...(snapshot.unmatchedInstances || []),
    ],
  };
}

// Git context for roborepo's own checkout, refreshed alongside every discovery pass. The portal is
// synthesized rather than discovered, so it has no probed cwd to resolve a repository from — appRoot
// is the honest answer and the only one available. Cached because portalInstance() is called from
// sync paths (setDeveloperRuntimePortalInfo, emptyDiscovery) that cannot await a subprocess.
//
// undefined means "never collected" (git context omitted); null means collected and unavailable,
// which is what a package-mode install with no .git correctly reports.
let portalGit;

// Canonical repository fields for appRoot, resolved once. Same sync-caller constraint as portalGit,
// but this is pure filesystem inspection rather than a subprocess, so it is computed lazily on
// first use instead of needing its own refresh hook.
let portalRepositoryCache;
function portalRepositoryFields() {
  if (portalRepositoryCache === undefined) {
    try {
      const resolved = resolveProjectIdentity(appRoot, "roborepo");
      portalRepositoryCache = {
        repositoryId: canonicalRepositoryId(resolved),
        rootId: resolved.projectRoot ? computeRootId(resolved.projectRoot) : null,
      };
    } catch {
      portalRepositoryCache = { repositoryId: null, rootId: null };
    }
  }
  return portalRepositoryCache;
}

async function refreshPortalGit() {
  try {
    portalGit = await collectGitContext(appRoot);
  } catch {
    // A failed collection must not cost us the refresh — the card simply renders without a badge.
    portalGit = null;
  }
}

function portalInstance() {
  const port = portalInfo?.port || null;
  if (!port) return null;
  const origin = port ? `http://127.0.0.1:${port}` : null;
  return {
    key: "builtin-portal",
    associationKey: "builtin-portal",
    matchSignature: { key: "builtin-portal", projectIdentity: "builtin:portal", relativeCwd: null, command: "roborepo", title: "RoboRepo Portal" },
    origin,
    alternateOrigins: [],
    bind: { address: "127.0.0.1", port, scope: "loopback", warning: null },
    status: 200,
    latencyMs: 0,
    protocol: "http",
    title: "RoboRepo Portal",
    // Synthesized rather than classified: the portal is the process doing the asking, so it is
    // healthy by construction and never probed. A static record keeps it out of the history diff's
    // healthTransition path instead of flapping between null and a state.
    health: { state: "healthy", reason: null, consecutiveFailures: 0, since: null, firstSeenAt: null, lastProbeAt: null },
    process: { pid: process.pid, command: "roborepo" },
    project: {
      identity: "builtin:portal",
      identityKind: "roborepo",
      confidence: "high",
      projectRoot: appRoot,
      evidence: "built-in portal",
      git: portalGit ?? null,
      // The synthetic identity above is deliberately not a git: identity — "builtin:portal" names
      // the portal app, not the repository it ships from. But the checkout underneath appRoot is a
      // real repository, so its canonical id is resolved separately here; without it the portal was
      // the one card that could never link to its own remote and always fell back to "local repo".
      // Null in a package-mode install with no .git, exactly like any other non-repo root.
      ...portalRepositoryFields(),
    },
  };
}

function isPortalDuplicate(instance, portal) {
  return instance.process?.pid === portal.process.pid && instance.bind?.port === portal.bind.port;
}

function statusLabel(instance) {
  if (instance.tls === "untrusted") return "TLS untrusted";
  return instance.status ? `HTTP ${instance.status}` : "unknown";
}

function padRow(row, widths) {
  return row.map((cell, i) => cell.padEnd(widths[i])).join("  ");
}
