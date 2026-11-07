#!/usr/bin/env node
// One-time move of a repo's plans from `docs/plans/` on the code branch to `plans/` on `repo-plans`.
// Operator-only and temporary: the package does not ship scripts/dev/, and this file is deleted, with
// scripts/test/migrate-plans-once-check.mjs and its check-groups.json entry, once every repo has moved.
//
// Rollout, for each repo:
//   1. Merge the change that introduces the plans store, then run `roborepo update`.
//   2. Run /plan-suite-init in the repo. It confirms the worktree root and creates the store.
//   3. From a checkout of the repo: node <roborepo>/scripts/dev/migrate-plans-once.mjs
//   4. Check the report, then remove `docs/plans/**` from the code branch in its own reviewable commit:
//        git rm -r docs/plans && git commit -m "Remove plans moved to the repo-plans branch"
//      Feature branches may need ordinary merge cleanup afterward.
//   5. For a plan still in review, rerun /plan-review if the branch merges that removal: its approval
//      goes stale, because the code gates no longer exclude that path.
// In the RoboRepo repo, finish with /plan-close for the plan that delivered this helper.
//
// It never deletes the source files or changes a code branch. A plan in active/ or review/ that names a
// worktree takes its lifecycle from the primary copy and its content from that worktree's copy.
import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "../../modules/plan-suite/index.mjs";
import { git, findLinkedWorktree } from "../../modules/plan-suite/plan-git.mjs";
import { PLANS_DIR, mutateStore, readStoreConfig, requireStore, storeDestination } from "../../modules/plan-suite/plan-store.mjs";

const SOURCE_DIR = "docs/plans";
const WORKTREE_BOUND = ["active", "review"];
const METADATA = new Set(["plans-config.json", "plans-order.json"]);

class RefusedImport extends Error {
  constructor(problems) {
    super("refused");
    this.problems = problems;
  }
}

const stop = (problems) => {
  console.error(`Nothing was migrated:\n${problems.map((item) => `- ${item}`).join("\n")}`);
  process.exit(1);
};

function walk(folder, prefix = "") {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(prefix, entry.name);
    return entry.isDirectory() ? walk(path.join(folder, entry.name), relative) : [relative];
  });
}

function worktreeCopy({ primary, relative, content }) {
  const [lifecycle, ...rest] = relative.split("/");
  if (!WORKTREE_BOUND.includes(lifecycle)) return { content };
  const { id, worktree } = parseFrontmatter(content).frontmatter;
  if (!worktree) return { content };
  let linked = null;
  try {
    linked = findLinkedWorktree(primary, String(worktree));
  } catch (err) {
    if (err.code !== "PLAN_NOT_FOUND") throw err;
  }
  if (!linked) return { problem: `${relative} names worktree ${worktree}, which does not exist` };
  for (const folder of WORKTREE_BOUND) {
    const copy = path.join(linked.path, SOURCE_DIR, folder, ...rest);
    if (!fs.existsSync(copy)) continue;
    const copied = fs.readFileSync(copy, "utf8");
    if (String(parseFrontmatter(copied).frontmatter.id || "") === String(id || "")) return { content: copied, carried: String(worktree) };
    return { problem: `${relative}: the copy in worktree ${worktree} has a different id` };
  }
  return { problem: `${relative}: worktree ${worktree} holds no copy of this plan` };
}

function sourceFiles(primary, source) {
  const problems = [];
  const files = {};
  const carried = [];
  const skipped = [];
  for (const relative of walk(source)) {
    const target = `${PLANS_DIR}/${relative}`;
    if (METADATA.has(relative)) {
      files[target] = fs.readFileSync(path.join(source, relative), "utf8");
    } else if (relative.endsWith(".md")) {
      const result = worktreeCopy({ primary, relative, content: fs.readFileSync(path.join(source, relative), "utf8") });
      if (result.problem) problems.push(result.problem);
      else files[target] = result.content;
      if (result.carried) carried.push(`${relative} (from ${result.carried})`);
    } else if (path.posix.basename(relative) !== ".gitkeep") {
      skipped.push(relative);
    }
  }
  return { files, carried, skipped, problems };
}

function locationProblem(store, sourceConfig) {
  if (!sourceConfig.worktreeRoot) return null;
  const expected = storeDestination({ ...sourceConfig, worktreeRepoName: sourceConfig.worktreeRepoName || readStoreConfig(store.root).worktreeRepoName }, store.primary);
  const [want, have] = [expected, store.root].map((item) => (fs.existsSync(item) ? fs.realpathSync(item) : path.resolve(item)));
  return want === have ? null : `the old config puts the plans worktree at ${want}, but it is at ${have}. Correct the old config, or rerun /plan-suite-init with that root`;
}

const store = requireStore(process.cwd());
const source = path.join(store.primary, SOURCE_DIR);
if (!fs.existsSync(source)) stop([`${source} does not exist`]);

const configFile = path.join(source, "plans-config.json");
const sourceConfig = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, "utf8")) : {};
const location = locationProblem(store, sourceConfig);
const { files, carried, skipped, problems } = sourceFiles(store.primary, source);
if (location) problems.push(location);
if (problems.length) stop(problems);

// The store's location keys stay as `plans init` recorded them when the old config has none.
const initialized = readStoreConfig(store.root);
files[`${PLANS_DIR}/plans-config.json`] = `${JSON.stringify({ ...initialized, ...sourceConfig }, null, 2)}\n`;

const result = await mutateStore({
  store,
  operation: ({ root }) => {
    const changes = {};
    const refused = [];
    for (const [target, content] of Object.entries(files)) {
      const destination = path.join(root, target);
      const current = fs.existsSync(destination) ? fs.readFileSync(destination, "utf8") : null;
      if (current === content) continue;
      if (current !== null && target.endsWith(".md")) refused.push(`${target} already exists with different content`);
      changes[target] = content;
    }
    // Thrown, not exited, so the store releases its lock.
    if (refused.length) throw new RefusedImport(refused);
    return { files: changes, message: "Import plans from docs/plans", result: { imported: Object.keys(changes) } };
  },
}).catch((err) => {
  if (err instanceof RefusedImport) stop(err.problems);
  throw err;
});
if (!result.synchronized) stop([`the commit is local only and did not reach the remote: ${result.reason}. Fix the remote, then rerun`]);

// Trust the remote, not the push's exit status: every file must read back byte for byte.
const fetched = git(store.root, ["fetch", "--quiet", "origin", "refs/heads/repo-plans:refs/remotes/origin/repo-plans"]);
if (!fetched.ok) stop([`could not read the remote back: ${fetched.stderr}`]);
const mismatched = Object.entries(files).filter(([target, content]) => git(store.root, ["show", `origin/repo-plans:${target}`]).raw !== content).map(([target]) => target);
if (mismatched.length) {
  console.error(`The remote does not match these files:\n${mismatched.join("\n")}`);
  process.exit(1);
}

console.log(`Migrated ${Object.keys(files).length} files to origin/repo-plans (${result.imported.length} new or changed).`);
if (carried.length) console.log(`Content from worktrees:\n  ${carried.join("\n  ")}`);
if (skipped.length) console.log(`Not plans, left in place:\n  ${skipped.join("\n  ")}`);
console.log("Next: remove docs/plans/** from the code branch in its own commit. Then delete this helper once every repo has moved.");
