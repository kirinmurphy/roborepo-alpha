// The one copy of a repository's plans: `plans/` on the remote branch `origin/repo-plans`, checked
// out in a reserved, locked linked worktree. The remote is authoritative; the worktree is a
// rebuildable checkout. This module owns finding that worktree, the repository-level lock, and
// fetch, commit, and push. It knows nothing about what a plan means: callers hand mutateStore an
// operation that reads the fresh tree and returns the files to change.
//
// A mutation holds the lock while it fetches, fast-forwards, runs the operation, commits only the
// operation's paths, and pushes. A rejected push re-runs the operation on the new remote state,
// because every operation derives its files from what is on disk, so plans-order.json is recomputed
// rather than merged. A remote that cannot be reached, or that refuses the push itself (a hook or
// branch rule), keeps the commit and reports `synchronized: false` with the reason; the next call
// that reaches it pushes pending commits first.
//
// Every Git command runs through runGitProcess, whose hardening sets core.hooksPath=/dev/null. A
// repository's code hooks cannot pass on a tree that holds only plans, and the explicit refspec
// already fixes what is pushed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resolveGitDir } from "../repositories/identity.mjs";
import { runGitProcess, runGitProcessSync } from "../repositories/git-exec.mjs";
import { RESERVED_PLANS_BRANCH, RESERVED_PLANS_LOCK_REASON, linkedWorktrees } from "../repositories/worktree-inventory.mjs";
import { domainError } from "./index.mjs";
import { LIFECYCLE_MODEL } from "./lifecycle-manifest.mjs";
import { PLANS_CONFIG_RELATIVE_PATH } from "./naming.mjs";

export const PLANS_BRANCH = RESERVED_PLANS_BRANCH;
export const PLANS_DIR = "plans";
export const PLANS_WORKTREE_NAME = "repo_plans";
export const PLANS_ORDER_RELATIVE_PATH = `${PLANS_DIR}/plans-order.json`;

const LOCAL_REF = `refs/heads/${PLANS_BRANCH}`;
const TRACKING_REF = `refs/remotes/origin/${PLANS_BRANCH}`;
const NETWORK_TIMEOUT_MS = 30_000;
const LOCAL_TIMEOUT_MS = 15_000;
const MAX_PUSH_ATTEMPTS = 4;
const LOCK_WAIT_MS = 60_000;
const LOCK_STALE_MS = 5 * 60_000;
const LOCK_FILE = "roborepo-store.lock";
// Automatic maintenance would write packed-refs and rewrite objects a sandboxed agent may only add
// to; a signing prompt would hang an unattended save.
const STORE_CONFIG = ["-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "commit.gpgsign=false"];
const NOT_SET_UP_RESOLUTION = "Run `roborepo plans init` in this repo, or /plan-suite-init to set it up with namespaces.";

// ---------------------------------------------------------------------------- locating

// The Git directories of the checkout containing `start`, walking up as Git does.
export function repositoryGitDirs(start, { fsApi = fs } = {}) {
  for (let current = path.resolve(start); ; current = path.dirname(current)) {
    const git = resolveGitDir(current, { fsApi });
    if (git) return git;
    if (path.dirname(current) === current) return null;
  }
}

// The reserved worktree of the repository containing `cwd`, or null. Found by its checked-out
// branch (or, while HEAD is off it, by its rebase or lock), never by recomputing the path, and read from Git's administrative files so a poller can
// call it without a subprocess. `missing` means Git still records the worktree but its folder is gone.
export function locateStore(cwd = process.cwd(), { fsApi = fs } = {}) {
  const git = repositoryGitDirs(cwd, { fsApi });
  if (!git) return null;
  const reserved = linkedWorktrees(git.commonDir, { fsApi, includeReserved: true }).find((worktree) => worktree.reserved);
  if (!reserved) return null;
  return {
    root: reserved.path,
    name: reserved.name,
    commonDir: git.commonDir,
    adminDir: path.join(git.commonDir, "worktrees", reserved.name),
    primary: path.dirname(git.commonDir),
    missing: Boolean(reserved.prunable),
  };
}

// Reads and writes both start here. A repository with no store is an actionable state, not zero plans.
export function requireStore(cwd = process.cwd()) {
  const store = locateStore(cwd);
  if (store && !store.missing) return store;
  if (store?.missing) {
    throw domainError("PLAN_STORE_NOT_SET_UP", "This repo's plans worktree is missing from this machine.", { resolution: "Run `roborepo plans init` to recreate it from the remote." });
  }
  if (!repositoryGitDirs(cwd)) {
    throw domainError("PLAN_NOT_FOUND", "This directory is not inside a Git repository.", { resolution: "Run the command inside a Git repository with an `origin` remote." });
  }
  throw domainError("PLAN_STORE_NOT_SET_UP", "This repo has no plans worktree yet.", { resolution: NOT_SET_UP_RESOLUTION });
}

// The plans config at a store root, or null when absent or unreadable. A caller that must tell those
// apart reads it through naming.mjs.
export function readStoreConfig(storeRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(storeRoot, PLANS_CONFIG_RELATIVE_PATH), "utf8"));
  } catch {
    return null;
  }
}

