import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { inventoryWorktree, listWorktreeSnapshots, readSnapshot } from "./worktree-snapshot.mjs";
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

export async function removeWorktree(mainPath, worktree, { kind, stateRoot, tip, discardChanges = false, snapshot = null, runGit = runGitProcess, fsApi = fs } = {}) {
  if (snapshot) {
    try {
      const { manifest } = await readSnapshot(mainPath, snapshot.ref);
      const current = await inventoryWorktree(worktree.path);
      if (manifest.tip !== tip || current.fingerprint !== manifest.fingerprint || current.tip !== tip) return { ok: false, reason: "snapshot no longer matches removal target", archiveRef: snapshot.ref };
    } catch (error) { return { ok: false, reason: error.message, archiveRef: snapshot.ref || null }; }
  }
  let archiveRef = snapshot?.ref || null;
  if (kind === "confirmed" && !snapshot) {
    const archived = await archiveBranchTip(mainPath, worktree.branch || worktree.name, tip, { runGit });
    if (!archived.ok) return { ok: false, reason: archived.reason };
    archiveRef = archived.ref;
  }
  const args = ["worktree", "remove"];
  if ((kind === "confirmed" && discardChanges === true) || snapshot?.ok) args.push("--force");
  args.push(worktree.path);
  const removed = await runGit(mainPath, args, { timeoutMs: 120000 });
  if (!removed.ok) return { ok: false, reason: removed.error || "worktree remove failed", archiveRef };
  if (snapshot) appendRemoval(stateRoot, { at: new Date().toISOString(), outcome: "checkout-removed", path: worktree.path, branch: worktree.branch, snapshotRef: snapshot.ref, ok: true }, fsApi);
  let branchDeleted = false;
  if (worktree.branch) {
    const branch = await retireBranch(mainPath, worktree.branch, tip, runGit);
    branchDeleted = branch.ok;
  }
  if (snapshot) appendRemoval(stateRoot, { at: new Date().toISOString(), outcome: "branch-retired", path: worktree.path, branch: worktree.branch, snapshotRef: snapshot.ref, ok: branchDeleted || !worktree.branch }, fsApi);
  const entry = { at: new Date().toISOString(), kind, path: worktree.path, branch: worktree.branch, commit: tip, archiveRef, branchDeleted, discardedChanges: discardChanges === true };
  appendRemoval(stateRoot, entry, fsApi);
  return branchDeleted || !worktree.branch
    ? { ok: true, entry }
    : { ok: false, reason: "worktree removed but branch deletion failed", entry };
}

export async function removeLandedBranch(mainPath, branch, { stateRoot, tip, runGit = runGitProcess, fsApi = fs } = {}) {
  const removed = await retireBranch(mainPath, branch, tip, runGit);
  if (!removed.ok) return { ok: false, reason: removed.error || "branch deletion failed" };
  const entry = { at: new Date().toISOString(), kind: "automatic", path: null, branch, commit: tip, archiveRef: null, branchDeleted: true };
  appendRemoval(stateRoot, entry, fsApi);
  return { ok: true, entry };
}

export function appendRemoval(stateRoot, entry, fsApi = fs) {
  const file = removalLogPath(stateRoot);
  fsApi.mkdirSync(path.dirname(file), { recursive: true });
  fsApi.appendFileSync(file, `${JSON.stringify(entry)}\n`);
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

async function retireBranch(mainPath, branch, tip, runGit) {
  const occupied = await runGit(mainPath, ["worktree", "list", "--porcelain"]);
  if (!occupied.ok || occupied.stdout.split("\n").includes(`branch refs/heads/${branch}`)) return { ok: false, error: "branch is occupied or worktree inventory unavailable" };
  return runGit(mainPath, ["update-ref", "-d", `refs/heads/${branch}`, tip], { timeoutMs: 10000 });
}

// A snapshot is also the durable checkpoint when removal succeeded but branch retirement did not.
// Retrying never recreates capture or removes a new checkout that happens to use the old branch.
export async function retryArchivedBranchRetirement(mainPath, selector, { apply = false, stateRoot, runGit = runGitProcess } = {}) {
  const candidates = (await listWorktreeSnapshots(mainPath)).filter((entry) => entry.kind === "snapshot" && (entry.branch === selector || entry.worktree?.name === selector))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const snapshot = candidates[0];
  if (!snapshot) return { action: "kept", eligible: false, reason: `worktree not found and no recovery snapshot: ${selector}` };
  const row = { path: snapshot.worktree?.path || null, branch: snapshot.branch, name: snapshot.worktree?.name || null, snapshotRef: snapshot.ref, archiveRef: snapshot.ref,
    restoreCommand: `roborepo git worktrees restore ${snapshot.id} --destination <new-path> --apply`, preservation: "remaining", state: "unknown", action: "kept", eligible: false,
    outcomes: [{ step: "snapshot-created", ok: true, reused: true }] };
  if (!row.path || fs.existsSync(row.path)) return { ...row, reason: "captured checkout still exists; inspect it before retrying" };
  row.outcomes.push({ step: "checkout-removed", ok: true, reused: true });
  const refs = await runGit(mainPath, ["worktree", "list", "--porcelain"]);
  if (!refs.ok || (snapshot.branch && refs.stdout.split("\n").includes(`branch refs/heads/${snapshot.branch}`))) return { ...row, reason: "branch became occupied; retained with existing snapshot" };
  const current = snapshot.branch ? await runGit(mainPath, ["rev-parse", "--verify", `refs/heads/${snapshot.branch}`]) : { ok: false };
  if (current.ok && current.stdout.trim() !== snapshot.tip) return { ...row, reason: "branch moved; retained with existing snapshot" };
  if (!current.ok && snapshot.branch) {
    const exists = await runGit(mainPath, ["show-ref", "--verify", "--quiet", `refs/heads/${snapshot.branch}`]);
    if (exists.code !== 1) return { ...row, reason: "branch state unavailable; retained with existing snapshot" };
  }
  row.eligible = true;
  if (!apply) return { ...row, reason: null };
  const retired = current.ok ? await retireBranch(mainPath, snapshot.branch, snapshot.tip, runGit) : { ok: true };
  row.outcomes.push({ step: "branch-retired", ok: retired.ok, reused: !current.ok });
  if (current.ok) appendRemoval(stateRoot, { at: new Date().toISOString(), outcome: "branch-retired", branch: snapshot.branch, snapshotRef: snapshot.ref, ok: retired.ok, retry: true });
  return { ...row, action: retired.ok ? "removed" : "failed", reason: retired.ok ? null : "branch retirement failed; retained with existing snapshot" };
}
