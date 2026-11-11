import fs from "node:fs";
import path from "node:path";
import { walkRepositoryRoots } from "../repositories/index.mjs";
import { parseFrontmatter } from "./index.mjs";
import { generatePlanId } from "./plan-id.mjs";
import { PLANS_DIR, locateStore, mutateStore } from "./plan-store.mjs";

// Scaffold text is deliberately generic and non-empty for `next_action`, which every actionable
// lifecycle requires, so a repaired file reads as a real plan and not only as parseable.
const SCAFFOLD_NEXT_ACTION = "Fill in the next concrete task.";

export function slugFromFilename(absolutePath) {
  return path
    .basename(absolutePath, ".md")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Repair mints a fresh opaque id rather than deriving one from the filename. A derived id would be
// wrong the first time the file is renamed, and repaired files are exactly the ones with no
// identity to preserve — there is nothing pointing at them yet.
export function scaffoldFrontmatter() {
  const id = generatePlanId();
  return [
    "---",
    `id: ${id}`,
    `next_action: ${SCAFFOLD_NEXT_ACTION}`,
    "blocked_by: []",
    "depends_on: []",
    "related: []",
    "reviewed_commit:",
    "worktree:",
    "---",
    "",
    "",
  ].join("\n");
}

// A file has zero frontmatter only when it doesn't start with `---\n` at all — the same check
// parseFrontmatter uses to emit MISSING_FRONTMATTER. Files with an opening `---` but no closing
// `---` (UNCLOSED_FRONTMATTER) are a different, out-of-scope failure mode and are left alone.
export function hasNoFrontmatter(markdown) {
  const { findings } = parseFrontmatter(markdown);
  return findings.some((item) => item.code === "MISSING_FRONTMATTER");
}

// Scans every repository under `discoveryRoot` (the repository domain's bounded walk, so the same
// eligibility rule as a directory source) that has a plans worktree, for plan docs with zero frontmatter.
export function findPlansMissingFrontmatter(discoveryRoot) {
  const { repositories: roots, errors } = walkRepositoryRoots([discoveryRoot]);
  const affected = [];
  for (const root of roots) {
    const store = locateStore(root);
    if (!store || store.missing) continue;
    const files = [];
    walkPlanFiles(path.join(store.root, PLANS_DIR), files);
    for (const absolutePath of files.sort()) {
      if (hasNoFrontmatter(fs.readFileSync(absolutePath, "utf8"))) {
        affected.push({ repository: path.basename(root), repositoryRoot: root, store, absolutePath, relativePath: path.relative(store.root, absolutePath).split(path.sep).join("/") });
      }
    }
  }
  return { affected, errors };
}

export async function repairPlansMissingFrontmatter(discoveryRoot, { dryRun = false } = {}) {
  const { affected, errors } = findPlansMissingFrontmatter(discoveryRoot);
  const repaired = [];
  for (const item of affected) {
    if (!dryRun) {
      await mutateStore({
        store: item.store,
        operation: () => ({
          files: { [item.relativePath]: scaffoldFrontmatter() + fs.readFileSync(item.absolutePath, "utf8") },
          message: `Scaffold frontmatter for ${path.basename(item.relativePath, ".md")}`,
          result: {},
        }),
      });
    }
    repaired.push(item);
  }
  return { repaired, errors };
}

function walkPlanFiles(dir, files) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name.endsWith("~") || entry.name.endsWith(".swp")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkPlanFiles(full, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) files.push(full);
  }
}
