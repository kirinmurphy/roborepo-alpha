import path from "node:path";
import { assessWorktreePreservation } from "../../modules/repositories/worktree-preservation.mjs";
import { createWorktreeSnapshot, inventoryWorktree, listWorktreeSnapshots, restoreWorktreeSnapshot } from "../../modules/repositories/worktree-snapshot.mjs";
import { discoverInstances } from "../../modules/developer-runtime/discovery.mjs";
import { stopCheckoutServers } from "../../modules/developer-runtime/stop.mjs";
import { findProjectRoot, mainCheckoutPath, resolveGitDir } from "../../modules/repositories/identity.mjs";
import { linkedWorktrees } from "../../modules/repositories/worktree-inventory.mjs";
import { inspectBranchLanding } from "../../modules/repositories/worktree-landed.mjs";
import { checkWorktreeRemoval } from "../../modules/repositories/worktree-guards.mjs";
import { appendRemoval, removeLandedBranch, removeWorktree, withCleanupLock } from "../../modules/repositories/worktree-removal.mjs";
import { runGitProcess } from "../../modules/repositories/git-exec.mjs";
import { checkoutRootsFor, loadRegistry } from "../../modules/repositories/registry.mjs";
import { activeWorktreeNames, findPlanAbsorbingCommit, findPlanWorktree, repositoryRecordFor, worktreeFolder } from "./worktree-policy.mjs";
import { STATE_ROOT } from "./paths.mjs";

