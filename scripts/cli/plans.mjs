import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { packageStatusSummary } from "./package-status.mjs";
import { stateRoot } from "./paths.mjs";
import { autoDiscoveryEnabled } from "./repository-sources.mjs";
import {
  buildPlanSnapshot,
  buildPrompt,
  findPlanByKey,
  movePlanLifecycle as movePlanLifecycleInDocs,
  readPlanDocument,
  updatePlanPriority as updatePlanPriorityInDocs,
  validateRepositoryPlans,
} from "../../modules/plan-suite/index.mjs";
import { startPlan } from "../../modules/plan-suite/start-transition.mjs";
import { stopPlanServers } from "../../modules/plan-suite/stop-servers.mjs";
import { repairPlansMissingFrontmatter } from "../../modules/plan-suite/repair.mjs";
import { loadRegistry } from "../../modules/repositories/index.mjs";
import { MOCK_FIRST_RUN_VIEWS_ENABLED, mockPlanDocument, mockPlansSnapshot } from "./mock-home.mjs";

let cachedSnapshot = null;
let cachedSnapshotIsMock = false;

export function loadPlansSnapshot() {
  if (MOCK_FIRST_RUN_VIEWS_ENABLED && hasNoRegisteredRepositories()) {
    cachedSnapshot = mockPlansSnapshot({ packageState: planWritePackageState() });
    cachedSnapshotIsMock = true;
    return cachedSnapshot;
  }
  cachedSnapshot = buildPlanSnapshot({ stateRoot, packageState: planWritePackageState() });
  cachedSnapshotIsMock = false;
  return publicSnapshot(cachedSnapshot);
}

export function loadCachedPlansSnapshot() {
  if (MOCK_FIRST_RUN_VIEWS_ENABLED && hasNoRegisteredRepositories()) return mockPlansSnapshot({ packageState: planWritePackageState() });
  if (cachedSnapshotIsMock) {
    cachedSnapshot = null;
    cachedSnapshotIsMock = false;
  }
  return cachedSnapshot ? publicSnapshot(cachedSnapshot) : null;
}

export function loadPlanDocument({ key }) {
  if (MOCK_FIRST_RUN_VIEWS_ENABLED && hasNoRegisteredRepositories()) return mockPlanDocument({ key });
  const snapshot = cachedSnapshot || buildPlanSnapshot({ stateRoot, packageState: planWritePackageState() });
  return readPlanDocument(snapshot, key);
}

export function buildPlansPrompt({ action, keys, mode }) {
  if (MOCK_FIRST_RUN_VIEWS_ENABLED && hasNoRegisteredRepositories()) {
    const snapshot = mockPlansSnapshot({ packageState: planWritePackageState() });
    const selected = (Array.isArray(keys) ? keys : []).map((key) => snapshot.plans.find((plan) => plan.key === key));
    if (selected.length === 0 || selected.some((plan) => !plan)) throw new Error("select at least one plan");
    return { prompt: buildPrompt(action, selected, { mode }) };
  }
  const snapshot = cachedSnapshot || buildPlanSnapshot({ stateRoot, packageState: planWritePackageState() });
  const selected = (Array.isArray(keys) ? keys : []).map((key) => findPlanByKey(snapshot, key));
  if (selected.length === 0) throw new Error("select at least one plan");
  return { prompt: buildPrompt(action, selected, { mode }) };
}

export function updatePlanPriority({ id, key, priority, expectedPriority, mtimeMs, repositoryId }) {
  const snapshot = cachedSnapshot || buildPlanSnapshot({ stateRoot, packageState: planWritePackageState() });
  const result = updatePlanPriorityInDocs(snapshot, { id, key, priority, expectedPriority, mtimeMs, repositoryId });
  cachedSnapshot = null;
  return publicMutationResult(result);
}

