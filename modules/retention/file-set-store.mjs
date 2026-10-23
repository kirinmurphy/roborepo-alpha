// Retention measurement for a directory of independent files: telemetry snapshots and experiments.
//
// The second measurement shape. A log carries its own timestamps inside each record and is trimmed
// by rewriting; a file set has no records — staleness is per-file mtime, and the commit is unlink
// per file. Same policy vocabulary, same verdict shape, so a caller reads both the same way.
//
// Returns the files to remove rather than a count, because unlike a log's prefix trim, the victims
// here are not contiguous — an old file can sit between two recent ones in readdir order.

import fs from "node:fs";
import path from "node:path";
import { DAY_MS, cutoffMillis, dropCountForBytes, normalizePolicy, toMillis } from "./policy.mjs";

export function measureFileSet({
  dirPath,
  policy,
  now = new Date(),
  fsApi = fs,
  filter = isJsonFile,
} = {}) {
  const resolved = normalizePolicy(policy);

  let names;
  try {
    names = fsApi.readdirSync(dirPath).filter(filter);
  } catch {
    return { act: false, dropCount: 0, reason: "absent", files: [] };
  }
  if (names.length === 0) return { act: false, dropCount: 0, reason: "empty", files: [] };

  const entries = [];
  for (const name of names) {
    const filePath = path.join(dirPath, name);
    try {
      const stat = fsApi.statSync(filePath);
      entries.push({ filePath, bytes: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // A file that vanished between readdir and stat is already gone; nothing to retain or remove.
    }
  }
  if (entries.length === 0) return { act: false, dropCount: 0, reason: "empty", files: [] };

  // Oldest first, so the byte walk drops the least valuable files and matches the log store's
  // "oldest go first" behavior. readdir order is arbitrary and would otherwise make removal
  // nondeterministic between runs on the same data.
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);

  const doomed = new Set();
  const cutoff = cutoffMillis(resolved, now);
  if (cutoff !== null) {
    for (const entry of entries) {
      if (entry.mtimeMs < cutoff) doomed.add(entry.filePath);
    }
  }

  // Byte cap applies to what age retention left behind, mirroring the log store: age is the
  // meaningful policy, size is the backstop.
  const survivors = entries.filter((entry) => !doomed.has(entry.filePath));
  const lengths = survivors.map((entry) => entry.bytes);
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const byBytes = dropCountForBytes(lengths, total, resolved);
  for (let i = 0; i < byBytes; i += 1) doomed.add(survivors[i].filePath);

  // Never empty the set entirely — same reason as the log store's final-record guard.
  if (doomed.size === entries.length) doomed.delete(entries[entries.length - 1].filePath);

  const files = entries.map((entry) => entry.filePath).filter((filePath) => doomed.has(filePath));
  if (files.length === 0) return { act: false, dropCount: 0, reason: "within-policy", files: [] };

  const byAge = cutoff !== null && entries.some((entry) => entry.mtimeMs < cutoff);
  return {
    act: true,
    dropCount: files.length,
    reason: byAge && byBytes > 0 ? "age-and-size" : byAge ? "age" : "size",
    files,
  };
}

// Total bytes and file count for a directory, for reporting surfaces that show headroom without
// deciding anything. Kept here so `doctor` and the portal do not each re-walk a directory their own
// way and disagree about what counts.
export function describeFileSet({ dirPath, fsApi = fs, filter = isJsonFile } = {}) {
  let names;
  try {
    names = fsApi.readdirSync(dirPath).filter(filter);
  } catch {
    return { fileCount: 0, totalBytes: 0, oldestMtimeMs: null };
  }

  let totalBytes = 0;
  let oldestMtimeMs = null;
  for (const name of names) {
    try {
      const stat = fsApi.statSync(path.join(dirPath, name));
      totalBytes += stat.size;
      if (oldestMtimeMs === null || stat.mtimeMs < oldestMtimeMs) oldestMtimeMs = stat.mtimeMs;
    } catch {
      // Ignore a file that vanished mid-walk; reporting must never throw.
    }
  }
  return { fileCount: names.length, totalBytes, oldestMtimeMs };
}

// Age of the oldest file in days, or null for an empty/absent set. Reporting helper only.
export function oldestAgeDays({ dirPath, now = new Date(), fsApi = fs, filter = isJsonFile } = {}) {
  const { oldestMtimeMs } = describeFileSet({ dirPath, fsApi, filter });
  if (oldestMtimeMs === null) return null;
  return (toMillis(now) - oldestMtimeMs) / DAY_MS;
}

function isJsonFile(name) {
  return name.endsWith(".json");
}
