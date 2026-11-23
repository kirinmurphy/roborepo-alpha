import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PREFIX = "roborepo-disposable-";
const SHELL_NAME = /^roborepo-disposable-(landing|preservation)-[A-Za-z0-9]+$/;
// An earlier call's folder is swept only once it has sat unchanged this long, so a concurrent
// call whose folder is still empty because its assessment has barely started is never touched.
const SHELL_MIN_AGE_MS = 60 * 60 * 1000;

// Own creation and cleanup together: callers cannot accidentally nominate a worktree for deletion.
export async function withTemporaryStorage(purpose, assess, {
  fsApi = fs, warn = (message) => console.warn(message), tmpRoot = os.tmpdir(), now = Date.now(),
} = {}) {
  if (!["landing", "preservation"].includes(purpose)) throw new Error("unsupported temporary storage purpose");
  sweepEmptyShells(tmpRoot, { fsApi, now });
  const temporary = fsApi.mkdtempSync(path.join(tmpRoot, `${PREFIX}${purpose}-`));
  const identity = fsApi.lstatSync(temporary);
  let result;
  let failure;
  try { result = await assess(temporary); }
  catch (error) { failure = error; }
  const cleanup = cleanTemporaryTree(temporary, fsApi, identity);
  const cleanupWarnings = [...(result?.cleanupWarnings || []), ...cleanup.warnings];
  for (const warning of cleanup.warnings) warn(warning.message);
  if (cleanup.errors.length) {
    const error = new AggregateError(failure ? [failure, ...cleanup.errors] : cleanup.errors,
      `${failure?.message || result?.reason || "Assessment completed"}; temporary cleanup failed at ${temporary}: ${cleanup.errors.map((item) => item.message).join("; ")}`,
      failure ? { cause: failure } : undefined);
    error.assessment = result;
    error.cleanupWarnings = cleanupWarnings;
    throw error;
  }
  if (failure) {
    failure.cleanupWarnings = cleanupWarnings;
    throw failure;
  }
  return { ...result, cleanupWarnings };
}

// When the sandbox denies removing a folder, cleanup leaves verified empty directory shells behind
// with a warning. Each later call removes the shells earlier calls left: a folder with this
// prefix, holding nothing but directories, unchanged for an hour. Removal is rmdir from the deepest
// folder up, which can only ever remove empty directories, so a folder that gained a file or link
// is left alone.
//
// A path-based rmdir follows links in every component but the last, so a shell or ancestor swapped
// for a link between a check and the rmdir would steer it into the link's target. Each removal
// therefore runs from inside the folder's parent: chdir there, confirm `.` is the directory that was
// scanned, and rmdir the bare name. The working directory holds that directory itself, not its path,
// so swapping an ancestor afterwards cannot redirect the rmdir. A parent that no longer matches
// stops that shell. Node exposes no rmdir relative to a directory handle, hence the chdir; the sweep
// is synchronous and restores the working directory before it returns, and where chdir is
// unavailable (a worker thread) it sweeps nothing. A denied removal is left silently for a later
// call; the original call already warned about it.
export function sweepEmptyShells(tmpRoot = os.tmpdir(), {
  fsApi = fs, now = Date.now(), chdir = (directory) => process.chdir(directory), cwd = () => process.cwd(),
} = {}) {
  const swept = [];
  let names;
  let root;
  try {
    names = fsApi.readdirSync(tmpRoot);
    // stat, not lstat: the scan confirms the root as `.` after chdir, which is the link's target when
    // the temp root is itself a link (macOS /tmp, os.tmpdir()'s fallback when TMPDIR is unset).
    root = fsApi.statSync(tmpRoot);
  } catch {
    return swept;
  }
  let original;
  try {
    original = cwd();
  } catch {
    return swept; // The working directory is gone; there is nowhere to come back to.
  }
  try {
    for (const name of names) {
      if (!SHELL_NAME.test(name)) continue;
      const shell = path.join(tmpRoot, name);
      const folders = emptyShellFolders(tmpRoot, root, name, fsApi, chdir);
      if (!folders || folders.some((folder) => now - folder.mtimeMs < SHELL_MIN_AGE_MS)) continue;
      const scanned = new Map(folders.map((folder) => [folder.path, folder]));
      scanned.set(tmpRoot, { dev: root.dev, ino: root.ino });
      try {
        let complete = true;
        for (const folder of folders.reverse()) {
          if (!removeFromParent(folder, scanned, fsApi, chdir)) {
            complete = false;
            break;
          }
        }
        if (complete) swept.push(shell);
      } catch {
        // Denied, changed underneath, or chdir unavailable (a worker thread); a later call tries again.
      }
    }
  } finally {
    try { chdir(original); } catch { /* The original folder went away meanwhile. */ }
  }
  return swept;
}

