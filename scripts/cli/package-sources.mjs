// Package sources: the places RoboRepo finds packages. The only module that reads or writes
// <stateRoot>/package-sources.json.
//
// Every package comes from exactly one source. Two sources always exist:
//   builtin — the package library shipped inside the application (type "bundled", trust "official")
//   local   — the workspace packages folder the user authors in (type "path", trust "local")
// Further sources are added by the user: another local folder ("path") or a Git repository
// ("git"). A source's type decides which portal tab its packages land in; its trust says how far
// RoboRepo vouches for what it contains.
//
// The file is written only when the user changes a source. Until then, reads return the two
// defaults, so loading the catalog never creates state as a side effect.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appRoot, workspacePackagesDir } from "./roots.mjs";
import { packageSourcesPath, writeJsonStateAtomic } from "./state-paths.mjs";

export const SOURCE_SCHEMA_VERSION = 1;
export const BUILTIN_SOURCE_ID = "builtin";
export const LOCAL_SOURCE_ID = "local";

// "registry" is reserved for the official package registry, which a later change delivers. It is
// refused here rather than silently ignored so a hand-edited file says why it does nothing.
const SOURCE_TYPES = new Set(["bundled", "path", "git"]);
const RESERVED_SOURCE_TYPES = new Set(["registry"]);
export const TRUST_LEVELS = ["official", "local", "trusted", "unverified"];

// Bundled and path sources are read live from disk on every catalog load; a git source is read
// once into the managed store and its packages are used from there.
const LIVE_SOURCE_TYPES = new Set(["bundled", "path"]);

const TAB_BY_TYPE = { bundled: "system", path: "custom", git: "third-party" };
export const SOURCE_TABS = [
  { id: "system", label: "System" },
  { id: "custom", label: "Custom" },
  { id: "third-party", label: "Third Party" },
];

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export class PackageSourceError extends Error {
  constructor(message, { code = "invalid-source" } = {}) {
    super(message);
    this.name = "PackageSourceError";
    this.code = code;
  }
}

export function defaultSources() {
  return [
    { id: BUILTIN_SOURCE_ID, type: "bundled", enabled: true, trust: "official" },
    { id: LOCAL_SOURCE_ID, type: "path", workspace: true, enabled: true, trust: "local" },
  ];
}

export function isLiveSource(record) {
  return LIVE_SOURCE_TYPES.has(record.type);
}

export function sourceTab(record) {
  return TAB_BY_TYPE[record.type] || "third-party";
}

export function tabLabel(tabId) {
  return SOURCE_TABS.find((tab) => tab.id === tabId)?.label || tabId;
}

export function qualifiedName(sourceId, packageId) {
  return `${sourceId}/${packageId}`;
}

// "<source>/<package>" or a bare package id.
export function parsePackageReference(reference) {
  const text = String(reference || "").trim();
  const slash = text.indexOf("/");
  if (slash === -1) return { sourceId: null, packageId: text };
  return { sourceId: text.slice(0, slash), packageId: text.slice(slash + 1) };
}

// The folder a live source lists packages from. The workspace source follows the configured
// workspace root instead of storing a path, so moving the workspace never leaves a stale record.
export function sourceDirectory(record) {
  if (record.type === "bundled") return path.join(appRoot, "globals", "packages");
  if (record.type === "path") return record.workspace ? workspacePackagesDir : expandHome(record.path);
  return null;
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

export function validateSourceRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new PackageSourceError("a package source must be an object");
  const id = record.id;
  if (!SLUG_RE.test(String(id || ""))) throw new PackageSourceError(`invalid package source id: ${id || "(missing)"}`);
  if (RESERVED_SOURCE_TYPES.has(record.type)) {
    throw new PackageSourceError(`package source ${id}: type "${record.type}" is not supported yet`);
  }
  if (!SOURCE_TYPES.has(record.type)) throw new PackageSourceError(`package source ${id}: unknown type: ${record.type || "(missing)"}`);
  if (record.enabled !== undefined && typeof record.enabled !== "boolean") {
    throw new PackageSourceError(`package source ${id}: enabled must be a boolean`);
  }
  if (!TRUST_LEVELS.includes(record.trust)) throw new PackageSourceError(`package source ${id}: unknown trust: ${record.trust || "(missing)"}`);
  if ((record.type === "bundled") !== (id === BUILTIN_SOURCE_ID)) {
    throw new PackageSourceError(`package source ${id}: only the ${BUILTIN_SOURCE_ID} source is bundled with RoboRepo`);
  }
  if (record.type === "bundled" && record.trust !== "official") {
    throw new PackageSourceError(`package source ${id}: the bundled library is official`);
  }
  if (record.type === "path") {
    if (record.workspace !== true && (typeof record.path !== "string" || record.path.trim() === "")) {
      throw new PackageSourceError(`package source ${id}: a path source needs a path`);
    }
    if (!["local", "unverified"].includes(record.trust)) {
      throw new PackageSourceError(`package source ${id}: a path source is trusted as "local"`);
    }
  }
  if (record.type === "git") {
    if (typeof record.url !== "string" || record.url.trim() === "") throw new PackageSourceError(`package source ${id}: a git source needs a url`);
    if (!["trusted", "unverified"].includes(record.trust)) {
      throw new PackageSourceError(`package source ${id}: a git source is "trusted" or "unverified"`);
    }
  }
  return {
    ...record,
    enabled: record.enabled !== false,
  };
}

function validateSourceList(sources) {
  if (!Array.isArray(sources)) throw new PackageSourceError("package-sources.json must contain { schemaVersion: 1, sources: [...] }");
  const seen = new Set();
  const out = [];
  for (const record of sources) {
    const valid = validateSourceRecord(record);
    if (seen.has(valid.id)) throw new PackageSourceError(`duplicate package source id: ${valid.id}`);
    seen.add(valid.id);
    out.push(valid);
  }
  // The two default sources always exist. A file written by an older build, or edited by hand,
  // gets them back in front.
  for (const fallback of defaultSources().reverse()) {
    if (!seen.has(fallback.id)) out.unshift(fallback);
  }
  return out;
}

// { schemaVersion, sources, persisted }. Throws PackageSourceError for an unreadable or invalid
// file: a source list RoboRepo cannot trust is reported, never guessed around.
export function readSourceConfig() {
  let text;
  try {
    text = fs.readFileSync(packageSourcesPath, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { schemaVersion: SOURCE_SCHEMA_VERSION, sources: defaultSources(), persisted: false };
    throw new PackageSourceError(`cannot read package source file ${packageSourcesPath}: ${err.message}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new PackageSourceError(`invalid package source file ${packageSourcesPath}: ${err.message}`);
  }
  if (!data || data.schemaVersion !== SOURCE_SCHEMA_VERSION) {
    throw new PackageSourceError(`package-sources.json must contain { schemaVersion: ${SOURCE_SCHEMA_VERSION}, sources: [...] }`);
  }
  return { schemaVersion: SOURCE_SCHEMA_VERSION, sources: validateSourceList(data.sources), persisted: true };
}

export function writeSourceConfig(sources) {
  const valid = validateSourceList(sources);
  writeJsonStateAtomic(packageSourcesPath, { schemaVersion: SOURCE_SCHEMA_VERSION, sources: valid });
  return valid;
}

export function findSource(sourceId, sources = readSourceConfig().sources) {
  return sources.find((record) => record.id === sourceId) || null;
}
