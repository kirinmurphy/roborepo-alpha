// Retention measurement for a directory of independent folders: the agent scratch store.
//
// The third measurement shape. A file set judges each top-level file by its own mtime; a folder set
// judges each top-level entry as a whole. A folder's own mtime changes only when an entry directly
// inside it is added, removed, or renamed — editing a file two levels down leaves it untouched — so
// a folder's age is the newest mtime of the folder or anything under it, and its size is the total
// of the files under it. Judging by the folder's own time would expire folders still in use.
//
// Unlike the log and file-set shapes, this module also owns removal. A log's commit depends on how
// its readers hold the file, which is why those stores keep their own; a folder set has no reader
// holding a cursor, and removing a folder tree safely (never following a link out of the store) is
// the same work for every caller, so the CLI's reset and the store's own write path share it here.

import fs from "node:fs";
import path from "node:path";
import { DAY_MS, cutoffMillis, dropCountForBytes, normalizePolicy, toMillis } from "./policy.mjs";

// The byte cap never removes a folder changed this recently: another session may be writing to it
// right now. A writer that overruns the cap is stopped once its folder goes quiet for this long.
export const FOLDER_SET_BYTE_CAP_SPARE_MS = 60 * 60 * 1000;

export function measureFolderSet({
  dirPath,
  policy,
  now = new Date(),
  fsApi = fs,
  spareRecentMs = FOLDER_SET_BYTE_CAP_SPARE_MS,
} = {}) {
  const resolved = normalizePolicy(policy);
  const entries = folderSetEntries({ dirPath, fsApi });
  if (entries === null) return { act: false, dropCount: 0, reason: "absent", files: [], entries: [] };
  if (entries.length === 0) return { act: false, dropCount: 0, reason: "empty", files: [], entries: [] };

  // Oldest first, so the byte walk drops the least recently used folders, matching the other shapes.
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);

  const doomed = new Set();
  const cutoff = cutoffMillis(resolved, now);
  if (cutoff !== null) {
    for (const entry of entries) {
      if (entry.mtimeMs < cutoff) doomed.add(entry.path);
    }
  }

  // Age is the policy; the byte cap is the backstop applied to what age left behind.
  const survivors = entries.filter((entry) => !doomed.has(entry.path));
  const lengths = survivors.map((entry) => entry.bytes);
  const total = lengths.reduce((sum, length) => sum + length, 0);
  // Survivors are oldest first, so the recently changed ones form the tail the walk must stop before.
  const spareFrom = toMillis(now) - spareRecentMs;
  const removable = survivors.filter((entry) => entry.mtimeMs < spareFrom).length;
  const wanted = dropCountForBytes(lengths, total, resolved);
  const byBytes = Math.min(wanted, removable);
  for (let i = 0; i < byBytes; i += 1) doomed.add(survivors[i].path);

  // Never empty the set entirely — the same final-entry guard the other shapes keep.
  if (doomed.size === entries.length) doomed.delete(entries[entries.length - 1].path);

  const victims = entries.filter((entry) => doomed.has(entry.path));
  if (victims.length === 0) {
    // Over the cap with nothing to remove: the overage is in recently changed folders or in the
    // newest folder, which the final-entry guard keeps even past the age limit. Nothing is removed,
    // so every entry is retained and counts, not only the age survivors.
    const retained = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    const overCap = resolved.maxBytes !== null && retained > resolved.maxBytes;
    const reason = overCap ? "over cap, nothing removable" : "within-policy";
    return { act: false, dropCount: 0, reason, files: [], entries: [] };
  }

  const byAge = cutoff !== null && entries.some((entry) => entry.mtimeMs < cutoff);
  return {
    act: true,
    dropCount: victims.length,
    reason: byAge && byBytes > 0 ? "age-and-size" : byAge ? "age" : "size",
    files: victims.map((entry) => entry.path),
    entries: victims,
  };
}

// Every top-level entry with its age and size, or null when the directory is absent. A link is an
// entry of its own, measured as the link (lstat), never as what it points to.
export function folderSetEntries({ dirPath, fsApi = fs } = {}) {
  let names;
  try {
    names = fsApi.readdirSync(dirPath);
  } catch {
    return null;
  }
  const entries = [];
  for (const name of names) {
    const entryPath = path.join(dirPath, name);
    const measured = measureTree(entryPath, fsApi);
    if (measured) entries.push({ path: entryPath, name, ...measured });
  }
  return entries;
}

