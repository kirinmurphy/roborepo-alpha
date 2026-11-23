// The managed install store: where RoboRepo records and keeps installed packages, separate from
// the sources that offer them.
//
// A package from a live source (the built-in library or a path source) is installed by recording
// it: its folder is used in place and never copied, so user-authored content stays where the user
// put it. A package from a remote source is copied into <stateRoot>/packages/installed/ and used
// from there. Either way the lock holds the record.
//
// Removal deletes only what this module created: a lock record, and for a copied package its
// folder under the store. It never deletes a live source's folder.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { packageStoreDir } from "./state-paths.mjs";
import { isLiveSource } from "./package-sources.mjs";
import { lockRecordFor, removeLockRecord, writeLockRecord } from "./package-lock.mjs";

export const installedDir = path.join(packageStoreDir, "installed");
export const cacheDir = path.join(packageStoreDir, "cache");
export const catalogsDir = path.join(packageStoreDir, "catalogs");
const stagingDir = path.join(packageStoreDir, "staging");

// Written beside a copied package to carry what the package manifest cannot: the collection it
// belongs to in its source. Excluded from the content hash so the hash covers package files only.
export const SOURCE_METADATA_FILE = ".roborepo-source.json";
const HASH_EXCLUDED = new Set([".git", SOURCE_METADATA_FILE]);

// "sha256-<hex>" over every file's relative path and bytes, in sorted order, so the same tree
// hashes the same on every platform.
export function hashPackageTree(dir) {
  const hash = crypto.createHash("sha256");
  for (const rel of listFiles(dir)) {
    hash.update(rel.split(path.sep).join("/"));
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(dir, rel)));
    hash.update("\0");
  }
  return `sha256-${hash.digest("hex")}`;
}

function listFiles(dir, prefix = "") {
  const out = [];
  for (const entry of fs.readdirSync(path.join(dir, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (HASH_EXCLUDED.has(entry.name)) continue;
    const rel = path.join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(dir, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

// Record a live package as installed, or refresh its record. The fingerprint is retaken each time
// so drift reads as "changed since RoboRepo last applied it".
export function recordLiveInstall(pkg) {
  if (!pkg?.sourceId || !isLiveSource({ type: pkg.sourceType })) return null;
  const fingerprint = hashPackageTree(pkg.sourceRoot);
  const current = lockRecordFor(pkg.id);
  if (current && current.kind === "live" && current.sourceId === pkg.sourceId
    && current.resolved === pkg.sourceRoot && current.fingerprint === fingerprint) {
    return current;
  }
  return writeLockRecord({
    sourceId: pkg.sourceId,
    packageId: pkg.id,
    sourceType: pkg.sourceType,
    trust: pkg.trust,
    kind: "live",
    resolved: pkg.sourceRoot,
    fingerprint,
  });
}

export function installedPathFor(sourceId, revision, packageId) {
  return path.join(installedDir, sourceId, revision, packageId);
}

// Copy a package folder into the store and record it, in this order: copy to staging, verify the
// copy hashes to `resolution.integrity` (the hash refresh recorded; skipped only when a listing
// predates recorded hashes), move it into place, then write the lock record. Any failure before
// the lock write leaves the previous record and copy untouched. Returns the new lock record and
// the previous one, so the caller can remove the old copy once nothing points at it.
export function promoteMaterialized({ sourceFolder, resolution, metadata = null }) {
  const { sourceId, packageId, resolved } = resolution;
  const target = installedPathFor(sourceId, resolved, packageId);
  const previous = lockRecordFor(packageId);
  fs.mkdirSync(stagingDir, { recursive: true });
  const staged = fs.mkdtempSync(path.join(stagingDir, `${packageId}-`));
  try {
    fs.cpSync(sourceFolder, staged, { recursive: true, filter: (src) => path.basename(src) !== ".git" });
    const integrity = hashPackageTree(staged);
    if (resolution.integrity && resolution.integrity !== integrity) {
      throw new Error(`${sourceId}/${packageId}: integrity mismatch (expected ${resolution.integrity}, got ${integrity})`);
    }
    if (metadata) fs.writeFileSync(path.join(staged, SOURCE_METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`);
    if (fs.existsSync(target)) {
      // The same revision is already installed: an identical copy is reused, a different one is
      // a tampered store and refused.
      if (hashPackageTree(target) !== integrity) throw new Error(`${sourceId}/${packageId}: the installed copy at ${target} does not match its revision`);
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(staged, target);
    }
    const record = writeLockRecord({
      sourceId,
      packageId,
      sourceType: resolution.sourceType,
      trust: resolution.trust,
      kind: "materialized",
      selector: resolution.selector ?? null,
      resolved,
      url: resolution.url ?? null,
      integrity,
      installedPath: target,
    });
    return { record, previous };
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
  }
}

// Delete a copied package folder, but only one inside the store: a path from a corrupted lock must
// never send a recursive delete anywhere else.
export function deleteMaterializedCopy(installedPath) {
  if (!installedPath || !isInside(installedDir, installedPath)) return false;
  fs.rmSync(installedPath, { recursive: true, force: true });
  pruneEmptyParents(path.dirname(installedPath), installedDir);
  return true;
}

// Forget an installed package: its lock record, and its copy when RoboRepo made one. Returns what
// was removed.
export function removeInstalled(packageId) {
  const record = lockRecordFor(packageId);
  if (!record) return { removed: false, record: null, deletedCopy: false };
  removeLockRecord(packageId);
  const deletedCopy = record.kind === "materialized" ? deleteMaterializedCopy(record.installedPath) : false;
  return { removed: true, record, deletedCopy };
}

function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function pruneEmptyParents(dir, stopAt) {
  let current = dir;
  while (isInside(stopAt, current)) {
    try {
      if (fs.readdirSync(current).length > 0) return;
      fs.rmdirSync(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}
