// The package lock: one resolution record per installed package, saying which source it came from
// and exactly what was resolved. The only module that reads or writes
// <stateRoot>/packages/package-lock.json.
//
// A record exists for every package RoboRepo installed or applied. It is the persisted source
// choice the catalog honours when two sources offer the same package ID, and the provenance
// `doctor` checks. Two kinds:
//   live          a bundled or path package, used in place. `resolved` is its folder; `fingerprint`
//                 is a content hash taken when it was recorded, so drift can be reported. Local
//                 authoring is expected to drift; the fingerprint only makes it visible.
//   materialized  a copy RoboRepo made under the managed store. `resolved` is an immutable revision
//                 (a commit SHA for git) and `integrity` the content hash of the copy.
//
// This is not a dependency lockfile: it records provenance for reproducibility, nothing more.
import { packageLockPath, writeJsonStateAtomic } from "./state-paths.mjs";
import fs from "node:fs";

export const LOCK_SCHEMA_VERSION = 1;
const KINDS = new Set(["live", "materialized"]);
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export class PackageLockError extends Error {
  constructor(message) {
    super(message);
    this.name = "PackageLockError";
  }
}

export function validateLockRecord(record) {
  const label = `package lock record ${record?.packageId || "(unknown)"}`;
  if (!record || typeof record !== "object") throw new PackageLockError("a package lock record must be an object");
  if (!SLUG_RE.test(String(record.packageId || ""))) throw new PackageLockError(`${label}: invalid packageId`);
  if (!SLUG_RE.test(String(record.sourceId || ""))) throw new PackageLockError(`${label}: invalid sourceId`);
  if (!KINDS.has(record.kind)) throw new PackageLockError(`${label}: kind must be live or materialized`);
  if (typeof record.resolved !== "string" || record.resolved === "") throw new PackageLockError(`${label}: resolved is required`);
  if (record.kind === "materialized") {
    if (typeof record.installedPath !== "string" || record.installedPath === "") throw new PackageLockError(`${label}: installedPath is required`);
    if (typeof record.integrity !== "string" || !record.integrity.startsWith("sha256-")) throw new PackageLockError(`${label}: integrity must be a sha256 hash`);
  }
  return {
    sourceId: record.sourceId,
    packageId: record.packageId,
    sourceType: record.sourceType || null,
    trust: record.trust || null,
    kind: record.kind,
    selector: record.selector ?? null,
    resolved: record.resolved,
    integrity: record.integrity ?? null,
    fingerprint: record.fingerprint ?? null,
    installedPath: record.installedPath ?? null,
    url: record.url ?? null,
    installedAt: record.installedAt || null,
  };
}

// { schemaVersion, packages: { [packageId]: record } }. A missing file is an empty lock; an
// unreadable or invalid one throws, because treating it as empty would forget every source choice.
export function readPackageLock() {
  let text;
  try {
    text = fs.readFileSync(packageLockPath, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { schemaVersion: LOCK_SCHEMA_VERSION, packages: {} };
    throw new PackageLockError(`cannot read package lock ${packageLockPath}: ${err.message}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new PackageLockError(`invalid package lock ${packageLockPath}: ${err.message}`);
  }
  if (!data || data.schemaVersion !== LOCK_SCHEMA_VERSION || typeof data.packages !== "object" || Array.isArray(data.packages)) {
    throw new PackageLockError(`package lock must contain { schemaVersion: ${LOCK_SCHEMA_VERSION}, packages: {...} }`);
  }
  const packages = {};
  for (const [id, record] of Object.entries(data.packages)) {
    const valid = validateLockRecord(record);
    if (valid.packageId !== id) throw new PackageLockError(`package lock record ${id} names package ${valid.packageId}`);
    packages[id] = valid;
  }
  return { schemaVersion: LOCK_SCHEMA_VERSION, packages };
}

function writePackageLock(packages) {
  writeJsonStateAtomic(packageLockPath, { schemaVersion: LOCK_SCHEMA_VERSION, packages });
}

export function lockRecordFor(packageId, lock = readPackageLock()) {
  return lock.packages[packageId] || null;
}

export function writeLockRecord(record) {
  const valid = validateLockRecord({ installedAt: new Date().toISOString(), ...record });
  const lock = readPackageLock();
  writePackageLock({ ...lock.packages, [valid.packageId]: valid });
  return valid;
}

export function removeLockRecord(packageId) {
  const lock = readPackageLock();
  if (!lock.packages[packageId]) return false;
  const { [packageId]: _removed, ...rest } = lock.packages;
  writePackageLock(rest);
  return true;
}