export function updatePlanLifecycle({ id, key, lifecycle, expectedLifecycle, mtimeMs, repositoryId, skipDestinationValidation }) {
  const snapshot = cachedSnapshot || buildPlanSnapshot({ stateRoot, packageState: planWritePackageState() });
  const result = movePlanLifecycleInDocs(snapshot, { id, key, lifecycle, expectedLifecycle, mtimeMs, repositoryId, skipDestinationValidation });
  cachedSnapshot = null;
  return publicMutationResult(result);
}

// Strips the same private fields (absolutePath, repository.root) from a mutation result's record
// that publicSnapshot() strips from every plan in a full snapshot — the domain layer's record
// shape always carries them internally, but they must never cross the HTTP boundary.
function publicMutationResult(result) {
  const { absolutePath, repository, ...plan } = result.record;
  return { change: result.change, record: { ...plan, repository: stripRepositoryRoot(repository) } };
}

export function refreshPlans() {
  cachedSnapshot = null;
  cachedSnapshotIsMock = false;
  return loadPlansSnapshot();
}

function planWritePackageState() {
  return { ...packageStatusSummary("plan-write"), message: "" };
}

function hasNoRegisteredRepositories() {
  return Object.keys(loadRegistry({ stateRoot }).repositories || {}).length === 0;
}

// `autoDiscovery` lets the Plans page show the same repository empty state Home does.
function publicSnapshot(snapshot) {
  return {
    ...snapshot,
    autoDiscovery: { enabled: autoDiscoveryEnabled({ stateRoot }) },
    plans: snapshot.plans.map(({ absolutePath, repository, ...plan }) => ({
      ...plan,
      repository: stripRepositoryRoot(repository),
    })),
    repositories: snapshot.repositories.map(({ root, ...repo }) => repo),
  };
}

function stripRepositoryRoot(repository) {
  const { root, ...publicRepository } = repository || {};
  return publicRepository;
}

const PLANS_USAGE = [
  "usage: roborepo plans validate [<plan>] [--json]",
  "       roborepo plans start <plan> --worktree <name> [--base <branch>] [--json]",
  "       roborepo plans stop-servers <plan> [--dry-run] [--json]",
  "       roborepo plans repair <root> [--dry-run]",
].join("\n");

export function plansCommand(args) {
  const [sub, ...rest] = args;
  if (sub === "repair") return plansRepairCommand(rest);
  if (sub === "validate") return plansValidateCommand(rest);
  if (sub === "start") return plansStartCommand(rest);
  if (sub === "stop-servers") return plansStopServersCommand(rest);
  console.error(`unknown: roborepo plans ${sub ?? ""}`.trim());
  console.error(PLANS_USAGE);
  process.exit(2);
}

// Splits `--flag value` options from positionals. Flags in `valued` consume the next argument.
function parseArgs(args, valued = []) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s);
    if (valued.includes(name)) flags[name] = inline ?? args[(i += 1)];
    else flags[name] = true;
  }
  return { flags, positional };
}

function failDomain(err, json) {
  if (!err?.code) throw err;
  if (json) {
    console.log(JSON.stringify({ ok: false, error: { code: err.code, message: err.message, resolution: err.resolution, details: err.details } }, null, 2));
  } else {
    console.error(`error: ${err.message}`);
    if (err.resolution) console.error(err.resolution);
    for (const detail of err.details || []) console.error(`  ${detail}`);
  }
  process.exit(1);
}

// Exit status: 0 when no blocking finding remains, 1 when one does or the plan cannot be resolved.
function plansValidateCommand(args) {
  const { flags, positional } = parseArgs(args);
  let result;
  try {
    result = validateRepositoryPlans({ selector: positional[0] || null });
  } catch (err) {
    return failDomain(err, flags.json);
  }
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const plan of result.plans) {
      if (plan.findings.length === 0) continue;
      console.log(`${plan.relativePath}${plan.id ? ` (${plan.id})` : ""}`);
      for (const item of plan.findings) console.log(`  ${item.severity.padEnd(8)} ${item.code}: ${item.message}`);
    }
    const { plans, findings, blocking } = result.summary;
    console.log(`${plans} plan${plans === 1 ? "" : "s"} checked in ${result.repository.name}: ${findings} finding${findings === 1 ? "" : "s"}, ${blocking} blocking.`);
  }
  if (result.summary.blocking > 0) process.exit(1);
}

