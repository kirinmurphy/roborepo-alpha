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

export function measureFolderSet({ dirPath, policy, now = new Date(), fsApi = fs } = {}) {
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
  const byBytes = dropCountForBytes(lengths, total, resolved);
  for (let i = 0; i < byBytes; i += 1) doomed.add(survivors[i].path);

  // Never empty the set entirely — the same final-entry guard the other shapes keep.
  if (doomed.size === entries.length) doomed.delete(entries[entries.length - 1].path);

  const victims = entries.filter((entry) => doomed.has(entry.path));
  if (victims.length === 0) return { act: false, dropCount: 0, reason: "within-policy", files: [], entries: [] };

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

export function describeFolderSet({ dirPath, fsApi = fs } = {}) {
  const entries = folderSetEntries({ dirPath, fsApi }) ?? [];
  let totalBytes = 0;
  let oldestMtimeMs = null;
  for (const entry of entries) {
    totalBytes += entry.bytes;
    if (oldestMtimeMs === null || entry.mtimeMs < oldestMtimeMs) oldestMtimeMs = entry.mtimeMs;
  }
  return { entryCount: entries.length, totalBytes, oldestMtimeMs };
}

export function folderAgeDays(entry, now = new Date()) {
  return (toMillis(now) - entry.mtimeMs) / DAY_MS;
}

// Remove top-level entries of the store. Each entry must sit directly inside dirPath and, once
// resolved, stay inside the resolved store: a link is unlinked as a link, and a folder that resolves
// anywhere else (a swapped parent, a mount) is refused rather than removed. fs.rmSync never follows
// links inside the tree it removes. Returns the paths removed and the ones refused or failed.
export function removeFolderSetEntries({ dirPath, paths, fsApi = fs }) {
  const removed = [];
  const refused = [];
  let root;
  try {
    root = fsApi.realpathSync(dirPath);
  } catch {
    return { removed, refused: paths.map((entryPath) => ({ path: entryPath, reason: "store missing" })) };
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
