import path from "node:path";
import { discoverInstances } from "../../modules/developer-runtime/discovery.mjs";
import { stopCheckoutServers } from "../../modules/developer-runtime/stop.mjs";
import { findProjectRoot, mainCheckoutPath, resolveGitDir } from "../../modules/repositories/identity.mjs";
import { linkedWorktrees } from "../../modules/repositories/worktree-inventory.mjs";
import { inspectBranchLanding } from "../../modules/repositories/worktree-landed.mjs";
import { checkWorktreeRemoval } from "../../modules/repositories/worktree-guards.mjs";
import { removeLandedBranch, removeWorktree, withCleanupLock } from "../../modules/repositories/worktree-removal.mjs";
import { runGitProcess } from "../../modules/repositories/git-exec.mjs";
import { checkoutRootsFor, loadRegistry } from "../../modules/repositories/registry.mjs";
import { activeWorktreeNames, findPlanAbsorbingCommit, findPlanWorktree, repositoryRecordFor, worktreeFolder } from "./worktree-policy.mjs";
import { STATE_ROOT } from "./paths.mjs";

export async function cleanupWorktrees({ cwd = process.cwd(), stateRoot = STATE_ROOT, apply = false, plan = null, remove = null, confirm = false, currentPath = cwd, discover = discoverInstances } = {}) {
  const mainPath = mainCheckout(cwd);
  if (!mainPath) throw new Error("a non-bare Git checkout is required");
  const gitDir = path.join(mainPath, ".git");
  const worktreeRoot = worktreeFolder(mainPath, repositoryRecordFor(loadRegistry({ stateRoot }), mainPath));
  const scopedName = plan ? findPlanWorktree(mainPath, plan) : null;
  const recorded = plan ? findPlanAbsorbingCommit(mainPath, plan) : null;
  if (plan && !scopedName) throw new Error(`plan not found or has no worktree: ${plan}`);
  const worktrees = linkedWorktrees(gitDir);
  const selectedBranch = remove;
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
      const landing = worktree.branch ? await inspectBranchLanding(mainPath, worktree.branch, { recorded }) : { landed: false, reason: "detached" };
      const guard = await checkWorktreeRemoval({
        worktree, kind, landed: landing.landed, worktreeRoot, mainPath, currentPath,
        activePlan: activePlans.has(worktree.name), running: running.has(worktree.path),
      });
      const row = { path: worktree.path, name: worktree.name, branch: worktree.branch, state: landing.landed ? "landed" : landing.reason === "scan unavailable" ? "unknown" : "not landed", eligible: guard.ok, reason: landing.reason === "scan unavailable" ? "landed scan unavailable" : guard.reason, warning: guard.warning, landingEvidence: landing.landed ? (landing.reused ? "reused" : "scanned") : null, action: "kept" };
      if (apply && guard.ok) {
        const fresh = linkedWorktrees(gitDir).find((item) => item.name === worktree.name);
        const freshTip = fresh ? await worktreeTip(mainPath, fresh) : null;
        if (!fresh || fresh.path !== worktree.path || fresh.branch !== worktree.branch || !freshTip || freshTip !== surveyTip) {
          row.reason = "Git state changed after survey";
          row.eligible = false;
        } else {
          const rechecked = await checkWorktreeRemoval({
            worktree: fresh, kind, landed: landing.landed, worktreeRoot, mainPath, currentPath,
            activePlan: activeWorktreeNames(mainPath).has(fresh.name), running: running.has(fresh.path),
          });
          if (!rechecked.ok) { row.reason = rechecked.reason; row.eligible = false; }
          else {
            const result = await removeWorktree(mainPath, fresh, { kind, stateRoot, tip: freshTip });
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
    if (["--plan", "--remove", "--current"].includes(arg)) {
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
  return rows;
}

// Home's Delete Worktree: confirmed removal of one worktree, through the same guards as the command.
// Deleting stops the worktree's dev servers first, but only once every other guard has passed, so a
// deletion that would be refused anyway (uncommitted changes, say) never stops anything.
export async function removeRepositoryWorktree({ repositoryId, branch, stateRoot = STATE_ROOT, stop = stopCheckoutServers, discover = discoverInstances }) {
  const { main, worktree } = repositoryWorktree(repositoryId, branch, stateRoot);
  const options = { cwd: main, stateRoot, remove: branch, confirm: true };
  const [preview] = await cleanupWorktrees({ ...options, discover: async () => ({ instances: [] }) });
  if (!preview?.eligible) return preview || { action: "kept", reason: "worktree unavailable" };
  const stopped = await stop(worktree.path);
  if (!stopped.ok) return { action: "kept", reason: serversStillRunning(stopped) };
  const rows = await cleanupWorktrees({ ...options, apply: true, discover });
  return rows[0] || { action: "kept", reason: "worktree unavailable" };
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
