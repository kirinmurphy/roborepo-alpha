import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverInstances } from "../../modules/developer-runtime/discovery.mjs";
import { findProjectRoot, mainCheckoutPath, resolveGitDir } from "../../modules/repositories/identity.mjs";
import { linkedWorktrees } from "../../modules/repositories/worktree-inventory.mjs";
import { inspectBranchLanding } from "../../modules/repositories/worktree-landed.mjs";
import { checkWorktreeRemoval } from "../../modules/repositories/worktree-guards.mjs";
import { removeLandedBranch, removeWorktree, withCleanupLock } from "../../modules/repositories/worktree-removal.mjs";
import { runGitProcess } from "../../modules/repositories/git-exec.mjs";
import { checkoutRootsFor, loadRegistry, updateRegistry, setWorktreeHidden } from "../../modules/repositories/registry.mjs";
import { rootId } from "../../modules/repositories/identity.mjs";
import { STATE_ROOT } from "./paths.mjs";

export async function cleanupWorktrees({ cwd = process.cwd(), stateRoot = STATE_ROOT, apply = false, plan = null, hide = null, unhide = null, remove = null, confirm = false, currentPath = cwd, discover = discoverInstances } = {}) {
  const mainPath = mainCheckout(cwd);
  if (!mainPath) throw new Error("a non-bare Git checkout is required");
  const gitDir = path.join(mainPath, ".git");
  const worktreeRoot = configuredRoot(mainPath);
  const scopedName = plan ? findPlanWorktree(mainPath, plan) : null;
  if (plan && !scopedName) throw new Error(`plan not found or has no worktree: ${plan}`);
  const worktrees = linkedWorktrees(gitDir);
  const selectedBranch = hide || unhide || remove;
  if (selectedBranch && [hide, unhide, remove].filter(Boolean).length !== 1) throw new Error("choose one worktree action");
  if (remove && !confirm) throw new Error("confirmed removal requires --confirm");
  if (selectedBranch && !worktrees.some((item) => item.branch === selectedBranch || item.name === selectedBranch)) throw new Error(`worktree not found: ${selectedBranch}`);
  const action = async () => {
    if (hide || unhide) return [setHiddenWorktree(mainPath, stateRoot, worktrees, hide || unhide, Boolean(hide))];
    const running = await runningPaths(discover);
    const activePlans = activeWorktreeNames(mainPath);
    const rows = [];
    for (const worktree of worktrees) {
      if (scopedName && worktree.name !== scopedName) continue;
      if (selectedBranch && worktree.branch !== selectedBranch && worktree.name !== selectedBranch) continue;
      const kind = remove ? "confirmed" : "automatic";
      const landing = worktree.branch ? await inspectBranchLanding(mainPath, worktree.branch) : { landed: false, reason: "detached" };
      const guard = await checkWorktreeRemoval({
        worktree, kind, landed: landing.landed, worktreeRoot, mainPath, currentPath,
        activePlan: activePlans.has(worktree.name), running: running.has(worktree.path),
      });
      const row = { path: worktree.path, name: worktree.name, branch: worktree.branch, state: landing.landed ? "landed" : landing.reason === "scan unavailable" ? "unknown" : "not landed", eligible: guard.ok, reason: landing.reason === "scan unavailable" ? "landed scan unavailable" : guard.reason, warning: guard.warning, action: "kept" };
      if (apply && guard.ok) {
        const fresh = linkedWorktrees(gitDir).find((item) => item.name === worktree.name);
        const freshTip = fresh ? await worktreeTip(mainPath, fresh) : null;
        if (!fresh || fresh.path !== worktree.path || fresh.branch !== worktree.branch || freshTip !== landing.tip && worktree.branch) {
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

export function configuredRoot(mainPath) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(mainPath, "docs/plans/plans-config.json"), "utf8"));
    const raw = config.worktreeRoot;
    if (typeof raw !== "string" || !raw) return null;
    const resolved = raw === "~" ? os.homedir()
      : raw.startsWith(`~${path.sep}`) ? path.join(os.homedir(), raw.slice(2))
        : path.resolve(mainPath, raw);
    return fs.realpathSync(resolved);
  } catch { return null; }
}

function planFiles(mainPath, lifecycle) {
  const dir = path.join(mainPath, "docs/plans", lifecycle);
  try { return fs.readdirSync(dir).filter((file) => file.endsWith(".md")).map((file) => path.join(dir, file)); }
  catch { return []; }
}

function planFields(file) {
  try {
    const header = fs.readFileSync(file, "utf8").split("---", 3)[1] || "";
    return Object.fromEntries(header.split("\n").map((line) => line.match(/^(id|worktree):\s*(.*)$/)).filter(Boolean).map((match) => [match[1], match[2].trim()]));
  } catch { return {}; }
}

export function activeWorktreeNames(mainPath) {
  return new Set(planFiles(mainPath, "active").map((file) => planFields(file).worktree).filter(Boolean));
}

function findPlanWorktree(mainPath, plan) {
  for (const lifecycle of ["completed", "active", "backlog"]) {
    for (const file of planFiles(mainPath, lifecycle)) {
      const fields = planFields(file);
      if (fields.id === plan || file === path.resolve(plan) || path.basename(file) === plan) return fields.worktree || null;
    }
  }
  return null;
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

function setHiddenWorktree(mainPath, stateRoot, worktrees, selected, hidden) {
  const worktree = worktrees.find((item) => item.branch === selected || item.name === selected);
  if (!worktree || worktree.prunable) throw new Error("worktree unavailable");
  const registry = loadRegistry({ stateRoot });
  const repositoryId = Object.entries(registry.repositories || {}).find(([, record]) => record.localRoots?.some((root) => root.rootId === rootId(worktree.path)))?.[0];
  if (!repositoryId) throw new Error("worktree is not registered");
  updateRegistry({ stateRoot, mutate: (next) => setWorktreeHidden(next, repositoryId, rootId(worktree.path), { hidden }) });
  return { path: worktree.path, branch: worktree.branch, action: hidden ? "hidden" : "unhidden", reason: null };
}

export async function worktreeCleanupCommand(args) {
  const options = { apply: false, confirm: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (["--plan", "--hide", "--unhide", "--remove", "--current"].includes(arg)) options[arg.slice(2) === "current" ? "currentPath" : arg.slice(2)] = args[++i];
    else if (["--apply", "--confirm", "--json"].includes(arg)) options[arg.slice(2)] = true;
    else throw new Error(`unknown cleanup option: ${arg}`);
  }
  const rows = await cleanupWorktrees(options);
  if (options.json) console.log(JSON.stringify(rows, null, 2));
  else for (const row of rows) console.log(`${row.branch || row.name || "worktree"}: ${row.action} (${row.state || "unknown"})${row.reason ? ` — ${row.reason}` : ""}`);
  return rows;
}

export async function mutateWorktree({ repositoryId, action, branch, confirm = false, stateRoot = STATE_ROOT }) {
  if (!["hide", "unhide", "remove"].includes(action) || typeof branch !== "string" || !branch) throw new Error("invalid worktree action");
  const registry = loadRegistry({ stateRoot });
  if (!registry.repositories?.[repositoryId]) throw new Error("unknown repository");
  const main = mainCheckoutPath(checkoutRootsFor(registry, repositoryId).map((root) => root.path));
  if (!main) throw new Error("main checkout unavailable");
  const rows = await cleanupWorktrees({ cwd: main, stateRoot, [action]: branch, apply: action === "remove", confirm });
  return rows[0] || { action: "kept", reason: "worktree unavailable" };
}
