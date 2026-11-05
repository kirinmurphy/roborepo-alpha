import path from "node:path";
import { assessWorktreePreservation } from "../../modules/repositories/worktree-preservation.mjs";
import { inventoryWorktree, listWorktreeSnapshots, restoreWorktreeSnapshot } from "../../modules/repositories/worktree-snapshot.mjs";
import { discoverInstances } from "../../modules/developer-runtime/discovery.mjs";
import { stopCheckoutServers } from "../../modules/developer-runtime/stop.mjs";
import { findProjectRoot, mainCheckoutPath, resolveGitDir } from "../../modules/repositories/identity.mjs";
import { linkedWorktrees } from "../../modules/repositories/worktree-inventory.mjs";
import { inspectBranchLanding } from "../../modules/repositories/worktree-landed.mjs";
import { checkWorktreeRemoval } from "../../modules/repositories/worktree-guards.mjs";
import { removeLandedBranch, removeWorktree, retryBranchRetirement, withCleanupLock } from "../../modules/repositories/worktree-removal.mjs";
import { runGitProcess } from "../../modules/repositories/git-exec.mjs";
import { checkoutRootsFor, loadRegistry } from "../../modules/repositories/registry.mjs";
import { activeWorktreeNames, findPlanAbsorbingCommit, findPlanWorktree, repositoryRecordFor, worktreeFolder } from "./worktree-policy.mjs";
import { previewWorktreeDiscard, applyWorktreeDiscard } from "../../modules/repositories/worktree-discard.mjs";
import { legacyRecovery, restoreLegacyBackup, legacyRecoveryCount } from "../../modules/repositories/worktree-legacy-recovery.mjs";
import { STATE_ROOT } from "./paths.mjs";

export async function cleanupWorktrees({ cwd = process.cwd(), stateRoot = STATE_ROOT, apply = false, plan = null, base = "main", remove = null, confirm = false, currentPath = cwd, discover = discoverInstances } = {}) {
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
  const retrySelector = remove || scopedName;
  if (remove && !confirm) throw new Error("confirmed removal requires --confirm");
  if (retrySelector && !worktrees.some((item) => !item.prunable && (item.branch === retrySelector || item.name === retrySelector))) {
    const retry = async () => [{ ...await retryBranchRetirement(mainPath, retrySelector, { apply, stateRoot }), legacyRecoveryPending: await legacyRecoveryCount(mainPath) }];
    if (!apply) return retry();
    const locked = await withCleanupLock(stateRoot, retry, { repositoryPath: mainPath });
    return locked.locked ? [{ action: "kept", reason: "cleanup already running" }] : locked.result;
  }
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
      preservation = await assessWorktreePreservation(worktree.path, { branch: worktree.branch, base: landingBase, recorded });
      const landing = preservation?.landing || (worktree.branch ? await inspectBranchLanding(mainPath, worktree.branch, { base: landingBase, recorded }) : { landed: false, reason: "detached" });
      const guard = await checkWorktreeRemoval({
        worktree, kind, landed: landing.landed, worktreeRoot, mainPath, currentPath,
        activePlan: activePlans.has(worktree.name), running: running.has(worktree.path),
        preservationEvidence: preservation?.state === "preserved",
      });
      if (preservation?.state !== "preserved") { guard.ok = false; guard.reason = `${preservation?.reason || "preservation unknown"}; use roborepo git worktrees discard for explicit loss preview`; }
      const row = { cleanupWarnings: preservation?.cleanupWarnings || landing.cleanupWarnings || [], preservation: preservation?.state || null, remainingPaths: preservation?.remainingPaths || [], blockingPaths: preservation?.blockingPaths || [], assessedTip: preservation?.tip || surveyTip, assessedBase: preservation?.baseCommit || null, evidenceCommit: preservation?.evidenceCommit || null, outcomes: [], path: worktree.path, name: worktree.name, branch: worktree.branch, state: landing.landed ? "landed" : landing.reason === "scan unavailable" ? "unknown" : "not landed", eligible: guard.ok, reason: landing.reason === "scan unavailable" ? "landed scan unavailable" : guard.reason, warning: guard.warning, landingEvidence: landing.landed ? (landing.reused ? "reused" : "scanned") : null, action: "kept" };
      if (apply && guard.ok) {
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
            activePlan: activeWorktreeNames(mainPath).has(fresh.name), running: (await runningPaths(discover)).has(fresh.path),
            preservationEvidence: preservation?.state === "preserved",
          });
          if (!rechecked.ok) { row.reason = rechecked.reason; row.eligible = false; }
          else {
            const baseEvidence = preservation?.baseCommit ? { ref: preservation.baseRef, commit: preservation.baseCommit } : null;
            const result = await removeWorktree(mainPath, fresh, { kind, stateRoot, tip: freshTip, baseEvidence, authority: { scope: "proof", fingerprint: preservation.fingerprint, evidenceCommit: preservation.evidenceCommit } });
            row.outcomes.push(...(result.outcomes || []));
            if (result.entry?.branchDeleted === false) row.retryCommand = `roborepo git worktrees cleanup --remove ${fresh.name} --confirm --apply`;
            row.action = result.ok ? "removed" : result.kept ? "kept" : "failed";
            if (result.kept) row.eligible = false;
            row.reason = result.reason || null;

          }
        }
      }
      rows.push(row);
    }
    if (!selectedBranch && !scopedName) rows.push(...await cleanupDetachedBranches(mainPath, worktrees, { apply, stateRoot }));
    const pending = await legacyRecoveryCount(mainPath);
    return rows.map((row) => ({ ...row, legacyRecoveryPending: pending }));
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
    const row = { cleanupWarnings: landing.cleanupWarnings || [], path: null, name: null, branch, state: "landed", eligible: true, reason: null, action: "kept" };
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
  if (!options.json && rows[0]?.legacyRecoveryPending) console.log(`Legacy recovery pending: ${rows[0].legacyRecoveryPending}; run roborepo git worktrees legacy-recovery`);
  if (options.apply && ((options.remove && rows.some((row) => row.action !== "removed")) || rows.some((row) => row.action === "failed"))) process.exitCode = 1;
  return rows;
}

