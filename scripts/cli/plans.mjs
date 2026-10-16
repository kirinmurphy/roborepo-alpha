import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { packageStatusSummary } from "./package-status.mjs";
import { stateRoot } from "./paths.mjs";
import { autoDiscoveryEnabled } from "./repository-sources.mjs";
import {
  buildPlanSnapshot,
  buildPrompt,
  buildRepositoryPlanSnapshot,
  findPlanByKey,
  planSnapshotFingerprint,
  readPlanDocument,
  selectRepositoryPlan,
  updatePlanPriority as updatePlanPriorityInDocs,
  validateRepositoryPlans,
} from "../../modules/plan-suite/index.mjs";
import { LIFECYCLE_MODEL } from "../../modules/plan-suite/lifecycle-manifest.mjs";
import { primaryCheckout } from "../../modules/plan-suite/plan-git.mjs";
import { approvalFreshness, completionPreflight } from "../../modules/plan-suite/review-gates.mjs";
import { syncBase } from "../../modules/plan-suite/sync-base.mjs";
import { transitionPlan } from "../../modules/plan-suite/transition.mjs";
import { stopPlanServers } from "../../modules/plan-suite/stop-servers.mjs";
import { repairPlansMissingFrontmatter } from "../../modules/plan-suite/repair.mjs";
import { loadRegistry } from "../../modules/repositories/index.mjs";
import { MOCK_FIRST_RUN_VIEWS_ENABLED, mockPlanDocument, mockPlansSnapshot } from "./mock-home.mjs";

let cachedSnapshot = null;
let cachedSnapshotIsMock = false;
// planSnapshotFingerprint() as of the last real build; null whenever cachedSnapshot is not one.
let cachedFingerprint = null;

// `repositoryId` (the resolved Portal scope) filters the one cached snapshot per request; there is
// no per-repository cache, so Home's loadCachedPlansSnapshot always sees the same build.
export function loadPlansSnapshot({ repositoryId = null } = {}) {
  if (MOCK_FIRST_RUN_VIEWS_ENABLED && hasNoRegisteredRepositories()) {
    cachedSnapshot = mockPlansSnapshot({ packageState: planWritePackageState() });
    cachedSnapshotIsMock = true;
    cachedFingerprint = null;
    return scopeSnapshot(cachedSnapshot, repositoryId);
  }
  rebuildSnapshot(loadRegistry({ stateRoot }));
  return scopeSnapshot(publicSnapshot(cachedSnapshot), repositoryId);
}

// One repository's slice of a public snapshot: its plans, its scan state (the header count and
// onboarding read it), and its scan errors. A repository with no recorded checkout has no scan
// entry; scoped to it, that is "not scanned", not "no repositories known".
export function scopeSnapshot(snapshot, repositoryId) {
  if (!repositoryId) return snapshot;
  const inScope = (id) => id === repositoryId;
  const scans = (snapshot.repositoryScans || []).filter((scan) => inScope(scan.repositoryId));
  return {
    ...snapshot,
    plans: snapshot.plans.filter((plan) => inScope(plan.repository?.repositoryId)),
    repositories: snapshot.repositories.filter((repository) => inScope(repository.repositoryId)),
    repositoryScans: scans.length ? scans : [{ repositoryId, state: "unavailable", planCount: 0, checkoutCount: 0 }],
    errors: (snapshot.errors || []).filter((error) => inScope(error.repositoryId)),
  };
}

// Home polls this every few seconds. A full build runs Git subprocesses per checkout, so it is
// rebuilt only when the stat-only fingerprint says plan files or checkouts changed (or nothing is
// cached yet). Without that check, Home kept whatever the Plans page last loaded.
export function loadCachedPlansSnapshot() {
  if (MOCK_FIRST_RUN_VIEWS_ENABLED && hasNoRegisteredRepositories()) return mockPlansSnapshot({ packageState: planWritePackageState() });
  const registry = loadRegistry({ stateRoot });
  const fingerprint = planSnapshotFingerprint({ registry });
  if (!cachedSnapshot || cachedSnapshotIsMock || fingerprint !== cachedFingerprint) rebuildSnapshot(registry, fingerprint);
  return publicSnapshot(cachedSnapshot);
}

