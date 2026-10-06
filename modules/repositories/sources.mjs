// Persistence and in-memory mutators for the repository-sources store. Server-only: source paths
// leave this module only through the protected source-management routes (pljvmyh §6).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  AUTO_DISCOVERY_SOURCE_ID,
  SOURCES_VERSION,
  USER_SOURCE_KINDS,
  defaultSources,
  pendingStatus,
  safeAbsolutePath,
  validateSources,
} from "./sources-schema.mjs";

export function sourcesPathFor(stateRoot) {
  return path.join(stateRoot, "repositories", "sources.json");
}

// A malformed or unsupported file is moved aside rather than thrown: one broken settings file must
// not take Home, Runtime, and Plans down with it. The returned `loadError` lets the management
// dialog say what happened; the user re-adds folders from there.
export function loadSources({ stateRoot, fsApi = fs } = {}) {
  const filePath = sourcesPathFor(stateRoot);
  let raw;
  try {
    raw = fsApi.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return defaultSources();
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.version !== SOURCES_VERSION) throw new Error(`unsupported repository sources version: ${parsed?.version}`);
    return validateSources(parsed);
  } catch (err) {
    const aside = `${filePath}.invalid-${Date.now()}`;
    try { fsApi.renameSync(filePath, aside); } catch {}
    return { ...defaultSources(), loadError: `Repository sources were reset: ${String(err?.message || err)}` };
  }
}

export function writeSources({ stateRoot, store, fsApi = fs } = {}) {
  const filePath = sourcesPathFor(stateRoot);
  const dir = path.dirname(filePath);
  fsApi.mkdirSync(dir, { recursive: true });
  const { loadError, ...persisted } = store;
  const temp = path.join(dir, `.sources.${process.pid}.${Date.now()}.tmp`);
  fsApi.writeFileSync(temp, `${JSON.stringify(validateSources(persisted), null, 2)}\n`);
  fsApi.renameSync(temp, filePath);
  return persisted;
}

// Read-mutate-write with a revision bump, mirroring updateRegistry. `mutate` returning false skips
// the write.
export function updateSources({ stateRoot, mutate, fsApi = fs } = {}) {
  const current = loadSources({ stateRoot, fsApi });
  const next = structuredClone(current);
  delete next.loadError;
  const changed = mutate(next);
  if (changed === false) return current;
  next.revision += 1;
  return writeSources({ stateRoot, store: next, fsApi });
}

export function findSource(store, id) {
  return store.sources.find((source) => source.id === id) || null;
}

export function autoDiscoverySource(store) {
  return findSource(store, AUTO_DISCOVERY_SOURCE_ID);
}

export function isAutoDiscoveryEnabled(store) {
  return autoDiscoverySource(store)?.enabled === true;
}

export function userSources(store) {
  return store.sources.filter((source) => source.kind !== "auto-discovery");
}

// ---- In-memory mutators (operate on a store clone; used inside updateSources) ----

export function addSource(store, { path: sourcePath, kind, now = new Date().toISOString(), id = newSourceId() }) {
  if (!USER_SOURCE_KINDS.includes(kind)) throw sourceError("INVALID_SOURCE", "Choose whether the path is a repository or a folder of repositories.");
  safeAbsolutePath(sourcePath);
  if (store.sources.some((source) => source.path === sourcePath)) {
    throw sourceError("DUPLICATE_SOURCE", "That path is already a repository source.");
  }
  const source = { id, kind, path: sourcePath, enabled: true, createdAt: now, status: pendingStatus() };
  store.sources.push(source);
  return source;
}

export function removeSource(store, id) {
  const source = requireSource(store, id);
  if (source.kind === "auto-discovery") throw sourceError("INVALID_SOURCE", "Auto-discovery cannot be removed; turn it off instead.");
  store.sources = store.sources.filter((item) => item.id !== id);
  return source;
}

export function setSourceEnabled(store, id, enabled) {
  const source = requireSource(store, id);
  if (typeof enabled !== "boolean") throw sourceError("INVALID_SOURCE", "enabled must be true or false");
  if (source.enabled === enabled) return false;
  source.enabled = enabled;
  if (!enabled) source.status = pendingStatus();
  return true;
}

export function setSourceStatus(store, id, status) {
  const source = findSource(store, id);
  if (!source) return false; // Removed while its refresh was running; nothing to record.
  source.status = { ...pendingStatus(), ...status };
  return true;
}

export function requireSource(store, id) {
  const source = findSource(store, id);
  if (!source) throw sourceError("NOT_FOUND", `unknown repository source: ${id}`);
  return source;
}

export function sourceError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function newSourceId() {
  return `src-${crypto.randomBytes(6).toString("hex")}`;
}
