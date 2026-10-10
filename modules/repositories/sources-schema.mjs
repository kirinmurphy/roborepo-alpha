// Versioned schema + strict validators for the repository-sources store (pljvmyh §1). A source is
// user intent — "you may look here" — while the registry is discovered state, so the two live in
// separate files. Same conventions as schema.mjs: a *_VERSION const, allow-list validators that
// throw on unknown keys, no I/O.

export const SOURCES_VERSION = 1;

// The one built-in source. Its id is fixed so every caller can address it without a lookup.
export const AUTO_DISCOVERY_SOURCE_ID = "auto-discovery";

export const SOURCE_KINDS = ["auto-discovery", "repository", "directory"];
export const USER_SOURCE_KINDS = ["repository", "directory"];

// pending: never refreshed. healthy: last refresh read everything it was asked to. partial: the
// walk hit its time budget or repository cap, or some subfolders were unreadable. unavailable: the
// configured path is missing or unreadable. stale: an exact repository source whose path no longer
// holds a repository. error: anything else the refresh could not classify.
export const SOURCE_STATES = ["pending", "healthy", "partial", "unavailable", "stale", "error"];

// Auto-discovery is off until the user turns it on: RoboRepo asks before observing processes.
// Flipping this default is deliberately a one-value change.
export const AUTO_DISCOVERY_DEFAULT_ENABLED = false;

export function defaultSources(now = new Date().toISOString()) {
  return {
    version: SOURCES_VERSION,
    revision: 1,
    sources: [{
      id: AUTO_DISCOVERY_SOURCE_ID,
      kind: "auto-discovery",
      enabled: AUTO_DISCOVERY_DEFAULT_ENABLED,
      createdAt: now,
      status: pendingStatus(),
    }],
  };
}

export function pendingStatus() {
  return { state: "pending", refreshedAt: null, repositoryCount: 0, message: null };
}

export function validateSources(store) {
  if (!isPlainObject(store)) throw new Error("repository sources must be an object");
  validateObjectKeys(store, ["revision", "sources", "version"], "repository sources");
  if (store.version !== SOURCES_VERSION) throw new Error(`unsupported repository sources version: ${store.version}`);
  if (!Number.isInteger(store.revision) || store.revision < 1) throw new Error("repository sources revision must be a positive integer");
  if (!Array.isArray(store.sources)) throw new Error("repository sources list must be an array");
  const ids = new Set();
  const paths = new Set();
  let builtIns = 0;
  for (const source of store.sources) {
    validateSource(source);
    if (ids.has(source.id)) throw new Error(`duplicate repository source id: ${source.id}`);
    ids.add(source.id);
    if (source.kind === "auto-discovery") builtIns += 1;
    else {
      if (paths.has(source.path)) throw new Error("duplicate repository source path");
      paths.add(source.path);
    }
  }
  if (builtIns !== 1) throw new Error("repository sources must contain exactly one auto-discovery source");
  return store;
}

function validateSource(source) {
  if (!isPlainObject(source)) throw new Error("repository source must be an object");
  validateObjectKeys(source, ["id", "kind", "path", "enabled", "createdAt", "status"], "repository source");
  if (!SOURCE_KINDS.includes(source.kind)) throw new Error("repository source kind is invalid");
  if (source.kind === "auto-discovery") {
    if (source.id !== AUTO_DISCOVERY_SOURCE_ID) throw new Error("auto-discovery source id is invalid");
    if (source.path !== undefined) throw new Error("auto-discovery source has no path");
  } else {
    safeSourceId(source.id);
    safeAbsolutePath(source.path);
  }
  if (typeof source.enabled !== "boolean") throw new Error("repository source enabled must be boolean");
  safeIsoTimestamp(source.createdAt, "repository source createdAt");
  validateStatus(source.status);
}

function validateStatus(status) {
  if (!isPlainObject(status)) throw new Error("repository source status must be an object");
  validateObjectKeys(status, ["state", "refreshedAt", "repositoryCount", "message"], "repository source status");
  if (!SOURCE_STATES.includes(status.state)) throw new Error("repository source state is invalid");
  if (status.refreshedAt != null) safeIsoTimestamp(status.refreshedAt, "repository source refreshedAt");
  if (!Number.isInteger(status.repositoryCount) || status.repositoryCount < 0) throw new Error("repository source repositoryCount is invalid");
  if (status.message != null && (typeof status.message !== "string" || status.message.length > 500)) throw new Error("repository source message is invalid");
}

// `src-` plus opaque characters: never derived from the path, so an id leaks nothing about it.
export function safeSourceId(value) {
  if (typeof value !== "string" || !/^src-[a-z0-9]{6,32}$/.test(value)) throw new Error("repository source id is invalid");
  return value;
}

// Absolute, control-character-free, no traversal segments, never trimmed — same discipline as the
// registry's localRootPaths, because a silently altered path would scan the wrong directory.
export function safeAbsolutePath(value) {
  if (typeof value !== "string" || !value || value.length > 4096) throw new Error("repository source path is invalid");
  if (/[\x00-\x1F\x7F]/.test(value)) throw new Error("repository source path is invalid");
  if (!value.startsWith("/")) throw new Error("repository source path must be absolute");
  if (value.split("/").includes("..")) throw new Error("repository source path must not contain traversal segments");
  return value;
}

function safeIsoTimestamp(value, label) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error(`${label} must be an ISO-8601 timestamp`);
  return value;
}

function validateObjectKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`unknown ${label} field: ${key}`);
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
