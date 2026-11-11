import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rootId } from "../../modules/repositories/identity.mjs";
import { parseFrontmatter } from "../../modules/plan-suite/index.mjs";
import { LIFECYCLE_MODEL } from "../../modules/plan-suite/lifecycle-manifest.mjs";
import { recordedAbsorbingCommit } from "../../modules/plan-suite/landing-gate.mjs";
import { PLANS_DIR, locateStore, readStoreConfig, storeRootFolder } from "../../modules/plan-suite/plan-store.mjs";

// What a repository's plans store and its registry record say cleanup may touch: the worktree folder
// automatic removal stays inside, and the worktrees active plans still claim.

// The folder automatic removal may act in. A repository's plans config names it for plan-suite
// repositories; any other repository gets the folder its user confirmed when turning cleanup on.
export function worktreeFolder(mainPath, record = null) {
  return configuredRoot(mainPath) || recordedRoot(record);
}

export function configuredRoot(mainPath) {
  const store = locateStore(mainPath);
  if (!store || store.missing) return null;
  const config = readStoreConfig(store.root);
  if (typeof config?.worktreeRoot !== "string" || !config.worktreeRoot) return null;
  try { return fs.realpathSync(storeRootFolder(config, store.primary)); } catch { return null; }
}

function recordedRoot(record) {
  const root = record?.worktreeCleanup?.root;
  if (!root) return null;
  try { return fs.realpathSync(root); } catch { return null; }
}

// The deepest folder holding every linked worktree a user would let cleanup touch. The desktop
// app's `.claude/worktrees/` belongs to that app, so its worktrees never widen the proposal.
export function proposedWorktreeFolder(worktrees) {
  const paths = worktrees.filter((worktree) => !worktree.prunable && !isToolOwned(worktree.path)).map((worktree) => worktree.path);
  if (!paths.length) return null;
  let common = path.dirname(paths[0]);
  for (const candidate of paths.slice(1)) {
    while (common !== path.dirname(common) && !isInside(candidate, common)) common = path.dirname(common);
  }
  return common === path.dirname(common) || common === os.homedir() ? null : common;
}

function isToolOwned(worktreePath) {
  return worktreePath.split(path.sep).join("/").includes("/.claude/worktrees/");
}

function isInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// The registry record whose known checkouts include this main checkout. Root ids hash the realpath.
export function repositoryRecordFor(registry, mainPath) {
  let real;
  try { real = fs.realpathSync(mainPath); } catch { return null; }
  const id = rootId(real);
  return Object.values(registry?.repositories || {}).find((record) => record.localRoots?.some((root) => root.rootId === id)) || null;
}

// The Plans parser, so a quoted `worktree: "name"` still joins and keeps its worktree protected.
// A file that cannot be read throws, because a caller protecting worktrees must not read it as no claim.
// Frontmatter the parser cannot read yields empty fields rather than an error.
function planFields(file) {
  const content = fs.readFileSync(file, "utf8");
  try {
    const { frontmatter } = parseFrontmatter(content);
    const field = (key) => typeof frontmatter[key] === "string" ? frontmatter[key].trim() : "";
    return { id: field("id"), worktree: field("worktree") };
  } catch { return {}; }
}

// `plans init` creates every lifecycle folder, so `required` treats a missing one as a damaged store.
function planFiles(storeRoot, lifecycle, { required = false } = {}) {
  const dir = path.join(storeRoot, PLANS_DIR, lifecycle);
  try { return fs.readdirSync(dir).filter((file) => file.endsWith(".md")).map((file) => path.join(dir, file)); }
  catch (err) {
    if (err?.code === "ENOENT" && !required) return [];
    throw err;
  }
}

// Stands in for the claimed set when the store cannot be read: every worktree reads as claimed, so
// automatic removal stops, because it cannot tell which worktrees active plans still need.
const UNREADABLE_CLAIMS = Object.freeze({ has: () => true, unreadable: true });

// Worktrees a plan in a worktree-bound stage (Active or Review) still claims. A plan under review
// keeps its worktree until /plan-close or /plan-archive releases it. A repository with no store has
// no plans, so nothing is claimed. Starting a plan requires a worktree, so a worktree-bound plan
// without a readable id and worktree, or a missing worktree-bound folder, makes the claims unknown.
export function activeWorktreeNames(mainPath) {
  const store = locateStore(mainPath);
  if (!store) return new Set();
  try {
    if (store.missing || !fs.statSync(path.join(store.root, PLANS_DIR)).isDirectory()) return UNREADABLE_CLAIMS;
    const files = [...LIFECYCLE_MODEL.worktreeBound].flatMap((lifecycle) => planFiles(store.root, lifecycle, { required: true }));
    const claims = new Set();
    for (const file of files) {
      const { id, worktree } = planFields(file);
      if (!id || !worktree) return UNREADABLE_CLAIMS;
      claims.add(worktree);
    }
    return claims;
  } catch { return UNREADABLE_CLAIMS; }
}

// The worktree a plan names, found by id, store-relative path, or file name in any lifecycle folder.
export function findPlanWorktree(mainPath, plan, { completed = false } = {}) {
  const record = findPlan(mainPath, plan);
  if (completed && record && record.lifecycle !== "completed") throw new Error("plan must be completed before discarding leftovers");
  return record?.worktree || null;
}

// The absorbing commit the plan's `## Verification` records, for cleanup to verify instead of
// rescanning base history.
export function findPlanAbsorbingCommit(mainPath, plan) {
  const file = findPlan(mainPath, plan)?.file;
  if (!file) return null;
  try { return recordedAbsorbingCommit(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

function findPlan(mainPath, plan) {
  const store = locateStore(mainPath);
  if (!store || store.missing) return null;
  for (const lifecycle of LIFECYCLE_MODEL.folders) {
    let files;
    try { files = planFiles(store.root, lifecycle); } catch { continue; }
    for (const file of files) {
      let fields;
      try { fields = planFields(file); } catch { continue; }
      if (fields.id === plan || file === path.join(store.root, plan) || file === path.resolve(plan) || path.basename(file) === plan) return { file, lifecycle, worktree: fields.worktree };
    }
  }
  return null;
}