// Portal and CLI use the same assessment and one-use authority.
export async function previewRepositoryWorktree({ repositoryId, branch, stateRoot = STATE_ROOT, discover = discoverInstances }) {
  const { main, worktree } = repositoryWorktree(repositoryId, branch, stateRoot);
  const found = await discover();
  if (!Array.isArray(found?.instances)) return { action: "kept", eligible: false, reason: "server discovery unavailable" };
  const servers = found.instances.filter((item) => item.project?.projectRoot === worktree.path).map((item) => ({ pid: item.pid, ports: item.ports || [] }));
  const result = await previewWorktreeDiscard({ mainPath: main, repositoryId, worktree, stateRoot, servers, activePlans: () => activeWorktreeNames(main) });
  if (result.target) { const { path: privatePath, repositoryPath, ...target } = result.target; result.target = target; }
  return result;
}

export async function removeRepositoryWorktree({ repositoryId, branch, receipt, stateRoot = STATE_ROOT, stop = stopCheckoutServers }) {
  const { main, worktree } = repositoryWorktree(repositoryId, branch, stateRoot);
  return applyWorktreeDiscard({ mainPath: main, repositoryId, worktree, receipt, stateRoot, stop, activePlans: () => activeWorktreeNames(main) });
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
    result = await (positional[0].startsWith("refs/roborepo/abandoned/") ? restoreLegacyBackup : restoreWorktreeSnapshot)(process.cwd(), positional[0], options.destination, options);
  } else throw new Error(`unknown archive action: ${action}`);
  console.log(JSON.stringify(result, null, 2));
  if (options.apply && (Array.isArray(result) ? result.some((row) => row.action !== "removed") : !result.ok)) process.exitCode = 1;
  return result;
}

export async function worktreeDiscardCommand(args) {
  const options = parseDiscardArgs(args);
  const main = mainCheckout(process.cwd());
  if (!main) throw new Error("a non-bare Git checkout is required");
  const selector = options.plan ? findPlanWorktree(main, options.plan) : options.selector;
  if (!selector) throw new Error("a worktree selector or --plan is required");
  if (options.plan && options.scope === "all") throw new Error("--plan cannot authorize all scope");
  if (!options.apply && !options.plan && !options.scope) throw new Error("preview requires --scope leftovers|all");
  if (options.apply && !options.receipt) throw new Error("--apply requires --receipt");
  if (options.receipt && !options.apply) throw new Error("--receipt requires --apply");
  if (options.apply && (options.scope || options.base)) throw new Error("apply uses the receipt's scope and base");
  const worktree = linkedWorktrees(path.join(main, ".git")).find((item) => item.branch === selector || item.name === selector);
  if (!worktree) throw new Error(`worktree not found: ${selector}`);
  const common = { mainPath: main, repositoryId: main, worktree, stateRoot: STATE_ROOT, currentPath: process.cwd(), activePlans: () => activeWorktreeNames(main) };
  if (!options.apply) {
    const found = await discoverInstances();
    if (!Array.isArray(found?.instances)) throw new Error("server discovery unavailable");
    common.servers = found.instances.filter((item) => item.project?.projectRoot === worktree.path).map((item) => ({ pid: item.pid, ports: item.ports || [] }));
  }
  const result = options.apply
    ? await applyWorktreeDiscard({ ...common, receipt: options.receipt, requiredScope: options.plan ? "leftovers" : null, stop: stopCheckoutServers })
    : await previewWorktreeDiscard({ ...common, scope: options.plan ? "leftovers" : options.scope, base: options.base || (options.plan ? "refs/heads/main" : null) });
  console.log(JSON.stringify(result, null, 2));
  if (options.apply ? result.action !== "removed" : !result.receipt) process.exitCode = 1;
  return result;
}

function parseDiscardArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (["--scope", "--base", "--plan", "--receipt"].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      options[arg.slice(2)] = value;
    } else if (["--apply", "--json"].includes(arg)) options[arg.slice(2)] = true;
    else if (arg.startsWith("--") || options.selector) throw new Error(`unknown discard argument: ${arg}`);
    else options.selector = arg;
  }
  if (options.plan && options.selector) throw new Error("choose a selector or --plan");
  return options;
}

export async function worktreeLegacyRecoveryCommand(args) {
  const options = { discard: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (["--discard", "--approve"].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--discard") options.discard.push(value); else options.approve = value;
    } else if (["--apply", "--json"].includes(arg)) options[arg.slice(2)] = true;
    else throw new Error(`unknown legacy-recovery argument: ${arg}`);
  }
  const result = await legacyRecovery(process.cwd(), options);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
  return result;
}