// How many local commits the remote has not accepted yet, as of the last fetch. Null when Git cannot say.
export function pendingCommitCount(store) {
  const result = runGitProcessSync(store.root, ["rev-list", "--count", `${TRACKING_REF}..${LOCAL_REF}`], { timeoutMs: LOCAL_TIMEOUT_MS });
  return result.ok ? Number(result.stdout.trim()) : null;
}

// ---------------------------------------------------------------------------- init

// Creates or reconnects `origin/repo-plans` and the reserved worktree, recovers a missing checkout, and
// pushes pending commits. Idempotent. Unlike a mutation it never reports a local-only success: it
// either ends with the remote holding the branch, or it fails with the reason.
export async function initStore({ cwd = process.cwd(), worktreeRoot = "~/.worktrees", repoName = null } = {}) {
  const git = repositoryGitDirs(cwd);
  if (!git) throw domainError("PLAN_NOT_FOUND", "This directory is not inside a Git repository.", { resolution: "Clone the repo, then run `roborepo plans init` inside it." });
  const primary = path.dirname(git.commonDir);
  const run = (args, options = {}) => runGitProcess(primary, [...STORE_CONFIG, ...args], { timeoutMs: LOCAL_TIMEOUT_MS, ...options });

  const origin = await run(["remote", "get-url", "origin"]);
  if (!origin.ok) throw initFailure("This repo has no `origin` remote, so its plans have nowhere to live.", "Add an `origin` remote, then run `roborepo plans init` again.", origin);
  const remote = await run(["ls-remote", "--heads", "origin", LOCAL_REF], { timeoutMs: NETWORK_TIMEOUT_MS });
  if (!remote.ok) throw initFailure("The `origin` remote could not be reached, so nothing was set up.", "Check the remote's address and your credentials, then run `roborepo plans init` again.", remote);

  let state = "connected";
  if (remote.stdout.trim()) {
    await fetchInto(run);
  } else if (!(await run(["rev-parse", "--verify", "-q", LOCAL_REF])).ok) {
    state = (await createRemoteBranch({ run, primary, worktreeRoot, repoName })) ? "created" : "connected";
  } else {
    // The remote lost the branch but this clone still has it: the local copy recreates it.
    const pushed = await run(["push", "origin", `${LOCAL_REF}:${LOCAL_REF}`], { timeoutMs: NETWORK_TIMEOUT_MS });
    if (!pushed.ok) throw initFailure("The plans branch could not be pushed back to `origin`, so nothing was set up.", "Check that you can push to `origin`, then run `roborepo plans init` again.", pushed);
    await run(["update-ref", TRACKING_REF, LOCAL_REF]);
    state = "created";
  }
  const { recovered, path: storePath } = await connectWorktree({ run, primary, commonDir: git.commonDir });
  if (recovered && state === "connected") state = "recovered";

  const store = requireStore(primary);
  const synced = await withStoreLock(store, () => syncRemote(store));
  if (!synced.synchronized) throw initFailure("The plans worktree exists, but its commits could not be pushed.", "Check your credentials, then run `roborepo plans init` again.", { stderr: synced.reason });
  return { ok: true, state, changed: state !== "connected" || synced.pushed > 0, path: storePath, branch: PLANS_BRANCH, synchronized: true };
}

function initFailure(message, resolution, result) {
  const detail = String(result?.stderr || result?.error || "").trim();
  return domainError("PLAN_STORE_INIT_FAILED", message, { resolution, details: detail ? [detail] : undefined });
}

