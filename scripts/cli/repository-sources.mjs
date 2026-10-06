// Repository-source orchestration (pljvmyh §1–§5): sequences the sources store, the bounded walker,
// canonical identity, and registry writes. Dependency-injectable (stateRoot / fsApi / hooks) so
// checks drive it against temp state. Every payload here is for the protected source-management
// routes, the only browser surface allowed to carry configured source paths (§6).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STATE_ROOT as defaultStateRoot } from "./paths.mjs";
import {
  AUTO_DISCOVERY_SOURCE_ID,
  CONFIGURED_DISCOVERY_SOURCE,
  addSource,
  classifySourcePath,
  isAutoDiscoveryEnabled,
  loadRegistry,
  loadSources,
  removeDiscoveries,
  removeSource,
  requireSource,
  setSourceEnabled,
  setSourceStatus,
  sourceError,
  updateRegistry,
  updateSources,
  userSources,
  walkRepositoryRoots,
} from "../../modules/repositories/index.mjs";
import { identifyRepositoryRoot, recordSourceFindings } from "./repository-source-refresh.mjs";
import { sourcesManagementPayload } from "./repository-sources-payload.mjs";

export function loadRepositorySources({ stateRoot = defaultStateRoot, fsApi = fs, homeDir = os.homedir() } = {}) {
  return sourcesManagementPayload({ store: loadSources({ stateRoot, fsApi }), registry: loadRegistry({ stateRoot, fsApi }), homeDir });
}

export function autoDiscoveryEnabled({ stateRoot = defaultStateRoot, fsApi = fs } = {}) {
  try {
    return isAutoDiscoveryEnabled(loadSources({ stateRoot, fsApi }));
  } catch {
    return false; // Unreadable state never turns observation on.
  }
}

// Adding a folder is its own consent: the user supplied the path. The kind is inferred only for a
// path that can be read now; an unreadable one needs the user's stated intent, which is then kept
// as-is on every later refresh.
export function addRepositorySource({ path: input, kind = null, stateRoot = defaultStateRoot, fsApi = fs, homeDir = os.homedir(), now = new Date().toISOString() }) {
  const sourcePath = normalizeSourcePath(input, { fsApi, homeDir });
  const resolvedKind = kind || inferKind(sourcePath, fsApi);
  let added;
  updateSources({ stateRoot, fsApi, mutate: (store) => { added = addSource(store, { path: sourcePath, kind: resolvedKind, now }); } });
  refreshSource(added.id, { stateRoot, fsApi, now });
  return loadRepositorySources({ stateRoot, fsApi, homeDir });
}

export function removeRepositorySource({ id, stateRoot = defaultStateRoot, fsApi = fs, homeDir = os.homedir(), now = new Date().toISOString() }) {
  updateSources({ stateRoot, fsApi, mutate: (store) => { removeSource(store, id); } });
  dropEvidence({ source: CONFIGURED_DISCOVERY_SOURCE, sourceId: id }, { stateRoot, fsApi, now });
  return loadRepositorySources({ stateRoot, fsApi, homeDir });
}

// Disabling a source and removing it drop evidence identically (§4); auto-discovery's evidence is
// its developer-runtime entries. Enabling refreshes at once — for auto-discovery that is the
// consent step, so the first process scan starts immediately through `onAutoDiscoveryEnabled`.
export function setRepositorySourceEnabled({ id, enabled, onAutoDiscoveryEnabled = () => {}, stateRoot = defaultStateRoot, fsApi = fs, homeDir = os.homedir(), now = new Date().toISOString() }) {
  let changed = false;
  updateSources({ stateRoot, fsApi, mutate: (store) => (changed = setSourceEnabled(store, id, enabled)) });
  if (changed && !enabled) {
    const evidence = id === AUTO_DISCOVERY_SOURCE_ID
      ? { source: "developer-runtime" }
      : { source: CONFIGURED_DISCOVERY_SOURCE, sourceId: id };
    dropEvidence(evidence, { stateRoot, fsApi, now });
  }
  if (changed && enabled) {
    if (id === AUTO_DISCOVERY_SOURCE_ID) onAutoDiscoveryEnabled();
    else refreshSource(id, { stateRoot, fsApi, now });
  }
  return loadRepositorySources({ stateRoot, fsApi, homeDir });
}

