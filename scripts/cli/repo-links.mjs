// Guards for live harness paths that resolve back into this checkout. An older install layout linked
// several live files and directories into the repo, and fs writes follow symlinks silently, so a
// write meant for the machine's live config would otherwise rewrite tracked source.

import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./paths.mjs";

// True when `target` (via a symlink at itself or any ancestor) resolves into `root`, even if
// the final file does not exist yet. A write through a dangling link can create that file.
export function resolvesIntoRepo(target, root = repoRoot) {
  const resolvedRoot = fs.realpathSync(root);
  let current = path.resolve(target);
  const missing = [];
  const visited = new Set();
  let real;
  while (true) {
    if (visited.has(current)) return false; // invalid symlink cycle cannot be written through
    visited.add(current);
    try {
      real = path.resolve(fs.realpathSync(current), ...missing);
      break;
    } catch {
      try {
        if (fs.lstatSync(current).isSymbolicLink()) {
          current = path.resolve(path.dirname(current), fs.readlinkSync(current));
          continue;
        }
      } catch {}
      const parent = path.dirname(current);
      if (parent === current) return false;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
  return real === resolvedRoot || real.startsWith(`${resolvedRoot}${path.sep}`);
}

// Before writing a live file: when the file itself is a symlink into the checkout, remove the link
// so the write lands in a real file at the live path. Callers compute content from the linked file
// first, so nothing it held is lost. `bundle apply` treats such links the same way
// (copyItem in presets.mjs).
export function detachRepoLink(filePath, root = repoRoot) {
  if (resolvesIntoRepo(path.dirname(filePath), root)) {
    throw new Error(`${filePath} resolves into the checkout through its parent directory`);
  }
  try {
    if (!fs.lstatSync(filePath).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  if (!resolvesIntoRepo(filePath, root)) return false;
  fs.unlinkSync(filePath);
  console.log(`detached: ${filePath} linked into the checkout; writing a real file instead`);
  return true;
}