async function fetchInto(run) {
  const fetched = await run(["fetch", "--no-prune", "--no-tags", "origin", `+${LOCAL_REF}:${TRACKING_REF}`], { timeoutMs: NETWORK_TIMEOUT_MS });
  if (!fetched.ok) throw initFailure("The plans branch could not be fetched.", "Check your credentials, then run `roborepo plans init` again.", fetched);
  // A local branch with pending commits is kept; only a machine without one takes the remote's.
  if (!(await run(["rev-parse", "--verify", "-q", LOCAL_REF])).ok) {
    const branched = await run(["update-ref", LOCAL_REF, TRACKING_REF]);
    if (!branched.ok) throw initFailure("The local plans branch could not be created.", "Run `git status` in the repo, resolve what it shows, then try again.", branched);
  }
}

// Builds the scaffold with plumbing, so no checkout changes branch, and pushes it before anything
// local depends on it. Returns false when another machine created the branch first and this one
// reconnected to it instead.
async function createRemoteBranch({ run, primary, worktreeRoot, repoName }) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-plans-scaffold-"));
  try {
    const plumbing = { indexFile: path.join(temporary, "index") };
    const config = { schemaVersion: 1, worktreeRoot, worktreeRepoName: repoName || path.basename(primary), namespaces: {} };
    const files = [
      [PLANS_CONFIG_RELATIVE_PATH, `${JSON.stringify(config, null, 2)}\n`],
      [PLANS_ORDER_RELATIVE_PATH, `${JSON.stringify({ schemaVersion: 1, namespaces: {} }, null, 2)}\n`],
      ...[...LIFECYCLE_MODEL.folders].map((folder) => [`${PLANS_DIR}/${folder}/.gitkeep`, ""]),
    ];
    for (const [file, content] of files) {
      const blob = await run(["hash-object", "-w", "--stdin"], { input: content });
      if (!blob.ok) throw initFailure("The plans scaffold could not be written.", "Run `git status` in the repo, resolve what it shows, then try again.", blob);
      const added = await run(["update-index", "--add", "--cacheinfo", `100644,${blob.stdout.trim()},${file}`], { plumbing });
      if (!added.ok) throw initFailure("The plans scaffold could not be written.", "Run `git status` in the repo, resolve what it shows, then try again.", added);
    }
    const tree = await run(["write-tree"], { plumbing });
    const commit = await run(["commit-tree", tree.stdout.trim(), "-m", "Create plans branch"]);
    if (!commit.ok) throw initFailure("The plans scaffold could not be committed.", "Set your Git user.name and user.email, then run `roborepo plans init` again.", commit);
    const pushed = await run(["push", "origin", `${commit.stdout.trim()}:${LOCAL_REF}`], { timeoutMs: NETWORK_TIMEOUT_MS });
    if (!pushed.ok) {
      if (isPushRace(pushed)) {
        await fetchInto(run);
        return false;
      }
      throw initFailure("The plans branch could not be pushed, so nothing was set up.", "Check that you can push to `origin`, then run `roborepo plans init` again.", pushed);
    }
    await run(["update-ref", LOCAL_REF, commit.stdout.trim()]);
    await run(["update-ref", TRACKING_REF, commit.stdout.trim()]);
    return true;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

async function connectWorktree({ run, primary, commonDir }) {
  let existing = locateStore(primary);
  if (existing && !existing.missing) return { recovered: false, path: existing.root };
  const recovered = Boolean(existing?.missing);
  if (existing) {
    // A locked worktree survives `git worktree prune` even when its folder is gone.
    await run(["worktree", "unlock", existing.root]);
    await run(["worktree", "prune"]);
  }
  const committed = await run(["show", `${LOCAL_REF}:${PLANS_CONFIG_RELATIVE_PATH}`]);
  let config;
  try {
    config = JSON.parse(committed.stdout);
  } catch {
    throw initFailure(`${PLANS_CONFIG_RELATIVE_PATH} on ${PLANS_BRANCH} cannot be read, so the plans worktree has no destination.`, "Repair the file on the remote branch, then run `roborepo plans init` again.", committed);
  }
  const destination = storeDestination(config, primary);
  assertDestinationFree(destination);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const added = await run(["worktree", "add", "--quiet", destination, PLANS_BRANCH]);
  if (!added.ok) throw initFailure("The plans worktree could not be created.", "Run `git worktree list` in the repo, resolve what it shows, then try again.", added);
  // `git worktree remove` then refuses without a double force.
  await run(["worktree", "lock", "--reason", RESERVED_PLANS_LOCK_REASON, destination]);
  existing = locateStore(primary);
  if (!existing || existing.commonDir !== commonDir) throw initFailure("The plans worktree could not be confirmed.", "Run `git worktree list` in the repo, then try again.", added);
  return { recovered, path: existing.root };
}

// The configured worktree folder as an absolute path.
export function storeRootFolder(config, primary) {
  const raw = typeof config?.worktreeRoot === "string" && config.worktreeRoot.trim() ? config.worktreeRoot.trim() : "~/.worktrees";
  return raw === "~" ? os.homedir() : raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : path.resolve(primary, raw);
}

export function storeDestination(config, primary) {
  const name = typeof config?.worktreeRepoName === "string" && config.worktreeRepoName.trim() ? config.worktreeRepoName.trim() : path.basename(primary);
  return path.join(storeRootFolder(config, primary), name, PLANS_WORKTREE_NAME);
}

// This repository's own worktree was already matched by branch, so anything at the path now belongs
// to someone else. It is never replaced or deleted.
function assertDestinationFree(destination) {
  let entries;
  try {
    entries = fs.readdirSync(destination);
  } catch (err) {
    if (err?.code === "ENOENT") return;
    throw err;
  }
  if (entries.length) {
    throw domainError("PLAN_STORE_INIT_FAILED", `${destination} is already in use, so it was left alone.`, {
      resolution: "Give this repo its own `worktreeRepoName` in plans-config.json (or pass --repo-name for a new repo), or move what is there, then run `roborepo plans init` again.",
    });
  }
}

// ---------------------------------------------------------------------------- sync

// Fetches, integrates, and pushes pending commits. Returns { synchronized, pushed, reason }. A remote
// that cannot be reached is a reported state, not an error, so a sandboxed run keeps working.
export async function refreshStore(store) {
  return withStoreLock(store, () => syncRemote(store));
}

async function syncRemote(store) {
  const fetched = await fetchRemote(store);
  if (!fetched.ok) return { synchronized: false, pushed: 0, reason: failureReason(fetched), changed: [] };
  const { changed } = await integrateRemote(store);
  const ahead = pendingCommitCount(store) || 0;
  if (!ahead) return { synchronized: true, pushed: 0, reason: null, changed };
  const pushed = await pushBranch(store);
  if (pushed.state === "pushed") return { synchronized: true, pushed: ahead, reason: null, changed };
  return { synchronized: false, pushed: 0, reason: pushed.reason, changed };
}

function fetchRemote(store) {
  return storeGit(store, ["fetch", "--no-prune", "--no-tags", "origin", `+${LOCAL_REF}:${TRACKING_REF}`], { timeoutMs: NETWORK_TIMEOUT_MS });
}

// Brings the local branch up to the fetched remote. Returns the paths the remote changed that this
// clone had not seen, which is what makes a same-plan edit from another clone detectable.
async function integrateRemote(store) {
  await assertOnPlansBranch(store);
  const local = (await required(store, ["rev-parse", LOCAL_REF])).trim();
  const remote = (await required(store, ["rev-parse", TRACKING_REF])).trim();
  if (local === remote) return { changed: [] };
  const base = (await required(store, ["merge-base", local, remote])).trim();
  if (base === remote) return { changed: [] };
  const remoteChanges = await changedPaths(store, base, remote);
  if (base === local) {
    const merged = await storeGit(store, ["merge", "--ff-only", "--quiet", TRACKING_REF]);
    if (!merged.ok) throw dirtyStoreError(store, merged);
    return { changed: remoteChanges };
  }
  // Pending commits and new remote commits. Different plans replay cleanly; the same plan is a
  // person's call, and nothing is discarded.
  const localChanges = await changedPaths(store, base, local);
  const overlap = overlappingPlans(localChanges, remoteChanges);
  if (overlap.length) throw divergedError(store, local, remote, overlap);
  await replayPending(store, local, remote);
  return { changed: remoteChanges };
}

async function replayPending(store, local, remote) {
  let step = await storeGit(store, ["rebase", "--quiet", "--no-autostash", TRACKING_REF]);
  for (let guard = 0; !step.ok && guard < 50; guard += 1) {
    const conflicts = (await required(store, ["diff", "--name-only", "--diff-filter=U"])).split("\n").filter(Boolean);
    if (conflicts.length !== 1 || conflicts[0] !== PLANS_ORDER_RELATIVE_PATH) break;
    const merged = await mergedOrderFile(store);
    if (merged === null) break;
    fs.writeFileSync(path.join(store.root, PLANS_ORDER_RELATIVE_PATH), merged);
    await required(store, ["add", "--", PLANS_ORDER_RELATIVE_PATH]);
    step = await storeGit(store, ["-c", "core.editor=true", "rebase", "--continue"]);
  }
  if (step.ok) return;
  await storeGit(store, ["rebase", "--abort"]);
  throw divergedError(store, local, remote, [PLANS_ORDER_RELATIVE_PATH]);
}

// A pending placement's closure is gone, so it cannot be re-run. Its intent is the ids it added and
// removed relative to the common ancestor, and any new order it gave the ids both sides kept, applied
// to the remote's order. Index stage 2 is the branch being rebased onto; stage 3 is the pending
// commit. Null means both sides reordered one namespace differently, which is a person's call.
async function mergedOrderFile(store) {
  const stage = async (number) => JSON.parse((await required(store, ["show", `:${number}:${PLANS_ORDER_RELATIVE_PATH}`])) || "{}");
  const [base, remote, pending] = await Promise.all([stage(1), stage(2), stage(3)]);
  const merged = mergeOrder(base, remote, pending);
  return merged && `${JSON.stringify(merged, null, 2)}\n`;
}

export function mergeOrder(base, remote, pending) {
  const namespaces = {};
  for (const namespace of new Set([...Object.keys(remote.namespaces || {}), ...Object.keys(pending.namespaces || {})])) {
    const before = base.namespaces?.[namespace] || [];
    const mine = pending.namespaces?.[namespace] || [];
    const theirs = remote.namespaces?.[namespace] || [];
    const removed = new Set(before.filter((id) => !mine.includes(id)));
    const kept = theirs.filter((id) => !removed.has(id));
    const mineReordered = !sameRelativeOrder(before, mine);
    if (mineReordered && !sameRelativeOrder(before, theirs) && !sameRelativeOrder(mine, theirs)) return null;
    // Only the pending commit reordered: its sequence wins for the ids both sides kept, and the
    // remote's additions follow, as pending additions do below.
    const ordered = mineReordered ? [...mine.filter((id) => kept.includes(id)), ...kept.filter((id) => !mine.includes(id))] : kept;
    const merged = [...ordered, ...mine.filter((id) => !before.includes(id) && !ordered.includes(id))];
    if (merged.length) namespaces[namespace] = merged;
  }
  const unpinned = new Set((base.pinned || []).filter((namespace) => !(pending.pinned || []).includes(namespace)));
  const keptPins = (remote.pinned || []).filter((namespace) => !unpinned.has(namespace));
  const pinned = [...keptPins, ...(pending.pinned || []).filter((namespace) => !(base.pinned || []).includes(namespace) && !keptPins.includes(namespace))];
  return { schemaVersion: remote.schemaVersion ?? 1, ...(pinned.length ? { pinned } : {}), namespaces };
}

// Whether the ids two lists share appear in the same order in both.
function sameRelativeOrder(a, b) {
  const shared = a.filter((id) => b.includes(id));
  return shared.join("\0") === b.filter((id) => a.includes(id)).join("\0");
}

async function pushBranch(store) {
  const pushed = await storeGit(store, ["push", "origin", `${LOCAL_REF}:${LOCAL_REF}`], { timeoutMs: NETWORK_TIMEOUT_MS });
  if (pushed.ok) {
    // A single-branch clone's fetch refspec would not move this on its own, and pending counts read it.
    await storeGit(store, ["update-ref", TRACKING_REF, LOCAL_REF]);
    return { state: "pushed", reason: null };
  }
  return isPushRace(pushed) ? { state: "raced", reason: failureReason(pushed) } : { state: "not-accepted", reason: failureReason(pushed) };
}

// Another machine pushed first ("raced"), so re-applying the change can succeed. A remote that
// refuses the push itself ("[remote rejected]", from a hook or a branch rule) would refuse every
// retry, so it is "not-accepted" like an unreachable remote.
function isPushRace(result) {
  const stderr = String(result.stderr || "");
  return !/\[remote rejected\]/i.test(stderr) && /\b(rejected|non-fast-forward|fetch first|stale info)\b/i.test(stderr);
}

function failureReason(result) {
  const lines = String(result.stderr || result.error || "the remote could not be reached").trim().split("\n");
  return (lines.find((line) => /\[remote rejected\]/i.test(line)) ?? lines[lines.length - 1]).trim();
}

// ---------------------------------------------------------------------------- mutation

// Runs one guarded write. `operation({ root, store })` reads the fresh tree and returns
//   { files: { "plans/...": text | null }, message, result }
// where null deletes a path and an empty `files` writes nothing. It may run more than once, so it
// must not write. Returns the result plus { synchronized, commit, reason }.
export async function mutateStore({ cwd = process.cwd(), store = requireStore(cwd), operation }) {
  return withStoreLock(store, async () => {
    await assertOnPlansBranch(store);
    const fetched = await fetchRemote(store);
    let unreachable = fetched.ok ? null : failureReason(fetched);
    let seen = unreachable ? [] : (await integrateRemote(store)).changed;

    for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt += 1) {
      const planned = await operation({ root: store.root, store });
      const paths = validatedPaths(planned.files);
      assertNoRemoteOverlap(paths, seen);
      let commit = null;
      if (paths.length) {
        await assertPathsClean(store, paths);
        commit = await commitFiles(store, planned, paths);
      }
      const outcome = (fields) => ({ ...planned.result, commit, ...fields });
      if (unreachable) return outcome({ synchronized: false, reason: unreachable });
      if (!(pendingCommitCount(store) || 0)) return outcome({ synchronized: true, reason: null });
      const pushed = await pushBranch(store);
      if (pushed.state === "pushed") return outcome({ synchronized: true, reason: null });
      if (pushed.state === "not-accepted") return outcome({ synchronized: false, reason: pushed.reason });

      // Another machine pushed between the fetch and the push. Set this commit aside and re-apply the
      // operation to the new state. `--keep` leaves unrelated local edits alone.
      if (commit) await required(store, ["reset", "--quiet", "--keep", "HEAD~1"]);
      const refetched = await fetchRemote(store);
      if (!refetched.ok) {
        unreachable = failureReason(refetched);
        seen = [];
        continue;
      }
      seen = (await integrateRemote(store)).changed;
    }
    throw domainError("PLAN_STORE_BUSY", "The plans branch kept changing, so this change was not saved.", { resolution: "Try again in a moment." });
  });
}