// sparedBytes is what the byte cap cannot remove: folders changed within spareRecentMs, and the
// newest folder, which the final-entry guard in measureFolderSet always keeps.
export function describeFolderSet({
  dirPath,
  fsApi = fs,
  now = new Date(),
  spareRecentMs = FOLDER_SET_BYTE_CAP_SPARE_MS,
} = {}) {
  const entries = folderSetEntries({ dirPath, fsApi }) ?? [];
  const spareFrom = toMillis(now) - spareRecentMs;
  let totalBytes = 0;
  let sparedBytes = 0;
  let oldestMtimeMs = null;
  let newest = null;
  for (const entry of entries) {
    totalBytes += entry.bytes;
    if (entry.mtimeMs >= spareFrom) sparedBytes += entry.bytes;
    if (oldestMtimeMs === null || entry.mtimeMs < oldestMtimeMs) oldestMtimeMs = entry.mtimeMs;
    if (newest === null || entry.mtimeMs >= newest.mtimeMs) newest = entry;
  }
  if (newest && newest.mtimeMs < spareFrom) sparedBytes += newest.bytes;
  return { entryCount: entries.length, totalBytes, sparedBytes, oldestMtimeMs };
}

export function folderAgeDays(entry, now = new Date()) {
  return (toMillis(now) - entry.mtimeMs) / DAY_MS;
}

// Remove top-level entries of the store. The store itself must be a real folder: one replaced by a
// link is refused outright, so removal never reaches the link's target. Each entry must sit directly
// inside dirPath and, once resolved, stay inside the resolved store: a link is unlinked as a link,
// and a folder that resolves anywhere else is refused rather than removed. fs.rmSync never follows
// links inside the tree it removes. Returns the paths removed and the ones refused or failed.
//
// `measured` is the verdict's entries. A folder whose newest time is later than when it was measured
// was reopened or written in between (another `roborepo scratch` call, say) and is left. This
// narrows that race to the instant between the recheck and the removal; it does not close it.
export function removeFolderSetEntries({ dirPath, paths, measured = [], fsApi = fs }) {
  const measuredAt = new Map(measured.map((entry) => [entry.path, entry.mtimeMs]));
  const removed = [];
  const refused = [];
  let root;
  try {
    if (!fsApi.lstatSync(dirPath).isDirectory()) throw new Error("not a folder");
    root = fsApi.realpathSync(dirPath);
  } catch {
    return { removed, refused: paths.map((entryPath) => ({ path: entryPath, reason: "store is missing or not a real folder" })) };
  }
  for (const entryPath of paths) {
    if (path.dirname(path.resolve(entryPath)) !== path.resolve(dirPath)) {
      refused.push({ path: entryPath, reason: "outside the store" });
      continue;
    }
    try {
      const stat = fsApi.lstatSync(entryPath);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        fsApi.unlinkSync(entryPath);
      } else {
        const real = fsApi.realpathSync(entryPath);
        if (path.dirname(real) !== root) {
          refused.push({ path: entryPath, reason: "resolves outside the store" });
          continue;
        }
        const expected = measuredAt.get(entryPath);
        if (expected !== undefined && (measureTree(entryPath, fsApi)?.mtimeMs ?? expected) > expected) {
          refused.push({ path: entryPath, reason: "changed since it was measured" });
          continue;
        }
        fsApi.rmSync(entryPath, { recursive: true, force: true });
      }
      removed.push(entryPath);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      refused.push({ path: entryPath, reason: error.code ?? error.message });
    }
  }
  return { removed, refused };
}

// Measure a folder set and remove what its policy no longer keeps, sparing the paths in `keep`
// (a folder about to be handed out). The write path of a folder-set store: `roborepo scratch`
// calls it for the scratch store, and the Claude session-start hook for the side-session notes.
export function pruneFolderSet({ dirPath, policy, keep = [], now = new Date(), fsApi = fs }) {
  const verdict = measureFolderSet({ dirPath, policy, now, fsApi });
  const paths = verdict.files.filter((entryPath) => !keep.includes(entryPath));
  if (paths.length === 0) return { removed: [], refused: [] };
  return removeFolderSetEntries({ dirPath, paths, measured: verdict.entries, fsApi });
}

// Newest mtime and total file bytes under one entry, without following links.
function measureTree(entryPath, fsApi) {
  let stat;
  try {
    stat = fsApi.lstatSync(entryPath);
  } catch {
    return null; // Vanished between readdir and lstat.
  }
  let mtimeMs = stat.mtimeMs;
  let bytes = stat.isFile() ? stat.size : 0;
  if (stat.isDirectory()) {
    let names = [];
    try {
      names = fsApi.readdirSync(entryPath);
    } catch {
      // Unreadable: judge it by what could be read.
    }
    for (const name of names) {
      const child = measureTree(path.join(entryPath, name), fsApi);
      if (!child) continue;
      if (child.mtimeMs > mtimeMs) mtimeMs = child.mtimeMs;
      bytes += child.bytes;
    }
  }
  return { mtimeMs, bytes, kind: stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "folder" : "file" };
}
