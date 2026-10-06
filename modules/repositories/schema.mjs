// Versioned schema + strict validators for the canonical repository registry. Mirrors the
// developer-runtime settings-schema convention exactly: a *_VERSION const, allow-list validators that
// THROW on any unknown key, no I/O in this file. See modules/developer-runtime/settings-schema.mjs.

import { validateRepositoryUrlKey } from "./url-key.mjs";

// v3 (pljvmyh §4): discoveries carry a per-source `sourceId` for configured repository sources. Lower
// versions are discarded on load rather than migrated — a deliberate clean cutover.
export const REGISTRY_VERSION = 3;

// Lifecycle is multi-dimensional — never one mutually exclusive enum. Each dimension is validated
// independently so a repository can be e.g. visible + resolved + active + unmonitored at once.
export const VISIBILITY_STATES = ["visible", "hidden"];
export const RESOLUTION_STATES = ["resolved", "unresolved"];
export const ACTIVITY_STATES = ["active", "inactive", "unknown"];

// Domains that can be independently enrolled for ongoing monitoring/association.
export const ENROLLMENT_DOMAINS = ["plans", "developer-runtime", "telemetry", "agentConfig", "health"];

// Discovery sources allowed in provenance records. `repository-source` is a user-configured folder
// or exact repository; it is the only kind that carries a `sourceId`, because a repository can be
// found by several configured sources at once and each must be removable on its own.
export const DISCOVERY_SOURCES = ["plans", "developer-runtime", "telemetry", "agentConfig", "doctor", "manual", "repository-source"];
export const CONFIGURED_DISCOVERY_SOURCE = "repository-source";

export const CONFIDENCE_LEVELS = ["high", "medium", "low", "suggestion"];

export function defaultRegistry() {
  return { version: REGISTRY_VERSION, revision: 1, repositories: {}, aliases: {} };
}

// A canonical repository id is either a portable git id or an opaque local id. This is deliberately
// narrower than developer-runtime's safeIdentity (which also accepts path:/process:/roborepo:) — only
// git: and local: may be REGISTERED as canonical repositories.
export function safeRepositoryId(value) {
  if (typeof value !== "string" || !/^(git|local):/.test(value)) throw new Error("invalid repository id");
  if (value.length > 512) throw new Error("repository id too long");
  return value;
}

export function safeIsoTimestamp(value, label) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error(`${label} must be an ISO-8601 timestamp`);
  return value;
}

function safeString(value, label, max = 200) {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label} is invalid`);
  return value.trim().slice(0, max);
}

function safeOpaqueId(value, label) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

// Absolute, control-character-free, and free of traversal segments. Unlike safeString this must NOT
// trim or truncate: a silently shortened path would resolve to the wrong directory rather than
// failing, and a path is used to read a filesystem rather than to be displayed.
function safeAbsolutePath(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} is invalid`);
  if (value.length > 4096) throw new Error(`${label} too long`);
  if (/[\x00-\x1F\x7F]/.test(value)) throw new Error(`${label} is invalid`);
  if (!value.startsWith("/")) throw new Error(`${label} must be absolute`);
  if (value.split("/").includes("..")) throw new Error(`${label} must not contain traversal segments`);
  return value;
}

function validateObjectKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`unknown ${label} field: ${key}`);
  }
}

export function validateRegistry(registry) {
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) throw new Error("registry must be an object");
  validateObjectKeys(registry, ["aliases", "localRootPaths", "repositories", "revision", "version"], "registry");
  if (registry.version !== REGISTRY_VERSION) throw new Error(`unsupported repository registry version: ${registry.version}`);
  if (!Number.isInteger(registry.revision) || registry.revision < 1) throw new Error("registry revision must be a positive integer");
  validateRepositories(registry.repositories);
  validateAliases(registry.aliases);
  validateLocalRootPaths(registry.localRootPaths);
  return registry;
}

// The private rootId -> absolute path index (pljvmyh §2). It lives in the registry file rather than
// a sibling one so that identity and path commit as a single logical update: updateRegistry is
// already one read-mutate-write with a revision bump, and two files could not be committed
// atomically against a concurrent writer.
//
// Paths never reach the browser. That boundary is enforced where payloads are built
// (repositoryListPayload/repositoryDetailPayload whitelist fields explicitly and map localRoots to
// kind/timestamps only), not by keeping the data in a separate file — a separate file would be one
// forgotten spread away from leaking anyway.
//
// Keyed by rootId alone, not repositoryId -> rootId: a rootId resolves to at most ONE current path
// (an invariant of the spec), and a flat key makes that unrepresentable-otherwise rather than
// merely enforced. Reused directories are the reason this matters — one rootId already appears
// under two repositories in the live registry.
function validateLocalRootPaths(localRootPaths) {
  if (localRootPaths === undefined) return; // Absent on records written before this index existed.
  if (!localRootPaths || typeof localRootPaths !== "object" || Array.isArray(localRootPaths)) {
    throw new Error("registry localRootPaths must be an object");
  }
  for (const [rootId, entry] of Object.entries(localRootPaths)) {
    safeOpaqueId(rootId, "localRootPath rootId");
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("localRootPath must be an object");
    validateObjectKeys(entry, ["path", "repositoryId", "firstSeenAt", "lastSeenAt"], "localRootPath");
    safeAbsolutePath(entry.path, "localRootPath path");
    safeRepositoryId(entry.repositoryId);
    safeIsoTimestamp(entry.firstSeenAt, "localRootPath firstSeenAt");
    safeIsoTimestamp(entry.lastSeenAt, "localRootPath lastSeenAt");
  }
}