export async function cleanupWorktrees({ cwd = process.cwd(), stateRoot = STATE_ROOT, apply = false, plan = null, base = "main", remove = null, confirm = false, discardChanges = false, archive = false, currentPath = cwd, discover = discoverInstances } = {}) {
  const mainPath = mainCheckout(cwd);
  if (!mainPath) throw new Error("a non-bare Git checkout is required");
  const gitDir = path.join(mainPath, ".git");
  const worktreeRoot = worktreeFolder(mainPath, repositoryRecordFor(loadRegistry({ stateRoot }), mainPath));
  const scopedName = plan ? findPlanWorktree(mainPath, plan) : null;
  const recorded = plan ? findPlanAbsorbingCommit(mainPath, plan) : null;
  // A plan closes against the local base branch, so its cleanup checks landing there too. The
  // absorbing commit is often still unpushed when /plan-close runs, and `origin/HEAD` would miss it.
  const landingBase = plan ? `refs/heads/${base}` : null;
  if (plan && !scopedName) throw new Error(`plan not found or has no worktree: ${plan}`);
  const worktrees = linkedWorktrees(gitDir);
  const selectedBranch = remove;
  if (archive && !remove) throw new Error("archive requires one selected worktree");
  if (remove && !confirm) throw new Error("confirmed removal requires --confirm");
  if (selectedBranch && !worktrees.some((item) => item.branch === selectedBranch || item.name === selectedBranch)) throw new Error(`worktree not found: ${selectedBranch}`);
  const action = async () => {
    const running = await runningPaths(discover);
    const activePlans = activeWorktreeNames(mainPath);
    const rows = [];
    for (const worktree of worktrees) {
      if (scopedName && worktree.name !== scopedName) continue;
      if (selectedBranch && worktree.branch !== selectedBranch && worktree.name !== selectedBranch) continue;
      const kind = remove ? "confirmed" : "automatic";
      const surveyTip = await worktreeTip(mainPath, worktree);
      let preservation = null;
      if (!remove || archive) preservation = await assessWorktreePreservation(worktree.path, { branch: worktree.branch, base: landingBase, recorded });
      const landing = preservation?.landing || (worktree.branch ? await inspectBranchLanding(mainPath, worktree.branch, { base: landingBase, recorded }) : { landed: false, reason: "detached" });
      const guard = await checkWorktreeRemoval({
        worktree, kind, landed: landing.landed, worktreeRoot, mainPath, currentPath,
        activePlan: activePlans.has(worktree.name), running: running.has(worktree.path), discardChanges,
        verifiedSnapshot: Boolean(archive && preservation?.fingerprint) || preservation?.state === "preserved",
      });
      if (!remove && preservation?.state !== "preserved") { guard.ok = false; guard.reason = preservation?.reason || "preservation unknown"; }
      if (archive && !preservation?.fingerprint) { guard.ok = false; guard.reason = preservation?.reason || "snapshot inventory unavailable"; }
      const row = { preservation: preservation?.state || null, remainingPaths: preservation?.remainingPaths || [], blockingPaths: preservation?.blockingPaths || [], assessedTip: preservation?.tip || surveyTip, assessedBase: preservation?.baseCommit || null, evidenceCommit: preservation?.evidenceCommit || null, snapshotRef: null, restoreCommand: null, outcomes: [], path: worktree.path, name: worktree.name, branch: worktree.branch, state: landing.landed ? "landed" : landing.reason === "scan unavailable" ? "unknown" : "not landed", eligible: guard.ok, reason: landing.reason === "scan unavailable" ? "landed scan unavailable" : guard.reason, warning: guard.warning, landingEvidence: landing.landed ? (landing.reused ? "reused" : "scanned") : null, action: "kept" };
      if (apply && guard.ok) {
        let snapshot = null;
        if (archive || preservation?.hasLocalContent) {
          snapshot = await createWorktreeSnapshot(worktree.path, { expectedFingerprint: preservation.fingerprint });
          if (!snapshot.ok) { row.outcomes.push({ step: "snapshot-created", ok: false, reason: snapshot.reason }); row.eligible = false; row.reason = snapshot.reason; rows.push(row); continue; }
          row.archiveRef = snapshot.ref;
          row.snapshotRef = snapshot.ref;
          appendRemoval(stateRoot, { at: new Date().toISOString(), kind: archive ? "archive" : "automatic", outcome: "snapshot-created", path: worktree.path, branch: worktree.branch, snapshotRef: snapshot.ref });
          row.outcomes.push({ step: "snapshot-created", ok: true, ref: snapshot.ref });
          row.restoreCommand = snapshot.restoreCommand;
        }
        if (preservation?.fingerprint) {
          const current = await inventoryWorktree(worktree.path).catch(() => null);
          const baseState = preservation.baseCommit ? await runGitProcess(mainPath, ["rev-parse", preservation.baseRef]) : null;
          if (current?.fingerprint !== preservation.fingerprint || (baseState && (!baseState.ok || baseState.stdout.trim() !== preservation.baseCommit))) {
            row.eligible = false; row.reason = "state changed after assessment"; rows.push(row); continue;
          }
        }
        const fresh = linkedWorktrees(gitDir).find((item) => item.name === worktree.name);
        const freshTip = fresh ? await worktreeTip(mainPath, fresh) : null;
        if (!fresh || fresh.path !== worktree.path || fresh.branch !== worktree.branch || !freshTip || freshTip !== surveyTip) {
          row.reason = "Git state changed after survey";
          row.eligible = false;
        } else {
          const rechecked = await checkWorktreeRemoval({
            worktree: fresh, kind, landed: landing.landed, worktreeRoot, mainPath, currentPath,
            activePlan: activeWorktreeNames(mainPath).has(fresh.name), running: (await runningPaths(discover)).has(fresh.path), discardChanges,
            verifiedSnapshot: Boolean(snapshot?.ok),
          });
          if (!rechecked.ok) { row.reason = rechecked.reason; row.eligible = false; }
          else {
            if (snapshot) {
              const last = await inventoryWorktree(fresh.path).catch(() => null);
              if (last?.fingerprint !== snapshot.fingerprint) { row.reason = "state changed before removal"; row.eligible = false; rows.push(row); continue; }
            }
            const result = await removeWorktree(mainPath, fresh, { kind, stateRoot, tip: freshTip, discardChanges, snapshot });
            row.outcomes.push({ step: "checkout-removed", ok: Boolean(result.entry) }, { step: "branch-retired", ok: Boolean(result.entry?.branchDeleted) });
            row.action = result.ok ? "removed" : "failed";
            row.reason = result.reason || null;
            row.archiveRef = result.entry?.archiveRef || result.archiveRef || null;
          }
        }
      }
      rows.push(row);
    }
    if (!selectedBranch && !scopedName) rows.push(...await cleanupDetachedBranches(mainPath, worktrees, { apply, stateRoot }));
    return rows;
  };
  if (!apply && !selectedBranch) return action();
  const lock = await withCleanupLock(stateRoot, action, { repositoryPath: mainPath });
  return lock.locked ? [{ action: "kept", reason: "cleanup already running" }] : lock.result;
}

function mainCheckout(cwd) {
  const projectRoot = findProjectRoot(cwd);
  const git = projectRoot ? resolveGitDir(projectRoot) : null;
  if (!git || path.basename(git.commonDir) !== ".git") return null;
  const main = path.dirname(git.commonDir);
  return resolveGitDir(main)?.commonDir === git.commonDir ? main : null;
}

