// The Plans snapshot, built from the repositories RoboRepo knows about rather than from folders
// Plans owns (pljvmyh §9). Every visible repository with a readable checkout is scanned across all
// of its checkouts; copies of one plan are merged by plan `id`, with the main checkout canonical.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { checkoutRootsFor, loadRegistry } from "../repositories/index.mjs";
import { finding, messagesOf } from "./findings.mjs";
import { repositoryCheckouts } from "./checkouts.mjs";
import {
  parseFrontmatter,
  planFilesInRepository,
  publicPlan,
  publicRepository,
  readPlanRecord,
  repositoryRecord,
  withRelationshipFindings,
} from "./index.mjs";

export function buildPlanSnapshot({ stateRoot, packageState = null, registry = null } = {}) {
  const known = registry || loadRegistry({ stateRoot });
  const repositories = [];
  const repositoryScans = [];
  const plans = [];
  const errors = [];
  for (const record of plannableRepositories(known)) {
    // A repository with no recorded checkout (known only from agent sessions, say) has nothing for
    // Plans to read; it gets no scan entry and Home reports it as not scanned.
    if (!checkoutRootsFor(known, record.id).length) continue;
    const checkouts = repositoryCheckouts(known, record.id);
    // No readable checkout is not "zero plans": the repository was not scanned at all.
    if (!checkouts.length) {
      repositoryScans.push({ repositoryId: record.id, state: "unavailable", planCount: 0, checkoutCount: 0 });
      continue;
    }
    try {
      const scan = scanRepository(checkouts, { repositoryId: record.id, name: record.displayName });
      repositories.push(scan.repository);
      plans.push(...scan.plans);
      errors.push(...scan.errors.map((error) => ({ repository: record.displayName, ...error })));
      repositoryScans.push({ repositoryId: record.id, state: "scanned", planCount: scan.plans.length, checkoutCount: checkouts.length });
    } catch (err) {
      errors.push({ repository: record.displayName, error: pathFreeError(err) });
      repositoryScans.push({ repositoryId: record.id, state: "error", planCount: 0, checkoutCount: checkouts.length });
    }
  }
  return {
    ok: true,
    repositories: repositories.map(publicRepository),
    repositoryScans,
    plans: withRelationshipFindings(plans).map(publicPlan),
    errors,
    truncated: plans.some((plan) => plan.repository.truncated),
    planWritePackage: packageState || { available: false, enabled: false, status: "missing" },
  };
}

// Visible canonical records only: an alias points at another record that is scanned in its place,
// and a hidden (ignored) repository is left out of normal Plans entries (§8).
function plannableRepositories(registry) {
  return Object.values(registry.repositories || {})
    .filter((record) => record.visibility !== "hidden" && !registry.aliases?.[record.id])
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

// Main copy first. A plan found only outside the main checkout is shown from there, labeled with that
// checkout, and its edits are written there. Other copies collapse into the main copy, and only the
// copy in the plan's own worktree (its `worktree` field) can mark it as differing: that is where the
// plan is being worked on. Every other worktree mostly holds an older copy of main, so comparing
// against it would flag plans the worktree never touched.
//
// A full plan record costs several Git subprocesses, and a repository can have many worktrees that
// mostly carry identical copies. So only the first checkout and plans that exist nowhere else get
// full records; every other copy is matched from its frontmatter id and content hash alone.
function scanRepository(checkouts, canonical) {
  const kept = new Map();
  const hashes = new Map();
  const ordered = [];
  const errors = [];
  let repository = null;
  for (const checkout of checkouts) {
    const { files, scoped } = planFilesInRepository(repositoryRecord(checkout.path, canonical));
    repository ||= scoped;
    // Repository-relative paths only: /api/plans never carries an absolute path (§6).
    errors.push(...scoped.errors.map((error) => ({ checkout: checkout.label, path: error.path, error: "could not be read" })));
    for (const file of files) {
      const copy = readCopy(file, checkout.path);
      const existing = kept.get(copy.key);
      // Same checkout means a genuine duplicate id; both stay so DUPLICATE_PLAN_ID fires.
      if (!existing || existing.checkoutPath === checkout.path) {
        const labeled = withCheckout(readPlanRecord(scoped, file), checkout);
        if (!existing) kept.set(copy.key, labeled);
        hashes.set(file, copy.hash);
        ordered.push(labeled);
        continue;
      }
      if (isPlanWorktree(existing, checkout) && hashes.get(existing.absolutePath) !== copy.hash) markDiverged(existing, checkout.label);
    }
  }
  return { repository, plans: ordered, errors };
}

function isPlanWorktree(record, checkout) {
  return checkout.isWorktree && Boolean(record.plan.worktree) && record.plan.worktree === checkout.label;
}

// The identity and content hash of one copy, read without building a record.
function readCopy(file, checkoutPath) {
  let markdown = "";
  try {
    markdown = fs.readFileSync(file, "utf8");
  } catch {
    return { key: `path:${file}`, hash: null };
  }
  const id = parseFrontmatter(markdown).frontmatter.id;
  const relativePath = path.relative(checkoutPath, file).split(path.sep).join("/");
  return {
    key: typeof id === "string" && id ? id : `path:${relativePath}`,
    hash: crypto.createHash("sha256").update(markdown).digest("hex"),
  };
}

function withCheckout(record, checkout) {
  return {
    ...record,
    checkoutPath: checkout.path,
    plan: { ...record.plan, checkout: checkout.isMain ? null : checkout.label, divergentCheckouts: [] },
  };
}

function markDiverged(record, label) {
  if (record.plan.divergentCheckouts.includes(label)) return;
  record.plan.divergentCheckouts.push(label);
  const findings = [...record.plan.validation.findings, finding("PLAN_DIFFERS_IN_WORKTREE", { meta: { worktree: label } })];
  record.plan.validation = { valid: false, findings, warnings: messagesOf(findings) };
}

// Filesystem and Git error messages embed absolute paths, so only the error code crosses over.
function pathFreeError(err) {
  return err?.code ? `scan failed (${err.code})` : "scan failed";
}
