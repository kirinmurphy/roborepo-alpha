import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { inventoryWorktree } from "./worktree-snapshot.mjs";
import { saveTransaction, readTransaction, deleteTransaction } from "./worktree-discard.mjs";
import { measureLog, findRetentionStore } from "../retention/index.mjs";
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

// Callers hold the repo cleanup lock and recheck guards immediately before this operation.
// An intent must be durable before Git mutates either checkout or branch.
export async function removeWorktree(mainPath, worktree, { kind, stateRoot, tip, transaction = null, authority = null, baseEvidence = null, runGit = runGitProcess, fsApi = fs } = {}) {
  if (!authority || !["proof", "all", "leftovers"].includes(authority.scope)) return { ok: false, kept: true, reason: "preservation proof or validated receipt required" };
  if (authority.scope === "proof") {
    if (!authority.fingerprint || !baseEvidence) return { ok: false, kept: true, reason: "preservation evidence required" };
    const current = await inventoryWorktree(worktree.path).catch(() => null);
    if (current?.fingerprint !== authority.fingerprint || current?.tip !== tip) return { ok: false, kept: true, reason: "state changed before removal" };
  } else if (!transaction || transaction.state !== "previewed" || transaction.digest !== authority.digest || transaction.scope !== authority.scope) {
    return { ok: false, kept: true, reason: "validated receipt required" };
  }
  if (baseEvidence) {
    const base = await runGit(mainPath, ["rev-parse", "--verify", `${baseEvidence.ref}^{commit}`]);
    if (!base.ok || base.stdout.trim() !== baseEvidence.commit) return { ok: false, kept: true, reason: "base changed before removal" };
  }
  const now = Date.now();
  const record = transaction || { id: randomUUID(), target: { repositoryId: mainPath, path: worktree.path, name: worktree.name, branch: worktree.branch, tip }, scope: "proof", evidenceCommit: authority.evidenceCommit, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 7 * 86400000).toISOString() };
  record.state = "applying";
  try { saveTransaction(stateRoot, record, fsApi); }
  catch (error) { return { ok: false, kept: true, reason: `could not record removal intent: ${error.message}` }; }
  const removed = await runGit(mainPath, ["worktree", "remove", "--force", worktree.path], { timeoutMs: 120000 });
  if (!removed.ok) return { ok: false, reason: removed.error || "worktree remove failed", outcomes: [{ step: "checkout-removed", ok: false }] };
  const outcomes = [{ step: "checkout-removed", ok: true }];
  record.state = "checkout-removed";
  try { saveTransaction(stateRoot, record, fsApi); }
  catch (error) { return { ok: false, reason: `checkout removed; transaction recording failed: ${error.message}`, entry: { branchDeleted: false }, outcomes }; }
  const branch = worktree.branch ? await retireBranch(mainPath, worktree.branch, tip, runGit) : { ok: true };
  outcomes.push({ step: "branch-retired", ok: branch.ok });
  const entry = { at: new Date().toISOString(), kind, path: worktree.path, branch: worktree.branch, commit: tip, branchDeleted: branch.ok, scope: authority.scope };
  try {
    await appendRemoval(stateRoot, entry, fsApi);
    if (branch.ok) deleteTransaction(stateRoot, record.id, fsApi);
  } catch (error) { return { ok: false, reason: `removal outcome recording failed: ${error.message}`, entry, outcomes }; }
  return { ok: branch.ok, reason: branch.ok ? null : "worktree removed but branch deletion failed", entry, outcomes };
}

export async function removeLandedBranch(mainPath, branch, { stateRoot, tip, runGit = runGitProcess, fsApi = fs } = {}) {
  const removed = await retireBranch(mainPath, branch, tip, runGit);
  if (!removed.ok) return { ok: false, reason: removed.error || "branch deletion failed" };
  const entry = { at: new Date().toISOString(), kind: "automatic", path: null, branch, commit: tip, branchDeleted: true };
  try { await appendRemoval(stateRoot, entry, fsApi); }
  catch (error) { return { ok: false, entry, reason: `branch removed; log failed: ${error.message}` }; }
  return { ok: true, entry };
}