// Refresh one source, or every enabled folder source when `id` is omitted. One failing source
// records its own status and never stops the others.
export function refreshRepositorySources({ id = null, onAutoDiscoveryEnabled = () => {}, stateRoot = defaultStateRoot, fsApi = fs, homeDir = os.homedir(), now = new Date().toISOString() } = {}) {
  const store = loadSources({ stateRoot, fsApi });
  if (id === AUTO_DISCOVERY_SOURCE_ID) {
    if (isAutoDiscoveryEnabled(store)) onAutoDiscoveryEnabled();
  } else if (id) {
    requireSource(store, id);
    refreshSource(id, { stateRoot, fsApi, now });
  } else {
    for (const source of userSources(store).filter((item) => item.enabled)) refreshSource(source.id, { stateRoot, fsApi, now });
  }
  return loadRepositorySources({ stateRoot, fsApi, homeDir });
}

function refreshSource(id, { stateRoot, fsApi, now }) {
  const source = requireSource(loadSources({ stateRoot, fsApi }), id);
  if (!source.enabled) return;
  let status;
  try {
    status = source.kind === "repository" ? refreshRepository(source, { stateRoot, fsApi, now }) : refreshDirectory(source, { stateRoot, fsApi, now });
  } catch (err) {
    status = { state: "error", repositoryCount: 0, message: String(err?.message || err).slice(0, 500) };
  }
  updateSources({ stateRoot, fsApi, mutate: (store) => setSourceStatus(store, id, { ...status, refreshedAt: now }) });
}

function refreshRepository(source, { stateRoot, fsApi, now }) {
  if (classifySourcePath(source.path, { fsApi }) === "unresolved") {
    return { state: "unavailable", repositoryCount: 0, message: "The path is missing or cannot be read." };
  }
  const found = identifyRepositoryRoot(source.path, { fsApi });
  if (!found) {
    recordSourceFindings([], source, { stateRoot, fsApi, now, complete: true });
    return { state: "stale", repositoryCount: 0, message: "The folder exists but has no .git or docs/plans." };
  }
  recordSourceFindings([found], source, { stateRoot, fsApi, now, complete: true });
  return { state: "healthy", repositoryCount: 1, message: null };
}

function refreshDirectory(source, { stateRoot, fsApi, now }) {
  const walk = walkRepositoryRoots([source.path], { fsApi });
  const rootMissing = walk.errors.some((error) => error.root === source.path);
  if (rootMissing) return { state: "unavailable", repositoryCount: 0, message: "The folder is missing or cannot be read." };
  const found = walk.repositories.map((root) => identifyRepositoryRoot(root, { fsApi })).filter(Boolean);
  // A truncated walk, or one that could not read some subfolders, is incomplete evidence: it may not
  // drop entries for repositories it never reached, or a broad or partly unreadable folder would
  // forget repositories every time it ran.
  const complete = !walk.truncated && walk.errors.length === 0;
  const repositoryCount = recordSourceFindings(found, source, { stateRoot, fsApi, now, complete });
  if (walk.truncated) return { state: "partial", repositoryCount, message: "The scan stopped early (time or repository limit); some repositories may be missing." };
  if (walk.errors.length) return { state: "partial", repositoryCount, message: `${walk.errors.length} folder${walk.errors.length === 1 ? "" : "s"} could not be read.` };
  return { state: "healthy", repositoryCount, message: null };
}

function dropEvidence(selector, { stateRoot, fsApi, now }) {
  updateRegistry({ stateRoot, fsApi, mutate: (registry) => removeDiscoveries(registry, { ...selector, now }).length > 0 });
}

function inferKind(sourcePath, fsApi) {
  const kind = classifySourcePath(sourcePath, { fsApi });
  if (kind === "unresolved") {
    throw sourceError("INTENT_REQUIRED", "This path can't be read right now. Choose whether it is one repository or a folder of repositories.");
  }
  return kind;
}

function normalizeSourcePath(input, { fsApi, homeDir }) {
  if (typeof input !== "string" || !input.trim()) throw sourceError("INVALID_SOURCE", "Enter a folder path.");
  const expanded = input.trim().replace(/^~(?=$|\/)/, homeDir);
  if (!path.isAbsolute(expanded)) throw sourceError("INVALID_SOURCE", "Enter an absolute path, or one starting with ~/.");
  const resolved = path.resolve(expanded);
  try {
    return fsApi.realpathSync(resolved);
  } catch {
    return resolved; // Unresolved paths are stored as entered; the user has chosen their intent.
  }
}