// Exit status: 0 when the validator approves, 1 when a precondition refuses or a check fails.
function plansStartCommand(args) {
  const { flags, positional } = parseArgs(args, ["worktree", "base"]);
  if (!positional[0] || !flags.worktree) {
    console.error(PLANS_USAGE);
    process.exit(2);
  }
  let result;
  try {
    result = startPlan({ selector: positional[0], worktree: flags.worktree, base: flags.base || "main" });
  } catch (err) {
    return failDomain(err, flags.json);
  }
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`plan: ${result.plan.path}${result.plan.id ? ` (${result.plan.id})` : ""}`);
    console.log(`worktree: ${result.worktree.name}${result.worktree.branch ? ` on ${result.worktree.branch}` : ""}`);
    console.log(`transition: ${result.commit ? `committed ${result.commit.slice(0, 12)} on ${result.base}` : "already recorded"}`);
    console.log(`fast-forward: ${result.fastForward.applied ? "applied" : result.fastForward.reason}`);
    for (const link of result.staleLinks) console.log(`stale link to ${result.plan.from}: ${link}`);
    for (const check of result.checks.filter((item) => !item.ok)) {
      console.log(`check ${check.n} failed (${check.name}): ${check.observed}`);
      console.log(`  fix: ${check.fix}`);
    }
    console.log(result.verdict);
  }
  if (result.verdict !== "APPROVED") process.exit(1);
}

// Exit status: 0 when every server stopped (or there was none), 1 when one survived SIGTERM, could
// not be signalled, or the plan cannot be resolved.
async function plansStopServersCommand(args) {
  const { flags, positional } = parseArgs(args);
  if (!positional[0]) {
    console.error(PLANS_USAGE);
    process.exit(2);
  }
  let result;
  try {
    result = await stopPlanServers({ selector: positional[0], dryRun: Boolean(flags["dry-run"]) });
  } catch (err) {
    return failDomain(err, flags.json);
  }
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`plan: ${result.plan.path}${result.plan.id ? ` (${result.plan.id})` : ""}`);
    console.log(`worktree: ${result.worktree?.path || result.worktree?.name || "none"}`);
    if (result.reason) console.log(result.reason);
    for (const warning of result.warnings) console.log(`warning: ${warning}`);
    for (const server of result.servers) {
      const ports = server.ports.map((port) => `:${port}`).join(" ");
      console.log(`${server.result}: pid ${server.pid} ${server.command} ${ports}${server.error ? ` (${server.error})` : ""}`);
    }
    if (result.supported && !result.reason && result.servers.length === 0) console.log("no servers running in the worktree");
  }
  if (!result.ok) process.exit(1);
}

function plansRepairCommand(args) {
  const dryRun = args.includes("--dry-run");
  const root = args.find((arg) => !arg.startsWith("--"));
  if (!root) {
    console.error("usage: roborepo plans repair <root> [--dry-run]");
    process.exit(2);
  }
  const resolvedRoot = path.resolve(root.replace(/^~(?=$|\/)/, os.homedir()));
  if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
    console.error(`error: ${root} is not a readable directory`);
    process.exit(2);
  }
  const { repaired, errors } = repairPlansMissingFrontmatter(resolvedRoot, { dryRun });
  if (repaired.length === 0) {
    console.log("no plan docs missing frontmatter found.");
  } else {
    const verb = dryRun ? "would scaffold frontmatter for" : "scaffolded frontmatter for";
    console.log(`${verb} ${repaired.length} plan doc${repaired.length === 1 ? "" : "s"}:`);
    for (const item of repaired) console.log(`  ${item.repository}: ${item.relativePath}`);
  }
  for (const err of errors) console.error(`warning: ${err.root || err.repository}: ${err.error}`);
  if (errors.length > 0) process.exit(1);
}
