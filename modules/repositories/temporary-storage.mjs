import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Own creation and cleanup together: callers cannot accidentally nominate a worktree for deletion.
export async function withTemporaryStorage(purpose, assess, { fsApi = fs, warn = (message) => console.warn(message) } = {}) {
  if (!["landing", "preservation"].includes(purpose)) throw new Error("unsupported temporary storage purpose");
  const temporary = fsApi.mkdtempSync(path.join(os.tmpdir(), `roborepo-disposable-${purpose}-`));
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
