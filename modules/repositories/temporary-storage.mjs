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
// is left alone. Before each removal the folder and every ancestor up to the shell must still be the
// directory that was scanned: a shell or ancestor replaced by a link in between would otherwise
// steer rmdir into the link's target, so that shell is left. A denied removal is left silently for
// a later call; the original call already warned about it.
export function sweepEmptyShells(tmpRoot = os.tmpdir(), { fsApi = fs, now = Date.now() } = {}) {
  const swept = [];
  let names;
  try {
    names = fsApi.readdirSync(tmpRoot);
  } catch {
    return swept;
  }
  for (const name of names) {
    if (!SHELL_NAME.test(name)) continue;
    const shell = path.join(tmpRoot, name);
    const folders = emptyShellFolders(shell, fsApi);
    if (!folders || folders.some((folder) => now - folder.mtimeMs < SHELL_MIN_AGE_MS)) continue;
    const scanned = new Map(folders.map((folder) => [folder.path, folder]));
    try {
      let complete = true;
      for (const folder of folders.reverse()) {
        if (!chainUnchanged(folder.path, shell, scanned, fsApi)) {
          complete = false;
          break;
        }
        fsApi.rmdirSync(folder.path);
      }
      if (complete) swept.push(shell);
    } catch {
      // Denied or changed underneath; the next call tries again.
    }
  }
  return swept;
}

// True when `folder` and each ancestor up to `shell` is still the real directory that was scanned.
function chainUnchanged(folder, shell, scanned, fsApi) {
  for (let current = folder; ; current = path.dirname(current)) {
    const recorded = scanned.get(current);
    let stat;
    try { stat = fsApi.lstatSync(current); } catch { return false; }
    if (!recorded || !stat.isDirectory() || stat.dev !== recorded.dev || stat.ino !== recorded.ino) return false;
    if (current === shell) return true;
  }
}

// Every folder in the tree, parents before children, or null when anything but a directory is in it.
function emptyShellFolders(root, fsApi) {
  const folders = [];
  const visit = (directory) => {
    let stat;
    try { stat = fsApi.lstatSync(directory); } catch { return false; }
    if (!stat.isDirectory()) return false;
    folders.push({ path: directory, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino });
    let names;
    try { names = fsApi.readdirSync(directory); } catch { return false; }
    return names.every((name) => visit(path.join(directory, name)));
  };
  return visit(root) ? folders : null;
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