function validatedPaths(files = {}) {
  const paths = Object.keys(files);
  for (const file of paths) {
    const normalized = path.posix.normalize(file);
    if (normalized !== file || !file.startsWith(`${PLANS_DIR}/`) || file.includes("\0")) {
      throw domainError("INVALID_CHANGE", `${file} is outside the plans folder, so it was not written.`);
    }
  }
  return paths;
}

function assertNoRemoteOverlap(paths, seen) {
  const overlap = overlappingPlans(paths, seen);
  if (!overlap.length) return;
  throw domainError("PLAN_STORE_CONFLICT", "Another clone changed this plan since this clone last read it, so this change was not saved.", {
    resolution: "Read the plan again with `roborepo plans show`, reapply your edit to it, and save again. Your source file was not touched.",
    details: overlap,
  });
}

async function assertPathsClean(store, paths) {
  const status = await required(store, ["status", "--porcelain", "--untracked-files=all", "--", ...paths]);
  const dirty = status.split("\n").filter(Boolean);
  if (dirty.length) {
    throw domainError("PLAN_STORE_DIRTY", "The plans worktree has uncommitted edits to the files this change would touch.", {
      resolution: "Plans are written only through `roborepo plans` commands. Save the edit from a copy, or discard it in the plans worktree, then try again.",
      details: dirty,
    });
  }
}