function validateRepositories(repositories) {
  if (!repositories || typeof repositories !== "object" || Array.isArray(repositories)) throw new Error("registry repositories must be an object");
  const urlKeys = new Set();
  for (const [id, record] of Object.entries(repositories)) {
    safeRepositoryId(id);
    validateRepositoryRecord(id, record);
    if (urlKeys.has(record.urlKey)) throw new Error(`duplicate repository urlKey: ${record.urlKey}`);
    urlKeys.add(record.urlKey);
  }
}

export function validateRepositoryRecord(id, record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("repository record must be an object");
  validateObjectKeys(record, [
    "id", "kind", "urlKey", "displayName", "providerUrl", "normalizedRemote",
    "localRoots", "discoveries", "enrollments", "aliases",
    "visibility", "resolution", "activity", "pinned", "createdAt", "updatedAt", "restoredAt",
  ], "repository record");
  if (record.id !== id) throw new Error("repository record id must match its key");
  safeRepositoryId(record.id);
  validateRepositoryUrlKey(record.urlKey);
  if (!["git", "local"].includes(record.kind)) throw new Error("repository kind must be git or local");
  safeString(record.displayName, "repository displayName", 120);
  if (record.providerUrl != null) validateProviderUrl(record.providerUrl);
  if (record.normalizedRemote != null) safeRepositoryId(record.normalizedRemote);
  validateLocalRoots(record.localRoots);
  validateDiscoveries(record.discoveries);
  validateEnrollments(record.enrollments);
  validateRecordAliases(record.aliases);
  if (!VISIBILITY_STATES.includes(record.visibility)) throw new Error("repository visibility is invalid");
  if (!RESOLUTION_STATES.includes(record.resolution)) throw new Error("repository resolution is invalid");
  if (!ACTIVITY_STATES.includes(record.activity)) throw new Error("repository activity is invalid");
  // Pinning is a fact about the REPOSITORY, not about whatever happens to be listening in it. It
  // lives here rather than on the developer-runtime settings' per-app/per-compose records because those
  // exist only while something runs: an idle repository has no members to carry the flag, so a
  // member-level pin could neither be set nor read once the process exited.
  if (record.pinned != null && typeof record.pinned !== "boolean") throw new Error("repository pinned must be a boolean");
  safeIsoTimestamp(record.createdAt, "repository createdAt");
  safeIsoTimestamp(record.updatedAt, "repository updatedAt");
  // Set when the user brings a record back from "Show hidden", absent otherwise. It exists so the
  // 30-day ageing sweep cannot re-hide a repository the user just restored: ageing measures
  // lastSeenAt, which restoring does not change, so without this the next sweep would undo the
  // decision immediately and every time thereafter.
  if (record.restoredAt != null) safeIsoTimestamp(record.restoredAt, "repository restoredAt");
  return record;
}

// Only https loopback-free provider URLs for recognized-shape hosts. Never embed credentials.
function validateProviderUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("repository providerUrl must be a valid URL");
  }
  if (url.protocol !== "https:") throw new Error("repository providerUrl must be https");
  if (url.username || url.password) throw new Error("repository providerUrl must not contain credentials");
  return value;
}

function validateLocalRoots(localRoots) {
  if (!Array.isArray(localRoots)) throw new Error("repository localRoots must be an array");
  const seen = new Set();
  for (const root of localRoots) {
    if (!root || typeof root !== "object" || Array.isArray(root)) throw new Error("localRoot must be an object");
    validateObjectKeys(root, ["rootId", "kind", "firstSeenAt", "lastSeenAt"], "localRoot");
    const rootId = safeOpaqueId(root.rootId, "localRoot rootId");
    if (seen.has(rootId)) throw new Error(`duplicate localRoot rootId: ${rootId}`);
    seen.add(rootId);
    if (!["primary", "clone", "worktree"].includes(root.kind)) throw new Error("localRoot kind is invalid");
    safeIsoTimestamp(root.firstSeenAt, "localRoot firstSeenAt");
    safeIsoTimestamp(root.lastSeenAt, "localRoot lastSeenAt");
  }
}

