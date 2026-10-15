// Guards for live harness paths that resolve back into this checkout. An older install layout linked
// several live files and directories into the repo, and fs writes follow symlinks silently, so a
// write meant for the machine's live config would otherwise rewrite tracked source.

import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./paths.mjs";

// True when `target` (via a symlink at itself or any ancestor) resolves into `root`.
export function resolvesIntoRepo(target, root = repoRoot) {
  const resolvedRoot = fs.realpathSync(root);
  let real;
  try { real = fs.realpathSync(target); } catch { return false; } // doesn't exist yet: safe to create
  return real === resolvedRoot || real.startsWith(`${resolvedRoot}${path.sep}`);
}

// Before writing a live file: when the file itself is a symlink into the checkout, remove the link
// so the write lands in a real file at the live path. Callers compute content from the linked file
// first, so nothing it held is lost. `bundle apply` treats such links the same way
// (copyItem in presets.mjs).
export function detachRepoLink(filePath, root = repoRoot) {
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