async function commitFiles(store, planned, paths) {
  const before = new Map(paths.map((file) => [file, readOrNull(path.join(store.root, file))]));
  const restore = () => {
    for (const [file, content] of before) {
      const absolute = path.join(store.root, file);
      if (content === null) fs.rmSync(absolute, { force: true });
      else {
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, content);
      }
    }
  };
  try {
    for (const file of paths) {
      const absolute = path.join(store.root, file);
      const content = planned.files[file];
      if (content === null) fs.rmSync(absolute, { force: true });
      else {
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, content);
      }
    }
    await required(store, ["add", "-A", "--", ...paths]);
    // An operation that recomputes identical content, such as pinning a pinned namespace, has nothing to commit.
    if ((await storeGit(store, ["diff", "--cached", "--quiet", "--", ...paths])).ok) return null;
    await required(store, ["commit", "--quiet", "--only", "-m", planned.message, "--", ...paths]);
  } catch (err) {
    await storeGit(store, ["reset", "--quiet", "--", ...paths]);
    restore();
    throw err;
  }
  return (await required(store, ["rev-parse", "HEAD"])).trim();
}

function readOrNull(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------- shared helpers

async function assertOnPlansBranch(store) {
  const head = await storeGit(store, ["symbolic-ref", "--quiet", "HEAD"]);
  if (head.ok && head.stdout.trim() === LOCAL_REF) return;
  throw domainError("PLAN_STORE_DIVERGED", `The plans worktree is not on ${PLANS_BRANCH}, so nothing was changed.`, {
    resolution: `Finish or abort what is in progress in ${store.root} with Git, then try again.`,
  });
}

// Plans keep their filename through lifecycle moves, so two changes to one plan compare by name.
// plans-order.json is left out because every placement touches it and it is recomputed, not merged.
function overlappingPlans(left, right) {
  const key = (file) => (file.endsWith(".md") ? path.posix.basename(file) : file);
  const other = new Set(right.filter((file) => file !== PLANS_ORDER_RELATIVE_PATH).map(key));
  return left.filter((file) => file !== PLANS_ORDER_RELATIVE_PATH && other.has(key(file)));
}

async function changedPaths(store, from, to) {
  return (await required(store, ["diff", "--name-only", "--no-renames", from, to])).split("\n").filter(Boolean);
}

function divergedError(store, local, remote, overlap) {
  return domainError("PLAN_STORE_DIVERGED", "Commits on this clone and on the remote both changed the same plan, so neither was changed.", {
    resolution: `Resolve them with Git in ${store.root}: this clone has ${local.slice(0, 12)}, the remote has ${remote.slice(0, 12)}. Rebase onto ${TRACKING_REF.replace("refs/remotes/", "")}, then run \`roborepo plans init\`.`,
    details: overlap,
  });
}

function dirtyStoreError(store, result) {
  return domainError("PLAN_STORE_DIRTY", "The plans worktree could not take the remote's changes, so nothing was changed.", {
    resolution: `Plans are written only through \`roborepo plans\` commands. Discard the uncommitted edits in ${store.root}, then try again.`,
    details: [failureReason(result)],
  });
}

function storeGit(store, args, options = {}) {
  return runGitProcess(store.root, [...STORE_CONFIG, ...args], { timeoutMs: LOCAL_TIMEOUT_MS, ...options });
}

async function required(store, args, options) {
  const result = await storeGit(store, args, options);
  if (result.ok) return result.stdout;
  throw domainError("PLAN_STORE_FAILED", `git ${args[0]} failed in the plans worktree.`, {
    resolution: "Run `git status` in the plans worktree, resolve what it shows, then try again.",
    details: [failureReason(result)],
  });
}

// ---------------------------------------------------------------------------- lock

// Held for one mutation. It lives in the worktree's administrative directory so it never shows up as
// an untracked file in the plans tree, and so a sandboxed agent granted that directory can take it.
async function withStoreLock(store, run) {
  const file = path.join(store.adminDir, LOCK_FILE);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: "wx" });
      break;
    } catch (err) {
      if (err?.code !== "EEXIST") {
        throw domainError("PLAN_STORE_FAILED", "The plans worktree could not be locked.", { resolution: "Check that this session may write the repo's Git directory.", details: [err?.code || "unknown"] });
      }
      if (isStaleLock(file)) {
        fs.rmSync(file, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw domainError("PLAN_STORE_BUSY", "Another plan change is still in progress in this repo.", { resolution: "Try again in a moment." });
      await delay(100);
    }
  }
  try {
    return await run();
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function isStaleLock(file) {
  try {
    if (Date.now() - fs.statSync(file).mtimeMs > LOCK_STALE_MS) return true;
    process.kill(Number(fs.readFileSync(file, "utf8")), 0);
    return false;
  } catch (err) {
    // EPERM means the process exists under another user; only a vanished one frees the lock.
    return err?.code !== "EPERM" && err?.code !== "ENOENT";
  }
}
