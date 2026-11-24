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
import path from "node:path";

export const LOCK_SCHEMA_VERSION = 1;
// The content-hash format hashPackageTree writes. The lock refuses an integrity value in any other
// format, so a copy hashed differently reads as "reinstall it" rather than as a tampered store.
export const PACKAGE_HASH_PREFIX = "sha256v2-";
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
    if (typeof record.integrity !== "string" || !record.integrity.startsWith(PACKAGE_HASH_PREFIX)) {
      throw new PackageLockError(`${label}: integrity must be a ${PACKAGE_HASH_PREFIX} hash; reinstall the package`);
    }
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
  return withPackageLock(() => {
    const valid = validateLockRecord({ installedAt: new Date().toISOString(), ...record });
    const lock = readPackageLock();
    writePackageLock({ ...lock.packages, [valid.packageId]: valid });
    return valid;
  });
}

export function removeLockRecord(packageId) {
  return withPackageLock(() => {
    const lock = readPackageLock();
    if (!lock.packages[packageId]) return false;
    const { [packageId]: _removed, ...rest } = lock.packages;
    writePackageLock(rest);
    return true;
  });
}

// Exclusive access to the package lock across processes. Every change reads the whole lock, edits
// one record and writes it back, so two overlapping CLI runs would otherwise each write their own
// copy and silently drop the other's change. Wrap a whole operation that decides from the lock and
// then writes it (look up the current record, move files, record the result) so no other process
// can change the record in between.
//
// The lock is a file created exclusively beside package-lock.json holding the owner's pid, the
// same scheme as the worktree cleanup lock. That one is asynchronous and gives up when busy;
// package-lock writes are synchronous and must wait their turn, so this is a blocking variant. A
// lock whose owner process is gone is taken over. Nested calls in the same process run inside the
// outer hold, and an async `fn` keeps the lock until its promise settles.
let heldDepth = 0;
const WAIT_MS = 10_000;
const POLL_MS = 20;

export function withPackageLock(fn, { lockPath = `${packageLockPath}.lock`, waitMs = WAIT_MS } = {}) {
  if (heldDepth > 0) return fn();
  const handle = acquireLock(lockPath, waitMs);
  heldDepth += 1;
  const release = () => {
    heldDepth -= 1;
    fs.closeSync(handle);
    fs.rmSync(lockPath, { force: true });
  };
  let result;
  try {
    result = fn();
  } catch (err) {
    release();
    throw err;
  }
  if (result && typeof result.then === "function") return Promise.resolve(result).finally(release);
  release();
  return result;
}

function acquireLock(lockPath, waitMs) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + waitMs;
  while (true) {
    let handle = openExclusive(lockPath);
    if (handle == null && staleLock(lockPath)) handle = takeOverStaleLock(lockPath);
    if (handle != null) {
      fs.writeSync(handle, `${process.pid}\n`);
      return handle;
    }
    if (Date.now() >= deadline) {
      throw new PackageLockError(`the package lock is held by another RoboRepo process (${lockPath}); try again when it finishes`);
    }
    sleepSync(POLL_MS);
  }
}

// Recheck under an exclusive marker so two contenders cannot both remove the stale file, one of
// them deleting the lock the other has just created.
function takeOverStaleLock(lockPath) {
  const marker = `${lockPath}.recover`;
  const claim = openExclusive(marker);
  if (claim == null) return null;
  try {
    if (staleLock(lockPath)) fs.rmSync(lockPath, { force: true });
  } finally {
    fs.closeSync(claim);
    fs.rmSync(marker, { force: true });
  }
  return openExclusive(lockPath);
}

function openExclusive(file) {
  try {
    return fs.openSync(file, "wx");
  } catch (err) {
    if (err?.code === "EEXIST") return null;
    throw err;
  }
}

// Only a recorded pid with no live process is stale: an empty file may belong to a process that
// has created it and not yet written its pid.
function staleLock(file) {
  let handle;
  try {
    handle = fs.openSync(file, "r");
    const pid = Number.parseInt(fs.readFileSync(handle, "utf8"), 10);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return false;
    } catch (err) {
      if (err.code !== "ESRCH") return false;
    }
    // Compare with the inode still held open, so a lock recreated meanwhile is not removed.
    const observed = fs.fstatSync(handle);
    const current = fs.lstatSync(file);
    return observed.dev === current.dev && observed.ino === current.ino;
  } catch {
    return false;
  } finally {
    if (handle != null) fs.closeSync(handle);
  }
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  Atomics.wait(sleepCell, 0, 0, ms);
}
