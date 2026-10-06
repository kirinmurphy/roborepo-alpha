import fs from "node:fs";
import path from "node:path";
import {
  REGISTRY_VERSION,
  assertAliasGraph,
  defaultRegistry,
  newRepositoryRecord,
  resolveRegistryAlias,
  safeRepositoryId,
  validateRegistry,
} from "./schema.mjs";
import { allocateRepositoryUrlKey, validateRepositoryUrlKey } from "./url-key.mjs";

import { LAST_SEEN_DEBOUNCE_MS } from "./config.mjs";

export {
  REGISTRY_VERSION,
  defaultRegistry,
  resolveRegistryAlias,
  validateRegistry,
};

export function registryPathFor(stateRoot) {
  return path.join(stateRoot, "repositories", "registry.json");
}

export function loadRegistry({ stateRoot, fsApi = fs } = {}) {
  const filePath = registryPathFor(stateRoot);
  try {
    const parsed = JSON.parse(fsApi.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("repository registry must be an object");
    if (Number.isInteger(parsed.version) && parsed.version < REGISTRY_VERSION) {
      const fresh = defaultRegistry();
      writeRegistry({ stateRoot, registry: fresh, fsApi });
      return fresh;
    }
    if (parsed.version !== REGISTRY_VERSION) throw new Error(`unsupported repository registry version: ${parsed.version}`);
    return validateRegistry(parsed);
  } catch (err) {
    if (err && err.code === "ENOENT") return defaultRegistry();
    if (err instanceof SyntaxError) throw new Error("repository registry contains malformed JSON");
    throw err;
  }
}

export function writeRegistry({ stateRoot, registry, fsApi = fs } = {}) {
  const filePath = registryPathFor(stateRoot);
  const dir = path.dirname(filePath);
  fsApi.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.registry.${process.pid}.${Date.now()}.tmp`);
  fsApi.writeFileSync(temp, `${JSON.stringify(validateRegistry(registry), null, 2)}\n`);
  fsApi.renameSync(temp, filePath);
  return registry;
}

// Optimistic-concurrency mutation. `mutate(registry)` mutates a clone in place; if it returns
// false the write is skipped (no-op / debounced), otherwise the revision is bumped and persisted.
export function updateRegistry({ stateRoot, mutate, expectedRevision, fsApi = fs } = {}) {
  const current = loadRegistry({ stateRoot, fsApi });
  if (expectedRevision != null && expectedRevision !== current.revision) {
    const error = new Error("repository registry revision conflict");
    error.code = "REVISION_CONFLICT";
    error.current = current;
    throw error;
  }
  const next = structuredClone(current);
  const changed = mutate(next);
  if (changed === false) return current;
  next.revision += 1;
  writeRegistry({ stateRoot, registry: next, fsApi });
  return next;
}

// ---- In-memory mutators (operate on a registry clone; used inside updateRegistry) ----

// Shared guard: every mutator needs an existing record and fails identically without one.
function requireRecord(registry, id, action) {
  const record = registry.repositories[id];
  if (!record) throw new Error(`cannot ${action} for unknown repository: ${id}`);
  return record;
}

// Insert or refresh a canonical repository record. Idempotent: an existing record keeps its
// createdAt/discoveries/localRoots and only merges the provided metadata. Returns the record.
export function upsertRepository(registry, { id, kind, displayName, providerUrl = null, normalizedRemote = null, now = new Date().toISOString() }) {
  safeRepositoryId(id);
  const existing = registry.repositories[id];
  if (!existing) {
    const urlKey = allocateRepositoryUrlKey(registry, { repositoryId: id, displayName });
    const record = newRepositoryRecord(id, { kind, urlKey, displayName, providerUrl, normalizedRemote, now });
    registry.repositories[id] = record;
    return record;
  }
  if (displayName && existing.displayName !== displayName) existing.displayName = displayName;
  if (providerUrl != null && existing.providerUrl !== providerUrl) existing.providerUrl = providerUrl;
  if (normalizedRemote != null && existing.normalizedRemote !== normalizedRemote) existing.normalizedRemote = normalizedRemote;
  existing.updatedAt = now;
  return existing;
}

export function repositoryIdForUrlKey(registry, urlKey, { includeHidden = false } = {}) {
  validateRepositoryUrlKey(urlKey);
  const source = Object.values(registry.repositories || {}).find((record) => record.urlKey === urlKey);
  if (!source) return null;
  const repositoryId = resolveRegistryAlias(registry, source.id);
  const record = registry.repositories?.[repositoryId];
  if (!record || (!includeHidden && record.visibility === "hidden")) return null;
  return repositoryId;
}

// Append or refresh a discovery-provenance entry for one source. Idempotent per source kind plus
// sourceId: repeated discoveries from the same source only bump lastSeenAt (debounced), while two
// configured sources that both find a repository each keep their own entry. Returns true if
// anything changed (so updateRegistry can skip a pure-debounce write).
export function recordDiscovery(registry, id, { source, sourceId = null, evidence, confidence, now = new Date().toISOString() }) {
  const record = requireRecord(registry, id, "record discovery");
  const existing = record.discoveries.find((d) => sameDiscoverySource(d, { source, sourceId }));
  if (!existing) {
    record.discoveries.push({ source, ...(sourceId != null ? { sourceId } : {}), firstSeenAt: now, lastSeenAt: now, evidence, confidence });
    record.updatedAt = now;
    return true;
  }
  let changed = false;
  if (existing.evidence !== evidence) { existing.evidence = evidence; changed = true; }
  if (existing.confidence !== confidence) { existing.confidence = confidence; changed = true; }
  if (Date.parse(now) - Date.parse(existing.lastSeenAt) >= LAST_SEEN_DEBOUNCE_MS) { existing.lastSeenAt = now; changed = true; }
  if (changed) record.updatedAt = now;
  return changed;
}

// Record evidence on the repository an identity resolves to, only when that repository is already
// known. For observers that are evidence rather than sources (agent sessions, pljvmyh): they
// consolidate onto a repository a source found and never create one, so every listed repository has
// a checkout the user asked RoboRepo to read. Returns false when the identity matches no record.
export function recordDiscoveryIfKnown(registry, identity, discovery) {
  const id = resolveRegistryAlias(registry, identity);
  if (!registry.repositories[id]) return false;
  return recordDiscovery(registry, id, discovery);
}

// Delete one source's discovery entries from every record (pljvmyh §4). `sourceId` omitted removes
// every entry of that kind, which is how turning auto-discovery off drops its developer-runtime
// evidence. Records are never deleted here: a repository left with no evidence stays known and ages
// out through ageOutCandidates. Returns the ids of records that lost an entry.
export function removeDiscoveries(registry, { source, sourceId = undefined, now = new Date().toISOString() }) {
  const affected = [];
  for (const record of Object.values(registry.repositories || {})) {
    const kept = record.discoveries.filter((d) => !(d.source === source && (sourceId === undefined || d.sourceId === sourceId)));
    if (kept.length === record.discoveries.length) continue;
    record.discoveries = kept;
    record.updatedAt = now;
    affected.push(record.id);
  }
  return affected;
}

function sameDiscoverySource(discovery, { source, sourceId }) {
  return discovery.source === source && (discovery.sourceId ?? null) === (sourceId ?? null);
}

// Register a local on-disk root (clone or worktree) under a repository. Idempotent by rootId.
export function registerLocalRoot(registry, id, { rootId, kind = "clone", now = new Date().toISOString() }) {
  const record = requireRecord(registry, id, "register local root");
  const existing = record.localRoots.find((r) => r.rootId === rootId);
  if (!existing) {
    // First root registered becomes primary unless caller says otherwise.
    const resolvedKind = record.localRoots.length === 0 && kind === "clone" ? "primary" : kind;
    record.localRoots.push({ rootId, kind: resolvedKind, firstSeenAt: now, lastSeenAt: now });
    record.updatedAt = now;
    return true;
  }
  if (Date.parse(now) - Date.parse(existing.lastSeenAt) >= LAST_SEEN_DEBOUNCE_MS) {
    existing.lastSeenAt = now;
    record.updatedAt = now;
    return true;
  }
  return false;
}

// Record where a rootId actually lives on disk (pljvmyh §2's private index). Separate from
// registerLocalRoot because the two answer different questions — that one records THAT a checkout
// exists under a repository, this one records WHERE — but callers that know the path should call
// both, and recordRepositoryDiscovery does.
//
// Keyed by rootId alone: a rootId resolves to at most one current path. When a path moves, the
// mapping is overwritten rather than appended, so the index can never offer two candidate
// directories for one id.
//
// A rootId can legitimately change repositories — a directory that was one repo and became another
// (one such rootId already exists in the live registry). That is a repointing, not a conflict:
// repositoryId is overwritten alongside the path, and firstSeenAt is reset because it now dates a
// different repository's occupancy of that directory.
export function registerLocalRootPath(registry, id, { rootId, path, now = new Date().toISOString() }) {
  if (!rootId || !path) return false;
  requireRecord(registry, id, "register local root path");
  if (!registry.localRootPaths) registry.localRootPaths = {};
  const existing = registry.localRootPaths[rootId];
  if (!existing) {
    registry.localRootPaths[rootId] = { path, repositoryId: id, firstSeenAt: now, lastSeenAt: now };
    return true;
  }
  if (existing.path !== path || existing.repositoryId !== id) {
    // Repointed: the directory now resolves somewhere else, or to a different repository.
    registry.localRootPaths[rootId] = { path, repositoryId: id, firstSeenAt: now, lastSeenAt: now };
    return true;
  }
  // Unchanged — debounced exactly like registerLocalRoot so a steady-state poll writes nothing.
  if (Date.parse(now) - Date.parse(existing.lastSeenAt) >= LAST_SEEN_DEBOUNCE_MS) {
    existing.lastSeenAt = now;
    return true;
  }
  return false;
}

// Resolve a rootId to its absolute path. Server-side only — never call this while building a
// browser payload.
export function localRootPath(registry, rootId) {
  return registry.localRootPaths?.[rootId]?.path || null;
}

// Every known checkout path for a repository, as [{ rootId, path, kind }]. This is the set the
// Compose classifier tests bind mounts against, and the set the card reads git from when nothing is
// running. Roots with no recorded path are omitted: an entry with a null path cannot be tested or
// read, so including it would only invite a null check at every call site.
export function checkoutRootsFor(registry, id) {
  const record = registry.repositories?.[id];
  if (!record) return [];
  const out = [];
  for (const root of record.localRoots || []) {
    const entry = registry.localRootPaths?.[root.rootId];
    // Guard against a rootId that has since been repointed to a different repository.
    if (!entry || entry.repositoryId !== id) continue;
    out.push({ rootId: root.rootId, path: entry.path, kind: root.kind });
  }
  return out;
}

// Set enrollment for a domain. Idempotent — returns false when nothing changed.
export function setEnrollment(registry, id, domain, { enabled, sourceId = null, now = new Date().toISOString() }) {
  const record = requireRecord(registry, id, "set enrollment");
  const existing = record.enrollments[domain];
  const next = { enabled, ...(sourceId != null ? { sourceId } : {}) };
  if (existing && existing.enabled === enabled && (existing.sourceId ?? null) === sourceId) return false;
  record.enrollments[domain] = next;
  record.updatedAt = now;
  return true;
}

export function hideRepository(registry, id, { hidden, now = new Date().toISOString() }) {
  const record = requireRecord(registry, id, "hide");
  const target = hidden ? "hidden" : "visible";
  if (record.visibility === target) return false;
  record.visibility = target;
  // Un-hiding is an explicit decision and has to outlast the thing that hid the record. The 30-day
  // ageing sweep measures lastSeenAt, which restoring does not change — so without a marker the very
  // next sweep would re-hide a repository the user just asked to see, forever. The marker is set
  // only on restore and cleared on a deliberate re-hide, so hiding by hand still works.
  if (hidden) delete record.restoredAt;
  else record.restoredAt = now;
  record.updatedAt = now;
  return true;
}

// Explicitly forget an observed repository. This is reserved for the UI's no-known-checkout
// action: it removes the registry observation, not files in the checkout and not domain data held
// elsewhere. A future scan can register the repository again if it is observed later.
export function forgetRepository(registry, id) {
  requireRecord(registry, id, "forget");
  delete registry.repositories[id];
  for (const [source, target] of Object.entries(registry.aliases || {})) {
    if (source === id || target === id) delete registry.aliases[source];
  }
  for (const [rootId, entry] of Object.entries(registry.localRootPaths || {})) {
    if (entry.repositoryId === id) delete registry.localRootPaths[rootId];
  }
  return true;
}

// Pin or unpin a repository. Idempotent — returns false when nothing changed.
//
// Deliberately a repository-level fact rather than a per-member one: pinning survives the process
// exiting, so an idle repository keeps its position in the list. The old per-app/per-compose
// `favorite` could not do this — an idle repository has no members to hold the flag, so the toggle
// wrote to an empty list and silently did nothing.
export function pinRepository(registry, id, { pinned, now = new Date().toISOString() }) {
  const record = requireRecord(registry, id, "pin");
  const target = pinned === true;
  if ((record.pinned === true) === target) return false;
  record.pinned = target;
  record.updatedAt = now;
  return true;
}

// Find the repository a checkout already belongs to, when a scan resolves that same checkout to a
// DIFFERENT canonical id than last time.
//
// `git remote set-url` changes a repository's canonical identity without changing the repository:
// same directory, same history, same work. Registering the new id blind would mint a second record
// and split one repository across two cards, each holding half its checkouts.
//
// But the same observation — "rootId X now resolves to id B, not A" — has a second possible cause:
// the directory was deleted and a DIFFERENT repository cloned in its place. Aliasing that case
// merges two unrelated repositories onto one card, which is worse than the duplicate aliasing
// avoids: a duplicate is visible and correctable, a bad merge silently misattributes work.
//
// rootId cannot tell these apart — it is derived from the path, which is identical either way. The
// live registry contains a real instance (one rootId under both harness_configs and roborepo, hours
// apart) that reads as a rename but is indistinguishable from a repurpose in the stored data.
//
// So this never guesses, and it never aliases on its own. It REPORTS the ambiguity: the prior
// repository that held this checkout, for a caller that wants to surface "this checkout moved from
// A to B" or offer an explicit merge. `setAlias` stays the way two records become one, and stays a
// deliberate act.
//
// Choosing to split rather than merge is the safe direction. A split repository is visible on the
// page and fixable with one alias; a wrong merge hides one repository's work inside another's card
// and gives the user no signal that it happened.
export function priorRepositoryForRoot(registry, { rootId, nextRepositoryId }) {
  if (!rootId || !nextRepositoryId) return null;
  const entry = registry.localRootPaths?.[rootId];
  if (!entry || entry.repositoryId === nextRepositoryId) return null;
  if (!registry.repositories?.[entry.repositoryId]) return null;
  return entry.repositoryId;
}

// Confirm that an opaque source identity aliases to a canonical repository. Cycle-checked before
// commit (mirrors developer-runtime mutateAlias). Idempotent.
export function setAlias(registry, fromIdentity, toRepositoryId, { now = new Date().toISOString() } = {}) {
  safeRepositoryId(toRepositoryId);
  if (fromIdentity === toRepositoryId) throw new Error("alias cannot point to itself");
  if (registry.aliases[fromIdentity] === toRepositoryId) return false;
  const nextAliases = { ...registry.aliases, [fromIdentity]: toRepositoryId };
  assertAliasGraph(nextAliases);
  registry.aliases = nextAliases;
  const record = registry.repositories[toRepositoryId];
  if (record && !record.aliases.includes(fromIdentity)) {
    record.aliases.push(fromIdentity);
    record.updatedAt = now;
  }
  return true;
}