// All repos share this log. Serialize append plus rename so compaction cannot lose another writer.
export async function appendRemoval(stateRoot, entry, fsApi = fs) {
  const deadline = Date.now() + 5000;
  while (true) {
    const locked = await withCleanupLock(stateRoot, () => {
      const file = removalLogPath(stateRoot);
      fsApi.appendFileSync(file, `${JSON.stringify(entry)}\n`);
      const store = findRetentionStore(stateRoot, "worktree-removal-log");
      const verdict = measureLog({ filePath: file, policy: store.policy, fsApi });
      if (verdict.act) {
        const kept = fsApi.readFileSync(file, "utf8").split("\n").filter((line) => line.trim()).slice(verdict.dropCount);
        const temp = `${file}.${randomUUID()}.tmp`;
        try { fsApi.writeFileSync(temp, `${kept.join("\n")}\n`); fsApi.renameSync(temp, file); }
        finally { fsApi.rmSync(temp, { force: true }); }
      }
    }, { fsApi, repositoryPath: "removal-log" });
    if (!locked.locked) return;
    if (Date.now() >= deadline) throw new Error("removal log lock wait expired");
    await new Promise((resolve) => setTimeout(resolve, 25));
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

async function retireBranch(mainPath, branch, tip, runGit) {
  const occupied = await runGit(mainPath, ["worktree", "list", "--porcelain"]);
  if (!occupied.ok || occupied.stdout.split("\n").includes(`branch refs/heads/${branch}`)) return { ok: false, error: "branch is occupied or worktree inventory unavailable" };
  return runGit(mainPath, ["update-ref", "-d", `refs/heads/${branch}`, tip], { timeoutMs: 10000 });
}

// Only a recorded successful checkout removal authorizes this narrow retry.
export async function retryBranchRetirement(mainPath, selector, { apply = false, stateRoot, runGit = runGitProcess } = {}) {
  const dir = path.join(stateRoot, "worktree-cleanup", "transactions");
  let records = [];
  try { records = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => { try { return readTransaction(stateRoot, name.slice(0, -5)); } catch { return null; } }); } catch {}
  const matches = records.filter((record) => record?.state === "checkout-removed" && (record.target?.repositoryId === mainPath || record.target?.repositoryPath === mainPath) && Date.parse(record.createdAt) + 7 * 86400000 > Date.now() && (record.target.name === selector || record.target.branch === selector));
  const kept = (reason) => ({ action: "kept", eligible: false, reason });
  if (matches.length !== 1) return kept("no unambiguous pending branch retirement; reassessment required");
  const record = matches[0], target = record.target;
  if (fs.existsSync(target.path)) return kept("checkout exists; cannot replay discard");
  const common = await runGit(mainPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  // A target path alone is not repo identity; the administrative name and branch are verified too.
  if (!common.ok || (target.repositoryId !== mainPath && target.repositoryPath !== mainPath)) return kept("pending transaction belongs to another repo");
  let branchExists = false;
  if (target.branch) {
    const occupied = await runGit(mainPath, ["worktree", "list", "--porcelain"]);
    if (!occupied.ok || occupied.stdout.split("\n").includes(`branch refs/heads/${target.branch}`)) return kept("branch occupied or inventory unavailable");
    const current = await runGit(mainPath, ["rev-parse", "--verify", `refs/heads/${target.branch}`]);
    branchExists = current.ok;
    if (branchExists && current.stdout.trim() !== target.tip) return kept("branch moved; reassessment required");
    if (!branchExists) {
      const exists = await runGit(mainPath, ["show-ref", "--verify", "--quiet", `refs/heads/${target.branch}`]);
      if (exists.code !== 1) return kept("branch state unavailable");
    }
  }
  if (!apply) return { action: "kept", eligible: true, reason: null };
  const retired = branchExists ? await retireBranch(mainPath, target.branch, target.tip, runGit) : { ok: true };
  if (!retired.ok) return kept("branch retirement failed");
  try {
    await appendRemoval(stateRoot, { at: new Date().toISOString(), branch: target.branch, outcome: target.branch ? "branch-retired" : "checkout-removed", retry: true });
    deleteTransaction(stateRoot, record.id);
  } catch (error) { return { action: "failed", reason: `cleanup recording failed: ${error.message}` }; }
  return { action: "removed", eligible: true, reason: null };
}
