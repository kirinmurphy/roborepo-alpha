// A plan's assigned worktree copy, resolved from the primary checkout the same way the Plans snapshot
// resolves it (plan-authority.mjs), for the operations that judge a worktree-bound plan: the
// completion preflight, approval freshness, and the transitions out of Active and Review.
import fs from "node:fs";
import path from "node:path";
import { lifecycleFromPath, parseFrontmatter, planFilesInRepository } from "./index.mjs";
import { verifiedLandedRecovery } from "./landed-recovery.mjs";
import { resolvePlanAuthority } from "./plan-authority.mjs";
import { linkedWorktreeNamed } from "./plan-git.mjs";

// `record` is the primary checkout's record of the plan. Returns { authority, worktree, copy }:
// `worktree` is { name, path, branch } or null, and `copy` is the worktree's copy of the plan
// ({ relativePath, absolutePath, markdown, lifecycle, worktree }) or null.
export function assignedWorktreeCopy(primary, record) {
  const name = record.plan.worktree;
  const worktree = name ? linkedWorktreeNamed(primary, name) : null;
  const copy = worktree && record.plan.id ? copyWithId(worktree.path, record.plan.id) : null;
  const recovery = worktree && copy ? verifiedLandedRecovery({ primary, relativePath: record.plan.relativePath,
    markdown: fs.readFileSync(path.join(primary, record.plan.relativePath), "utf8"), worktree, copy }) : null;
  const authority = resolvePlanAuthority({
    recovery,
    primary: { lifecycle: record.plan.lifecycle, worktree: name },
    assigned: worktree ? { copy } : null,
  });
  return { authority, worktree, copy };
}

// The markdown the plan currently says, from whichever copy is authoritative.
export function authoritativeMarkdown(primary, record) {
  const resolved = assignedWorktreeCopy(primary, record);
  if (resolved.authority.source === "worktree") return { ...resolved, markdown: resolved.copy.markdown, relativePath: resolved.copy.relativePath };
  return { ...resolved, markdown: fs.readFileSync(path.join(primary, record.plan.relativePath), "utf8"), relativePath: record.plan.relativePath };
}

function copyWithId(checkoutPath, id) {
  const { files } = planFilesInRepository({ root: checkoutPath });
  const matches = [];
  for (const absolutePath of files) {
    let markdown;
    try {
      markdown = fs.readFileSync(absolutePath, "utf8");
    } catch {
      continue;
    }
    const { frontmatter } = parseFrontmatter(markdown);
    if (frontmatter.id !== id) continue;
    const relativePath = path.relative(checkoutPath, absolutePath).split(path.sep).join("/");
    matches.push({
      relativePath,
      absolutePath,
      markdown,
      lifecycle: lifecycleFromPath(relativePath),
      worktree: typeof frontmatter.worktree === "string" ? frontmatter.worktree.trim() : "",
    });
  }
  return matches.length === 1 ? matches[0] : null;
}
