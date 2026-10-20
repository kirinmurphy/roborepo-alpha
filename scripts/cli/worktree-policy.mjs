import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rootId } from "../../modules/repositories/identity.mjs";
import { parseFrontmatter } from "../../modules/plan-suite/index.mjs";
import { LIFECYCLE_MODEL } from "../../modules/plan-suite/lifecycle-manifest.mjs";
import { recordedAbsorbingCommit } from "../../modules/plan-suite/landing-gate.mjs";

// What a repository's own files and its registry record say cleanup may touch: the worktree folder
// automatic removal stays inside, and the worktrees active plans still claim.

// The folder automatic removal may act in. A repository's plans config names it for plan-suite
// repositories; any other repository gets the folder its user confirmed when turning cleanup on.
export function worktreeFolder(mainPath, record = null) {
  return configuredRoot(mainPath) || recordedRoot(record);
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
function planFields(file) {
  try {
    const { frontmatter } = parseFrontmatter(fs.readFileSync(file, "utf8"));
    const field = (key) => typeof frontmatter[key] === "string" ? frontmatter[key].trim() : "";
    return { id: field("id"), worktree: field("worktree") };
  } catch { return {}; }
}

function planFiles(mainPath, lifecycle) {
  const dir = path.join(mainPath, "docs/plans", lifecycle);
  try { return fs.readdirSync(dir).filter((file) => file.endsWith(".md")).map((file) => path.join(dir, file)); }
  catch { return []; }
}

// Worktrees a plan in a worktree-bound stage (Active or Review) still claims. A plan under review
// keeps its worktree until /plan-close or /plan-archive releases it.
export function activeWorktreeNames(mainPath) {
  const folders = [...LIFECYCLE_MODEL.worktreeBound];
  return new Set(folders.flatMap((lifecycle) => planFiles(mainPath, lifecycle)).map((file) => planFields(file).worktree).filter(Boolean));
}

// The worktree a plan names, found by id, path, or file name in any lifecycle folder.
export function findPlanWorktree(mainPath, plan) {
  return findPlan(mainPath, plan)?.worktree || null;
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
  for (const lifecycle of LIFECYCLE_MODEL.folders) {
    for (const file of planFiles(mainPath, lifecycle)) {
      const fields = planFields(file);
      if (fields.id === plan || file === path.resolve(plan) || path.basename(file) === plan) return { file, worktree: fields.worktree };
    }
  }
  return null;
}