async function runningPaths(discover) {
  const result = await discover();
  if (!Array.isArray(result?.instances)) throw new Error("running process discovery unavailable; cleanup kept all worktrees");
  return new Set(result.instances.map((instance) => instance.project?.projectRoot).filter(Boolean));
}

async function worktreeTip(mainPath, worktree) {
  const result = await runGitProcess(mainPath, ["rev-parse", worktree.branch ? `refs/heads/${worktree.branch}` : worktree.detachedCommit]);
  return result.ok ? result.stdout.trim() : null;
}

async function cleanupDetachedBranches(mainPath, worktrees, { apply, stateRoot }) {
  const refs = await runGitProcess(mainPath, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  if (!refs.ok) return [];
  const occupied = new Set(worktrees.map((item) => item.branch).filter(Boolean));
  const current = await runGitProcess(mainPath, ["symbolic-ref", "--short", "HEAD"]);
  if (current.ok) occupied.add(current.stdout.trim());
  for (const base of ["main", "master"]) occupied.add(base);
  const rows = [];
  for (const branch of refs.stdout.trim().split("\n").filter((name) => name && !occupied.has(name))) {
    const landing = await inspectBranchLanding(mainPath, branch);
    if (!landing.landed) continue;
    const row = { path: null, name: null, branch, state: "landed", eligible: true, reason: null, action: "kept" };
    if (apply) {
      const fresh = await runGitProcess(mainPath, ["rev-parse", `refs/heads/${branch}`]);
      if (!fresh.ok || fresh.stdout.trim() !== landing.tip || linkedWorktrees(path.join(mainPath, ".git")).some((item) => item.branch === branch)) {
        row.action = "kept"; row.reason = "Git state changed after survey";
      } else {
        const result = await removeLandedBranch(mainPath, branch, { stateRoot, tip: landing.tip });
        row.action = result.ok ? "removed" : "failed";
        row.reason = result.reason || null;
      }
    }
    rows.push(row);
  }
  return rows;
}

export async function worktreeCleanupCommand(args) {
  const options = { apply: false, confirm: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (["--plan", "--base", "--remove", "--current"].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      options[arg === "--current" ? "currentPath" : arg.slice(2)] = value;
    }
    else if (["--apply", "--confirm", "--json"].includes(arg)) options[arg.slice(2)] = true;
    else throw new Error(`unknown cleanup option: ${arg}`);
  }
  const rows = await cleanupWorktrees(options);
  if (options.json) console.log(JSON.stringify(rows, null, 2));
  // A dry run keeps everything; name the rows `--apply` would remove so they read differently from
  // rows a guard blocked.
  else for (const row of rows) {
    const action = row.action === "kept" && row.eligible ? "eligible" : row.action;
    console.log(`${row.branch || row.name || "worktree"}: ${action} (${row.state || "unknown"})${row.reason ? ` — ${row.reason}` : ""}`);
  }
  if (options.apply && ((options.remove && rows.some((row) => row.action !== "removed")) || rows.some((row) => row.action === "failed"))) process.exitCode = 1;
  return rows;
}

// Home's Delete Worktree: confirmed removal of one worktree, through the same guards as the command.
// Deleting stops the worktree's dev servers first, but only once every other guard has passed, so a
// deletion refused by another safety guard never stops anything. Dirty deletion requires
// explicit consent to discard local changes; the archive preserves committed work only.
export async function removeRepositoryWorktree({ repositoryId, branch, discardChanges = false, stateRoot = STATE_ROOT, stop = stopCheckoutServers, discover = discoverInstances }) {
  const { main, worktree } = repositoryWorktree(repositoryId, branch, stateRoot);
  const options = { cwd: main, stateRoot, remove: branch, confirm: true, discardChanges: discardChanges === true };
  const [preview] = await cleanupWorktrees({ ...options, discover: async () => ({ instances: [] }) });
  if (!preview?.eligible) {
    if (preview?.reason === "uncommitted or untracked changes") return { ...preview, requiresDiscardConfirmation: true };
    return preview || { action: "kept", reason: "worktree unavailable" };
  }
  const stopped = await stop(worktree.path);
  if (!stopped.ok) return { action: "kept", reason: serversStillRunning(stopped) };
  const rows = await cleanupWorktrees({ ...options, apply: true, discover });
  const result = rows[0] || { action: "kept", reason: "worktree unavailable" };
  if (result.reason === "uncommitted or untracked changes") return { ...result, requiresDiscardConfirmation: true };
  return result;
}

// Home's Stop Server: SIGTERM the dev servers listening from one worktree, as /plan-close does.
export async function stopRepositoryWorktreeServers({ repositoryId, branch, stateRoot = STATE_ROOT, stop = stopCheckoutServers }) {
  const { worktree } = repositoryWorktree(repositoryId, branch, stateRoot);
  const result = await stop(worktree.path);
  return result.ok
    ? { action: "stopped", stopped: result.servers.filter((server) => server.result === "stopped").length, reason: null }
    : { action: "kept", reason: serversStillRunning(result) };
}

function repositoryWorktree(repositoryId, branch, stateRoot) {
  if (typeof branch !== "string" || !branch) throw new Error("a worktree branch is required");
  const main = repositoryMainCheckout(repositoryId, stateRoot);
  const worktree = linkedWorktrees(path.join(main, ".git")).find((item) => item.branch === branch || item.name === branch);
  if (!worktree || worktree.prunable) throw new Error(`worktree not found: ${branch}`);
  return { main, worktree };
}

function serversStillRunning(result) {
  const pids = result.servers.filter((server) => ["still-running", "failed"].includes(server.result)).map((server) => server.pid);
  return `${pids.length === 1 ? "a server" : `${pids.length} servers`} did not stop (pid ${pids.join(", ")})`;
}

export function repositoryMainCheckout(repositoryId, stateRoot = STATE_ROOT) {
  const registry = loadRegistry({ stateRoot });
  if (!registry.repositories?.[repositoryId]) throw new Error("unknown repository");
  const main = mainCheckoutPath(checkoutRootsFor(registry, repositoryId).map((root) => root.path));
  if (!main) throw new Error("main checkout unavailable");
  return main;
}

export async function worktreeArchiveCommand(args) {
  const action = args[0];
  const options = { apply: false, confirm: false, json: false };
  const positional = [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (["--apply", "--confirm", "--json"].includes(arg)) options[arg.slice(2)] = true;
    else if (arg === "--destination") {
      options.destination = args[++i];
      if (!options.destination || options.destination.startsWith("--")) throw new Error("--destination needs a path");
    } else if (arg.startsWith("--")) throw new Error(`unknown option: ${arg}`);
    else positional.push(arg);
  }
  let result;
  if (action === "archives") {
    if (options.apply || options.confirm || positional.length || options.destination) throw new Error("archives is read-only");
    result = await listWorktreeSnapshots(process.cwd());
  } else if (action === "restore") {
    if (positional.length !== 1 || !options.destination) throw new Error("restore requires an archive id and --destination");
    result = await restoreWorktreeSnapshot(process.cwd(), positional[0], options.destination, options);
  } else if (action === "archive-remove") {
    if (positional.length !== 1) throw new Error("archive-remove requires a branch or worktree name");
    if (options.apply && !options.confirm) throw new Error("archive-remove --apply requires --confirm; stop writers before confirming");
    result = await cleanupWorktrees({ remove: positional[0], archive: true, confirm: true, apply: options.apply });
  } else throw new Error(`unknown archive action: ${action}`);
  console.log(JSON.stringify(result, null, 2));
  if (options.apply && (Array.isArray(result) ? result.some((row) => row.action !== "removed") : !result.ok)) process.exitCode = 1;
  return result;
}

export async function assessRepositoryWorktree({ repositoryId, branch, stateRoot = STATE_ROOT }) {
  const { worktree } = repositoryWorktree(repositoryId, branch, stateRoot);
  return assessWorktreePreservation(worktree.path, { branch: worktree.branch });
}

export async function listRepositoryWorktreeArchives({ repositoryId, stateRoot = STATE_ROOT }) {
  return listWorktreeSnapshots(repositoryMainCheckout(repositoryId, stateRoot));
}

export async function archiveRepositoryWorktree({ repositoryId, branch, confirm = false, apply = false, stateRoot = STATE_ROOT, stop = stopCheckoutServers, discover = discoverInstances }) {
  const { main, worktree } = repositoryWorktree(repositoryId, branch, stateRoot);
  if (apply && !confirm) throw new Error("Archive and remove requires explicit confirmation; stop writers before confirming");
  const options = { cwd: main, stateRoot, remove: branch, archive: true, confirm: true };
  const [preview] = await cleanupWorktrees({ ...options, discover: async () => ({ instances: [] }) });
  if (!apply || !preview?.eligible) return preview;
  const stopped = await stop(worktree.path);
  if (!stopped.ok) return { ...preview, eligible: false, reason: serversStillRunning(stopped) };
  const [result] = await cleanupWorktrees({ ...options, apply: true, discover });
  return result;
}
