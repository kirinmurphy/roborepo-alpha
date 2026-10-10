import fs from "node:fs";
import path from "node:path";

// Shared timestamped-sibling staging convention. Used by install-time collision handling
// (presets.mjs) and by root-config drift handling (root-config-state.mjs) so both go through one
// staging mechanism instead of two.

export function pathExists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

export function uniquePath(target) {
  if (!pathExists(target)) return target;
  let index = 1;
  while (pathExists(`${target}.${index}`)) index += 1;
  return `${target}.${index}`;
}

export function formatTimestamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

// <name>_<tag>_<timestamp><ext>. tag is "original" (the file being replaced) or "update" (the
// candidate staged instead of being written).
export function timestampedPath(target, tag) {
  const timestamp = process.env.ROBOREPO_INSTALL_TIMESTAMP ?? formatTimestamp(new Date());
  const dir = path.dirname(target);
  const base = path.basename(target);
  if (pathExists(target) && fs.lstatSync(target).isDirectory() && !fs.lstatSync(target).isSymbolicLink()) {
    return uniquePath(path.join(dir, `${base}_${tag}_${timestamp}`));
  }
  const ext = path.extname(base);
  const name = ext ? base.slice(0, -ext.length) : base;
  return uniquePath(path.join(dir, `${name}_${tag}_${timestamp}${ext}`));
}

export function findSiblingArtifact(target, tag) {
  const dir = path.dirname(target);
  const base = path.basename(target);
  const ext = path.extname(base);
  const name = ext ? base.slice(0, -ext.length) : base;
  const prefix = `${name}_${tag}_`;
  const suffix = ext || "";

  if (!pathExists(dir)) return null;
  const matches = fs.readdirSync(dir)
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith(suffix))
    .sort()
    .map((entry) => path.join(dir, entry));
  return matches.at(-1) ?? null;
}

export function copyTree(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.lstatSync(source).isDirectory()) {
    fs.cpSync(source, target, { recursive: true, preserveTimestamps: true });
  } else {
    fs.copyFileSync(source, target);
  }
}

// Stage a repo candidate beside an existing file the user is keeping, tagged "update".
export function stageCandidate(sourcePath, targetPath) {
  const updatePath = timestampedPath(targetPath, "update");
  copyTree(sourcePath, updatePath);
  return updatePath;
}

// Move the existing file aside, tagged "original", so a new version can take its place.
export function backupOriginal(targetPath) {
  const originalPath = timestampedPath(targetPath, "original");
  fs.mkdirSync(path.dirname(originalPath), { recursive: true });
  fs.renameSync(targetPath, originalPath);
  return originalPath;
}
