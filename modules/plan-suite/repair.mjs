import fs from "node:fs";
import path from "node:path";
import { discoverRepositories, parseFrontmatter } from "./index.mjs";
import { generatePlanId } from "./plan-id.mjs";

// Scaffold text is deliberately generic and non-empty for `next_action` (required for ready
// backlog/active plans per plan-schema.md) so a repaired file is immediately writable from the
// portal's priority toggle, not just parseable.
const SCAFFOLD_PRIORITY = "none";
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
    `priority: ${SCAFFOLD_PRIORITY}`,
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

// Scans every repository under `discoveryRoot` (same repo-eligibility rule as the portal's
// discoverRepositories: a `.git` or `docs/plans` dir) for plan docs with zero frontmatter.
export function findPlansMissingFrontmatter(discoveryRoot) {
  const { repositories, errors } = discoverRepositories({ discoveryRoots: [discoveryRoot], ignoredDirectories: undefined });
  const affected = [];
  for (const repo of repositories) {
    const plansDir = path.join(repo.root, "docs", "plans");
    const files = [];
    walkPlanFiles(plansDir, files);
    for (const absolutePath of files.sort()) {
      const markdown = fs.readFileSync(absolutePath, "utf8");
      if (hasNoFrontmatter(markdown)) {
        affected.push({ repository: repo.name, repositoryRoot: repo.root, absolutePath, relativePath: path.relative(repo.root, absolutePath) });
      }
    }
  }
  return { affected, errors };
}

export function repairPlansMissingFrontmatter(discoveryRoot, { dryRun = false } = {}) {
  const { affected, errors } = findPlansMissingFrontmatter(discoveryRoot);
  const repaired = [];
  for (const item of affected) {
    if (!dryRun) {
      const markdown = fs.readFileSync(item.absolutePath, "utf8");
      fs.writeFileSync(item.absolutePath, scaffoldFrontmatter() + markdown);
    }
    repaired.push(item);
  }
  return { repaired, errors };
}