function validateDiscoveries(discoveries) {
  if (!Array.isArray(discoveries)) throw new Error("repository discoveries must be an array");
  for (const discovery of discoveries) {
    if (!discovery || typeof discovery !== "object" || Array.isArray(discovery)) throw new Error("discovery must be an object");
    validateObjectKeys(discovery, ["source", "sourceId", "firstSeenAt", "lastSeenAt", "evidence", "confidence"], "discovery");
    if (!DISCOVERY_SOURCES.includes(discovery.source)) throw new Error("discovery source is invalid");
    if (discovery.source === CONFIGURED_DISCOVERY_SOURCE) safeOpaqueId(discovery.sourceId, "discovery sourceId");
    else if (discovery.sourceId != null) throw new Error("discovery sourceId is only valid for configured repository sources");
    safeIsoTimestamp(discovery.firstSeenAt, "discovery firstSeenAt");
    safeIsoTimestamp(discovery.lastSeenAt, "discovery lastSeenAt");
    safeString(discovery.evidence, "discovery evidence", 80);
    if (!CONFIDENCE_LEVELS.includes(discovery.confidence)) throw new Error("discovery confidence is invalid");
  }
}

function validateEnrollments(enrollments) {
  if (!enrollments || typeof enrollments !== "object" || Array.isArray(enrollments)) throw new Error("repository enrollments must be an object");
  for (const [domain, enrollment] of Object.entries(enrollments)) {
    if (!ENROLLMENT_DOMAINS.includes(domain)) throw new Error(`unknown enrollment domain: ${domain}`);
    if (!enrollment || typeof enrollment !== "object" || Array.isArray(enrollment)) throw new Error("enrollment must be an object");
    validateObjectKeys(enrollment, ["enabled", "sourceId"], "enrollment");
    if (typeof enrollment.enabled !== "boolean") throw new Error("enrollment enabled must be boolean");
    if (enrollment.sourceId != null) safeOpaqueId(enrollment.sourceId, "enrollment sourceId");
  }
}

// Per-record aliases: opaque source identities (e.g. a path:/process: identity, or a legacy id)
// that have been user-confirmed to mean THIS repository. Stored on the record for provenance; the
// registry-level alias map is what resolution walks.
function validateRecordAliases(aliases) {
  if (!Array.isArray(aliases)) throw new Error("repository aliases must be an array");
  for (const alias of aliases) {
    if (typeof alias !== "string" || !alias.trim()) throw new Error("repository alias must be a non-empty string");
  }
}

// Registry-level alias map: { [fromIdentity]: canonicalRepositoryId }. Any string source id may be
// a `from`; the `to` must be a registered canonical id shape. Cycle-checked.
function validateAliases(aliases) {
  if (!aliases || typeof aliases !== "object" || Array.isArray(aliases)) throw new Error("registry aliases must be an object");
  for (const [from, to] of Object.entries(aliases)) {
    if (typeof from !== "string" || !from.trim()) throw new Error("alias source must be a non-empty string");
    safeRepositoryId(to);
    if (from === to) throw new Error("alias cannot point to itself");
  }
  assertAliasGraph(aliases);
}

export function resolveRegistryAlias(registry, identity) {
  let current = identity;
  const seen = new Set([current]);
  for (;;) {
    const next = registry?.aliases?.[current];
    if (!next) return current;
    if (seen.has(next)) throw new Error("registry aliases must not contain cycles");
    seen.add(next);
    current = next;
  }
}

export function assertAliasGraph(aliases) {
  for (const identity of Object.keys(aliases)) {
    const seen = new Set([identity]);
    let next = aliases[identity];
    while (next) {
      if (seen.has(next)) throw new Error("registry aliases must not contain cycles");
      seen.add(next);
      next = aliases[next];
    }
  }
}

// Build a fresh, valid repository record with sane lifecycle defaults.
export function newRepositoryRecord(id, { kind, urlKey, displayName, now = new Date().toISOString(), providerUrl = null, normalizedRemote = null }) {
  safeRepositoryId(id);
  const record = {
    id,
    kind,
    urlKey,
    displayName,
    providerUrl: providerUrl ?? null,
    normalizedRemote: normalizedRemote ?? null,
    localRoots: [],
    discoveries: [],
    enrollments: {},
    aliases: [],
    visibility: "visible",
    resolution: kind === "git" ? "resolved" : "unresolved",
    activity: "unknown",
    pinned: false,
    createdAt: now,
    updatedAt: now,
  };
  return validateRepositoryRecord(id, record);
}