// The fingerprint is taken before the build, so a file that changes mid-build shows up as a
// mismatch on the next check rather than being masked.
function rebuildSnapshot(registry, fingerprint = planSnapshotFingerprint({ registry })) {
  cachedSnapshot = buildPlanSnapshot({ stateRoot, registry, packageState: planWritePackageState() });
  cachedSnapshotIsMock = false;
  cachedFingerprint = fingerprint;
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

// Strips the same private fields (absolutePath, repository.root) from a mutation result's record
// that publicSnapshot() strips from every plan in a full snapshot — the domain layer's record
// shape always carries them internally, but they must never cross the HTTP boundary.
function publicMutationResult(result) {
  const { absolutePath, repository, ...plan } = result.record;
  return { change: result.change, record: { ...plan, repository: stripRepositoryRoot(repository) } };
}

export function refreshPlans({ repositoryId = null } = {}) {
  cachedSnapshot = null;
  cachedSnapshotIsMock = false;
  return loadPlansSnapshot({ repositoryId });
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
  "       roborepo plans promote|submit|reopen|close <plan> [--base <branch>] [--json]",
  "       roborepo plans start <plan> --worktree <name> [--base <branch>] [--json]",
  "       roborepo plans archive <plan> --reason <text> [--base <branch>] [--json]",
  "       roborepo plans preflight|approval <plan> [--base <branch>] [--json]",
  "       roborepo plans sync-base [--continue] [--base <branch>] [--json]",
  "       roborepo plans stop-servers <plan> [--dry-run] [--json]",
  "       roborepo plans repair <root> [--dry-run]",
].join("\n");

export function plansCommand(args) {
  const [sub, ...rest] = args;
  if (sub === "repair") return plansRepairCommand(rest);
  if (sub === "validate") return plansValidateCommand(rest);
  if (LIFECYCLE_MODEL.transition(sub)) return plansTransitionCommand(sub, rest);
  if (sub === "preflight") return plansPreflightCommand(rest);
  if (sub === "approval") return plansApprovalCommand(rest);
  if (sub === "sync-base") return plansSyncBaseCommand(rest);
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
    const { code, message, resolution, details, findings, repair, evidence } = err;
    console.log(JSON.stringify({ ok: false, error: { code, message, resolution, details, findings, repair, evidence } }, null, 2));
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

// Every lifecycle transition the manifest declares. Exit status: 0 when the post-commit validator
// approves, 1 when a precondition or gate refuses or a check fails, 2 on a usage error.
async function plansTransitionCommand(transition, args) {
  const { flags, positional } = parseArgs(args, ["worktree", "base", "reason"]);
  if (!positional[0] || (transition === "start" && !flags.worktree) || (transition === "archive" && !flags.reason)) {
    console.error(PLANS_USAGE);
    process.exit(2);
  }
  let result;
  try {
    result = await transitionPlan({ transition, selector: positional[0], worktree: flags.worktree, reason: flags.reason, base: flags.base || "main" });
  } catch (err) {
    return failDomain(err, flags.json);
  }
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const { lifecycle } = result.plan;
    console.log(`plan: ${result.plan.path}${result.plan.id ? ` (${result.plan.id})` : ""}`);
    if (result.worktree) console.log(`worktree: ${result.worktree.name}${result.worktree.branch ? ` on ${result.worktree.branch}` : ""}`);
    console.log(`${transition}: ${lifecycle.from} -> ${lifecycle.to}, ${result.commit ? `committed ${result.commit.slice(0, 12)} on ${result.base}` : "already recorded"}`);
    if (result.fastForward) console.log(`fast-forward: ${result.fastForward.applied ? "applied" : result.fastForward.reason}`);
    if (result.worktreeCopy) console.log(`worktree copy: ${result.worktreeCopy}`);
    for (const link of result.staleLinks) console.log(`stale link to ${result.plan.from}: ${link}`);
    printFailedChecks(result.checks);
    console.log(result.verdict);
  }
  if (result.verdict !== "APPROVED") process.exit(1);
}

// Exit status: 0 when implementation is complete, 1 when a check fails or the plan cannot be resolved.
function plansPreflightCommand(args) {
  const { flags, positional } = parseArgs(args, ["base"]);
  if (!positional[0]) {
    console.error(PLANS_USAGE);
    process.exit(2);
  }
  let result;
  try {
    result = runFromPrimary(positional[0], (context) => completionPreflight({ ...context, base: flags.base || "main" }));
  } catch (err) {
    return failDomain(err, flags.json);
  }
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`plan: ${result.plan.path}${result.plan.id ? ` (${result.plan.id})` : ""}`);
    printFailedChecks(result.checks);
    console.log(result.ok ? "implementation complete" : "implementation incomplete");
  }
  if (!result.ok) process.exit(1);
}

// Exit status: 0 when the recorded approval is fresh, 1 otherwise.
function plansApprovalCommand(args) {
  const { flags, positional } = parseArgs(args, ["base"]);
  if (!positional[0]) {
    console.error(PLANS_USAGE);
    process.exit(2);
  }
  let result;
  try {
    result = runFromPrimary(positional[0], (context) => approvalFreshness({ ...context, base: flags.base || "main" }));
  } catch (err) {
    return failDomain(err, flags.json);
  }
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`plan: ${result.plan.path}${result.plan.id ? ` (${result.plan.id})` : ""}`);
    console.log(`approval: ${result.state}${result.reason ? ` (${result.reason})` : ""}`);
    for (const changed of result.changedPaths || []) console.log(`  changed: ${changed}`);
  }
  if (result.state !== "fresh") process.exit(1);
}

// Exit status: 0 when the branch is up to date or merged, 1 when conflicts pause the merge or a
// precondition refuses.
function plansSyncBaseCommand(args) {
  const { flags } = parseArgs(args, ["base"]);
  let result;
  try {
    result = syncBase({ base: flags.base || "main", continueMerge: Boolean(flags.continue) });
  } catch (err) {
    return failDomain(err, flags.json);
  }
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.branch}: ${result.state}${result.commit ? ` at ${result.commit.slice(0, 12)}` : ""}`);
    for (const item of result.resolved) console.log(`plan rename resolved: ${item.from} -> ${item.to}`);
    for (const conflict of result.conflicts) console.log(`conflict: ${conflict}`);
    if (result.state === "conflicts") console.log("Resolve the conflicts, stage them, run the checks, then run `roborepo plans sync-base --continue`.");
  }
  if (result.state === "conflicts") process.exit(1);
}

// Resolves a plan the way the transitions do: its stage from the primary checkout, its content from
// whichever copy is authoritative.
function runFromPrimary(selector, run) {
  const primary = primaryCheckout(process.cwd());
  const record = selectRepositoryPlan(buildRepositoryPlanSnapshot({ cwd: primary }), selector, { cwd: process.cwd() });
  return run({ primary, record });
}

function printFailedChecks(checks) {
  for (const check of checks.filter((item) => !item.ok)) {
    console.log(`check ${check.n} failed (${check.name}): ${check.observed}`);
    console.log(`  fix: ${check.fix}`);
  }
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
