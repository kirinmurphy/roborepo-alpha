import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { runGitProcess } from "./git-exec.mjs";

export function removalLogPath(stateRoot) {
  return path.join(stateRoot, "worktree-cleanup", "removals.jsonl");
}

export async function withCleanupLock(stateRoot, action, { fsApi = fs, repositoryPath = null } = {}) {
  const dir = path.join(stateRoot, "worktree-cleanup");
  fsApi.mkdirSync(dir, { recursive: true });
  const repositoryKey = repositoryPath ? createHash("sha256").update(repositoryPath).digest("hex").slice(0, 16) : "global";
  const file = path.join(dir, `${repositoryKey}.lock`);
  let handle = openLock(file, fsApi);
  // A cleanup killed by a signal or a reboot never reaches `finally`, and its lock would otherwise
  // block every later run. Take over only when the recorded process is gone.
  if (handle == null && staleLock(file, fsApi)) {
    fsApi.rmSync(file, { force: true });
    handle = openLock(file, fsApi);
  }
  if (handle == null) return { locked: true, result: null };
  try {
    fsApi.writeSync(handle, `${process.pid}\n`);
    return { locked: false, result: await action() };
  } finally {
    fsApi.closeSync(handle);
    fsApi.rmSync(file, { force: true });
  }
}

function openLock(file, fsApi) {
  try {
    return fsApi.openSync(file, "wx");
  } catch (err) {
    if (err?.code === "EEXIST") return null;
    throw err;
  }
}

// An empty lock may belong to a run that has opened it but not yet written its pid, so only a
// recorded pid with no live process counts as stale.
function staleLock(file, fsApi) {
  let pid;
  try { pid = Number.parseInt(fsApi.readFileSync(file, "utf8"), 10); } catch { return false; }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err?.code === "ESRCH";
  }
}

// The tip's short SHA ends the ref, so the same branch name can be archived again at a new tip, and
// archiving `a` never blocks a later `a/b` (Git cannot hold `abandoned/a` as a ref and a directory).
// Seven characters matches the short SHA Home shows, so its confirmation names the exact ref.
export function archiveRefName(branch, tip) {
  return `refs/roborepo/abandoned/${branch}-${tip.slice(0, 7)}`;
}

export async function archiveBranchTip(mainPath, branch, tip, { runGit = runGitProcess } = {}) {
  const ref = archiveRefName(branch, tip);
  const existing = await runGit(mainPath, ["rev-parse", "--verify", ref]);
  if (existing.ok && existing.stdout.trim() !== tip) return { ok: false, reason: `archive ref already exists: ${ref}` };
  const result = await runGit(mainPath, ["update-ref", ref, tip], { timeoutMs: 10000 });
  return result.ok ? { ok: true, ref } : { ok: false, reason: result.error || "could not archive branch" };
}

export async function removeWorktree(mainPath, worktree, { kind, stateRoot, tip, runGit = runGitProcess, fsApi = fs } = {}) {
  let archiveRef = null;
  if (kind === "confirmed") {
    const archived = await archiveBranchTip(mainPath, worktree.branch || worktree.name, tip, { runGit });
    if (!archived.ok) return { ok: false, reason: archived.reason };
    archiveRef = archived.ref;
  }
  const removed = await runGit(mainPath, ["worktree", "remove", worktree.path], { timeoutMs: 120000 });
  if (!removed.ok) return { ok: false, reason: removed.error || "worktree remove failed", archiveRef };
  let branchDeleted = false;
  if (worktree.branch) {
    const branch = await runGit(mainPath, ["branch", "-D", worktree.branch], { timeoutMs: 10000 });
    branchDeleted = branch.ok;
  }
  const entry = { at: new Date().toISOString(), kind, path: worktree.path, branch: worktree.branch, commit: tip, archiveRef, branchDeleted };
  appendRemoval(stateRoot, entry, fsApi);
  return branchDeleted || !worktree.branch
    ? { ok: true, entry }
    : { ok: false, reason: "worktree removed but branch deletion failed", entry };
}

export async function removeLandedBranch(mainPath, branch, { stateRoot, tip, runGit = runGitProcess, fsApi = fs } = {}) {
  const removed = await runGit(mainPath, ["branch", "-D", branch], { timeoutMs: 10000 });
  if (!removed.ok) return { ok: false, reason: removed.error || "branch deletion failed" };
  const entry = { at: new Date().toISOString(), kind: "automatic", path: null, branch, commit: tip, archiveRef: null, branchDeleted: true };
  appendRemoval(stateRoot, entry, fsApi);
  return { ok: true, entry };
}

function appendRemoval(stateRoot, entry, fsApi) {
  const file = removalLogPath(stateRoot);
  fsApi.mkdirSync(path.dirname(file), { recursive: true });
  fsApi.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}
