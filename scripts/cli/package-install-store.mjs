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
import { PACKAGE_HASH_PREFIX, lockRecordFor, removeLockRecord, withPackageLock, writeLockRecord } from "./package-lock.mjs";

export const installedDir = path.join(packageStoreDir, "installed");
export const cacheDir = path.join(packageStoreDir, "cache");
export const catalogsDir = path.join(packageStoreDir, "catalogs");
const stagingDir = path.join(packageStoreDir, "staging");

// Written beside a copied package to carry what the package manifest cannot: the collection it
// belongs to in its source. Excluded from the content hash so the hash covers package files only.
export const SOURCE_METADATA_FILE = ".roborepo-source.json";
const HASH_EXCLUDED = new Set([".git", SOURCE_METADATA_FILE]);

// "sha256v2-<hex>": SHA-256 over every entry in the tree, named by "/"-separated relative path and
// sorted by name within each folder (code-unit order, never locale order), so the same tree hashes
// the same on every platform.
// Each entry is framed as `<kind>:<path byte length>:<path><content byte length>:<content>`. The
// lengths make the framing unambiguous: without them, one file holding "x\0b\0y" hashed the same
// as two files "a" and "b", so changed contents could pass an integrity check.
//
// A symbolic link is hashed by its target text (kind "l"), so a live package's fingerprint notices
// a changed link. With `rejectLinks`, a link throws instead: a copy RoboRepo installs must be plain
// files, because a link would let the copy read content the integrity hash never covered.
export function hashPackageTree(dir, { rejectLinks = false } = {}) {
  const hash = crypto.createHash("sha256");
  for (const { rel, kind, excluded } of listEntries(dir)) {
    if (kind === "l" && rejectLinks) throw new Error(`${dir}: symbolic links are not allowed in an installed package (${rel})`);
    if (excluded) continue;
    const content = kind === "l" ? Buffer.from(fs.readlinkSync(path.join(dir, rel)), "utf8") : fs.readFileSync(path.join(dir, rel));
    const name = Buffer.from(rel, "utf8");
    hash.update(`${kind}:${name.length}:`);
    hash.update(name);
    hash.update(`${content.length}:`);
    hash.update(content);
  }
  return `${PACKAGE_HASH_PREFIX}${hash.digest("hex")}`;
}

// Files and symbolic links under `dir`, as "/"-separated relative paths in sorted order.
// A symbolic link under an excluded name is still listed, marked `excluded`: it is left out of the
// hash, but a copy that must hold no links has to see it. Otherwise a link named like the source
// metadata file would pass the check, and writing that metadata would follow the link out of the
// store.
function listEntries(dir, prefix = "") {
  const out = [];
  const entries = fs.readdirSync(prefix ? path.join(dir, ...prefix.split("/")) : dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (HASH_EXCLUDED.has(entry.name)) {
      if (entry.isSymbolicLink()) out.push({ rel, kind: "l", excluded: true });
      continue;
    }
    if (entry.isSymbolicLink()) out.push({ rel, kind: "l" });
    else if (entry.isDirectory()) out.push(...listEntries(dir, rel));
    else if (entry.isFile()) out.push({ rel, kind: "f" });
  }
  return out;
}

// Record a live package as installed, or refresh its record. The fingerprint is retaken each time
// so drift reads as "changed since RoboRepo last applied it".
export function recordLiveInstall(pkg, { replace = false } = {}) {
  if (!pkg?.sourceId || !isLiveSource({ type: pkg.sourceType })) return null;
  const fingerprint = hashPackageTree(pkg.sourceRoot);
  return withPackageLock(() => {
    const current = lockRecordFor(pkg.id);
    // Applying a local override over an installed Git copy leaves the Git record in place: the
    // override wins by catalog rule anyway, and overwriting the record would orphan the copy and
    // make `package remove <source>/<id>` unable to find it. Only an explicit install of the live
    // package (`replace`) switches the record.
    if (!replace && current?.kind === "materialized" && current.sourceId !== pkg.sourceId) return current;
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
// The whole sequence holds the package lock, so the previous record it returns is still current
// when the new one replaces it.
export function promoteMaterialized({ sourceFolder, resolution, metadata = null }) {
  return withPackageLock(() => promoteMaterializedLocked({ sourceFolder, resolution, metadata }));
}

function promoteMaterializedLocked({ sourceFolder, resolution, metadata }) {
  const { sourceId, packageId, resolved } = resolution;
  const target = installedPathFor(sourceId, resolved, packageId);
  const previous = lockRecordFor(packageId);
  fs.mkdirSync(stagingDir, { recursive: true });
  const staged = fs.mkdtempSync(path.join(stagingDir, `${packageId}-`));
  try {
    fs.cpSync(sourceFolder, staged, { recursive: true, filter: (src) => path.basename(src) !== ".git" });
    const integrity = hashPackageTree(staged, { rejectLinks: true });
    if (resolution.integrity && resolution.integrity !== integrity) {
      throw new Error(`${sourceId}/${packageId}: integrity mismatch (expected ${resolution.integrity}, got ${integrity})`);
    }
    if (metadata) fs.writeFileSync(path.join(staged, SOURCE_METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`);
    if (fs.existsSync(target)) {
      // The same revision is already installed: an identical copy is reused, a different one is
      // a tampered store and refused.
      if (hashPackageTree(target, { rejectLinks: true }) !== integrity) throw new Error(`${sourceId}/${packageId}: the installed copy at ${target} does not match its revision`);
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
  return withPackageLock(() => {
    const record = lockRecordFor(packageId);
    if (!record) return { removed: false, record: null, deletedCopy: false };
    removeLockRecord(packageId);
    const deletedCopy = record.kind === "materialized" ? deleteMaterializedCopy(record.installedPath) : false;
    return { removed: true, record, deletedCopy };
  });
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
