// The `managed_files` manifest row: a directory RoboRepo shares with package installs, such as
// ~/.codex/hooks/ (core scripts beside package scripts). Each source file is copied and tracked by
// content hash, so a copy RoboRepo wrote and nobody edited can be updated or removed, an edited one
// follows the install's conflict policy, and files packages add beside them are never touched.
// shared-target-rows.mjs dispatches here and is the entry the installers call.

import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./paths.mjs";
import { managedFilesStatePath, readJsonState, writeJsonState } from "./state-paths.mjs";
import { hashFile } from "./root-config-state.mjs";
import { detachRepoLink, resolvesIntoRepo } from "./repo-links.mjs";
import { backupOriginal, findSiblingArtifact, pathExists, stageCandidate } from "./staging-lib.mjs";

export class SharedTargetConflictAbort extends Error {}

export function managedFilesInstalled(row) {
  return sourceFiles(row).every(({ target }) => pathExists(target));
}

export function managedFilesRemnants(row) {
  const recorded = readManagedFiles();
  return sourceFiles(row)
    .filter(({ source, target }) => ownedCopy(target, source, recorded))
    .map(({ target }) => target);
}

export function applyManagedFiles(row, { onConflict, dryRun }) {
  if (!dryRun && !resolvesIntoRepo(path.dirname(row.homeAbs), repoRoot)) detachRepoLink(row.homeAbs);
  if (refuseRepoLink(row.homeAbs, "install")) return;
  if (!resolveBlockingFile(row, { onConflict, dryRun })) return;
  const recorded = readManagedFiles();
  for (const { source, target } of sourceFiles(row)) {
    const current = hashFile(target);
    const wanted = hashFile(source);
    if (current === wanted) {
      console.log(`ok: ${target}`);
      if (!dryRun) recorded[target] = wanted;
      continue;
    }
    // Absent, or still exactly what RoboRepo last wrote: safe to (re)write.
    if (current === null || current === recorded[target]) {
      if (!dryRun) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        detachRepoLink(target);
        fs.copyFileSync(source, target);
        recorded[target] = wanted;
      }
      console.log(`${current === null ? "copy" : "update"}: ${target} <- ${source}`);
      continue;
    }
    if (onConflict === "abort") {
      throw new SharedTargetConflictAbort(`${target} differs from ${source} and was not written by RoboRepo; it was not changed`);
    }
    if (dryRun) {
      console.log(`conflict: ${target} differs from ${source} (${onConflict === "overwrite" ? "would back up and replace" : "would keep and stage"})`);
      continue;
    }
    if (onConflict === "overwrite") {
      console.log(`backup: ${target} -> ${backupOriginal(target)}`);
      fs.copyFileSync(source, target);
      recorded[target] = wanted;
      console.log(`copy: ${target} <- ${source}`);
    } else {
      console.log(`conflict: kept ${target}; staged RoboRepo's version at ${stageCandidate(source, target)}`);
    }
  }
  if (!dryRun) writeManagedFiles(recorded);
}

// Whether the per-file copy can go ahead. Something other than a directory at the target (a user's
// own file named `hooks`) conflicts with the whole row, so it follows the policy as a managed_copy
// would: keep stages RoboRepo's directory beside it, overwrite moves it aside first.
function resolveBlockingFile(row, { onConflict, dryRun }) {
  if (!pathExists(row.homeAbs) || fs.statSync(row.homeAbs).isDirectory()) return true;
  const source = path.join(repoRoot, row.srcRel);
  if (onConflict === "abort") throw new SharedTargetConflictAbort(`${row.homeAbs} is not a directory; it was not changed`);
  if (dryRun) {
    console.log(`conflict: ${row.homeAbs} is not a directory (${onConflict === "overwrite" ? "would back up and replace" : "would keep and stage"})`);
    return false;
  }
  if (onConflict === "overwrite") {
    console.log(`backup: ${row.homeAbs} -> ${backupOriginal(row.homeAbs)}`);
    return true;
  }
  console.log(`stage: ${stageCandidate(source, row.homeAbs)} <- ${source}`);
  return false;
}

export function removeManagedFiles(row, { dryRun }) {
  if (refuseRepoLink(row.homeAbs, "remove")) return;
  const recorded = readManagedFiles();
  const directory = pathExists(row.homeAbs) && fs.statSync(row.homeAbs).isDirectory();
  for (const { source, target } of directory ? sourceFiles(row) : []) {
    // Copies RoboRepo staged beside an edited file are RoboRepo's own.
    removeArtifact(findSiblingArtifact(target, "update"), { dryRun });
    // An edited copy stays with the user.
    if (!ownedCopy(target, source, recorded)) {
      if (!pathExists(target)) delete recorded[target];
      continue;
    }
    if (!dryRun) {
      fs.rmSync(target);
      delete recorded[target];
    }
    console.log(`remove: ${target}`);
  }
  removeArtifact(findSiblingArtifact(row.homeAbs, "update"), { dryRun });
  if (dryRun) return;
  writeManagedFiles(recorded);
  removeEmptyDirs(row.homeAbs);
  // The user's own file that an overwrite moved aside goes back once RoboRepo's copies are gone.
  const original = findSiblingArtifact(row.homeAbs, "original");
  if (original && !pathExists(row.homeAbs)) {
    fs.renameSync(original, row.homeAbs);
    console.log(`restore: ${row.homeAbs} <- ${original}`);
  }
}

function removeArtifact(artifact, { dryRun }) {
  if (!artifact) return;
  if (!dryRun) fs.rmSync(artifact, { recursive: true, force: true });
  console.log(`unlink: ${artifact}`);
}

// A legacy install could leave the target directory as a link into the checkout. apply detaches the
// link itself, as `bundle apply` does; a link further up the path is refused, because writing
// through it would edit repo sources.
function refuseRepoLink(dir, action) {
  if (!resolvesIntoRepo(dir, repoRoot)) return false;
  console.error(`refusing to ${action} ${dir}: it resolves into the repo tree (stale legacy symlink?)`);
  return true;
}

function sourceFiles(row) {
  const sourceRoot = path.join(repoRoot, row.srcRel);
  if (!pathExists(sourceRoot)) return [];
  if (!fs.statSync(sourceRoot).isDirectory()) return [{ source: sourceRoot, target: row.homeAbs }];
  return fs.readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const source = path.join(entry.parentPath ?? entry.path, entry.name);
      return { source, target: path.join(row.homeAbs, path.relative(sourceRoot, source)) };
    });
}

function removeEmptyDirs(dir) {
  if (!pathExists(dir) || !fs.lstatSync(dir).isDirectory()) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirs(path.join(dir, entry.name));
  }
  if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

// A file RoboRepo wrote and nobody edited since. Matching the source counts too, because the hash
// record can be gone (an earlier uninstall removes state) while the copy is still in place.
function ownedCopy(target, source, recorded) {
  const current = hashFile(target);
  return current !== null && (current === recorded[target] || current === hashFile(source));
}

function readManagedFiles() {
  return { ...readJsonState(managedFilesStatePath, { version: 1, files: {} }).files };
}

function writeManagedFiles(files) {
  writeJsonState(managedFilesStatePath, { version: 1, files });
}