// rmdir `folder` by its bare name from inside its parent, once `.` is confirmed to be the scanned
// parent and the name still the scanned folder. False when either changed.
function removeFromParent(folder, scanned, fsApi, chdir) {
  const parent = scanned.get(path.dirname(folder.path));
  if (!parent) return false;
  chdir(path.dirname(folder.path));
  if (!sameDirectory(fsApi.lstatSync("."), parent)) return false;
  const name = path.basename(folder.path);
  if (!sameDirectory(fsApi.lstatSync(name), folder)) return false;
  fsApi.rmdirSync(name);
  return true;
}

function sameDirectory(stat, recorded) {
  return stat.isDirectory() && stat.dev === recorded.dev && stat.ino === recorded.ino;
}

// Every folder in the shell `name` under tmpRoot, parents before children, or null when anything
// but a directory is in it or the tree changed while it was read. The scan is confined the same way
// removal is: it enters each folder by bare name from its confirmed parent, confirms `.` is the
// folder it just checked, and lists `.`, so a folder swapped for a link mid-scan is caught rather
// than followed into the link's target. It returns to each parent through `..`, the parent of the
// folder actually entered, and confirms that too.
function emptyShellFolders(tmpRoot, rootStat, name, fsApi, chdir) {
  const folders = [];
  const visit = (directory, parentStat) => {
    // The working directory is the confirmed parent of `directory`.
    const stat = fsApi.lstatSync(path.basename(directory));
    if (!stat.isDirectory()) return false;
    chdir(path.basename(directory));
    if (!sameDirectory(fsApi.lstatSync("."), stat)) return false;
    folders.push({ path: directory, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino });
    for (const child of fsApi.readdirSync(".")) {
      if (!visit(path.join(directory, child), stat)) return false;
    }
    chdir("..");
    return sameDirectory(fsApi.lstatSync("."), parentStat);
  };
  try {
    chdir(tmpRoot);
    if (!sameDirectory(fsApi.lstatSync("."), rootStat)) return null;
    return visit(path.join(tmpRoot, name), rootStat) ? folders : null;
  } catch {
    return null; // Vanished, unreadable, or chdir unavailable: leave the shell for a later call.
  }
}

function cleanTemporaryTree(root, fsApi, identity) {
  const errors = [];
  const denied = [];
  const identities = new Map();
  const inspect = (file) => {
    try { return fsApi.lstatSync(file); }
    catch (error) { if (error.code !== "ENOENT") errors.push(error); return null; }
  };
  const walk = (directory, verify = false, expected = null) => {
    const stat = inspect(directory);
    if (!stat) return;
    const identity = `${stat.dev}:${stat.ino}`;
    if (!stat.isDirectory() || (expected && (stat.dev !== expected.dev || stat.ino !== expected.ino)) || (identities.has(directory) && identities.get(directory) !== identity)) {
      errors.push(new Error(`Temporary directory replaced or unexpected entry: ${directory}`));
      return;
    }
    identities.set(directory, identity);
    let names;
    try { names = fsApi.readdirSync(directory); }
    catch (error) { errors.push(error); return; }
    for (const name of names) {
      const file = path.join(directory, name);
      const entry = inspect(file);
      if (!entry) continue;
      if (entry.isDirectory()) walk(file, verify, entry);
      else if (!verify && (entry.isFile() || entry.isSymbolicLink())) {
        // Unlink the link itself, never its target; recursive rm could stop at a denied sibling.
        try { fsApi.unlinkSync(file); } catch (error) { errors.push(error); }
      } else errors.push(new Error(`Temporary cleanup left a file or unexpected entry: ${file}`));
    }
    if (!verify) {
      try { fsApi.rmdirSync(directory); }
      catch (error) {
        if (["EPERM", "EACCES", "ENOTEMPTY"].includes(error.code)) denied.push({ path: directory, error });
        else if (error.code !== "ENOENT") errors.push(error);
      }
    }
  };
  walk(root, false, identity);
  // A separate pass proves that blocked removals left only directory shells, not Git objects.
  walk(root, true);
  const permissionDenied = denied.some(({ error }) => ["EPERM", "EACCES"].includes(error.code));
  for (const blocked of denied) {
    if (blocked.error.code === "ENOTEMPTY" && !denied.some((child) =>
      ["EPERM", "EACCES"].includes(child.error.code) && child.path.startsWith(`${blocked.path}${path.sep}`))) errors.push(blocked.error);
  }
  const warnings = !errors.length && permissionDenied ? [{
    code: "temporary-cleanup-deferred", path: root,
    message: `Temporary cleanup deferred: only verified empty directory shells remain at ${root}; directory removal was denied. Automatic cleanup is not guaranteed.`,
  }] : [];
  return { errors, warnings };
}
