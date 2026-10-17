// Collecting every checkout's copies of each plan and choosing the one record the snapshot returns.
//
// The first checkout (the primary checkout whenever Git can name one) holds each plan's primary
// copy. A plan the primary checkout also holds is returned from its authoritative copy: the
// assigned worktree's while that copy is usable, the primary copy otherwise. A plan found only
// outside the primary checkout is shown from the first checkout holding it, labeled with that
// checkout, and its edits are written there. Copies in worktrees a plan is not assigned to are
// never read: those worktrees mostly hold an older copy of the primary checkout's plans.
//
// A full plan record costs several Git subprocesses, and a repository can have many worktrees that
// mostly carry identical copies. So only the selected copy gets a full record; every other copy is
// matched from its frontmatter alone.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { finding, messagesOf } from "./findings.mjs";
import { checkOutsideEdits, isWorktreeBound, resolvePlanAuthority } from "./plan-authority.mjs";
import { lifecycleFromPath, parseFrontmatter, planFilesInRepository, readPlanRecord, repositoryRecord } from "./index.mjs";

export function scanCheckout(checkout, canonical) {
  const { files, scoped } = planFilesInRepository(repositoryRecord(checkout.path, canonical));
  const copies = [];
  // An unreadable file is a scan error, not a plan: building its record would throw and fail the
  // whole repository's scan, and in an assigned worktree it must leave the plan's primary copy to
  // stand in with PLAN_WORKTREE_COPY_UNAVAILABLE.
  for (const copy of files.map((file) => readCopy(file, checkout.path))) {
    if (copy.bytes) copies.push(copy);
    else scoped.errors.push({ path: copy.relativePath, error: "could not be read" });
  }
  return { checkout, scoped, copies };
}

export function selectRecords([primary, ...others]) {
  const worktrees = new Map(others.filter((entry) => entry.checkout.isWorktree).map((entry) => [entry.checkout.label, entry]));
  const records = [];
  const seen = new Set();
  for (const copy of primary.copies) {
    // A repeated id in one checkout is a genuine duplicate; both stay so DUPLICATE_PLAN_ID fires.
    records.push(...(seen.has(copy.key) ? [fullRecord(primary, copy, { source: "primary" })] : authoritativeRecords(primary, copy, worktrees)));
    seen.add(copy.key);
  }
  for (const entry of others) {
    const local = new Set();
    for (const copy of entry.copies) {
      if (seen.has(copy.key) && !local.has(copy.key)) continue;
      seen.add(copy.key);
      local.add(copy.key);
      // A plan with no primary copy has no authority to resolve; its `checkout` names where it is.
      records.push(fullRecord(entry, copy, null));
    }
  }
  return records;
}

// The records one primary copy stands for: usually one, from whichever copy is authoritative.
function authoritativeRecords(primary, copy, worktrees) {
  const assignedEntry = copy.worktree ? worktrees.get(copy.worktree) : null;
  const assignedCopies = assignedEntry?.copies.filter((candidate) => candidate.key === copy.key) || [];
  const assignedCopy = assignedCopies.find((candidate) => isWorktreeBound(candidate.lifecycle) && candidate.worktree === copy.worktree) || assignedCopies[0] || null;
  const authority = resolvePlanAuthority({ primary: copy, assigned: assignedEntry ? { copy: assignedCopy } : null });
  if (authority.source === "primary") {
    const record = fullRecord(primary, copy, { source: "primary" });
    return [authority.reason ? withFinding(record, "PLAN_WORKTREE_COPY_UNAVAILABLE", { worktree: copy.worktree, reason: authority.reason }) : record];
  }
  const worktreeAuthority = { source: "worktree", worktree: copy.worktree };
  // The worktree's copy says what the plan is; the primary copy says which stage it is in. During
  // review the two sit at different paths, so the record keeps both.
  const stage = { lifecycle: copy.lifecycle, primaryRelativePath: copy.relativePath };
  // A repeated id in the authoritative checkout is a genuine duplicate, as in the primary checkout:
  // every copy stays so DUPLICATE_PLAN_ID fires, rather than file order silently picking one.
  if (assignedCopies.length > 1) return assignedCopies.map((candidate) => fullRecord(assignedEntry, candidate, worktreeAuthority, stage));
  return [outsideEditChecked(primary, copy, assignedEntry, assignedCopy, fullRecord(assignedEntry, assignedCopy, worktreeAuthority, stage))];
}

function outsideEditChecked(primary, copy, assignedEntry, assignedCopy, record) {
  if (copy.hash === assignedCopy.hash) return record;
  const check = checkOutsideEdits({
    primary: { checkoutPath: primary.checkout.path, relativePath: copy.relativePath, bytes: copy.bytes },
    assigned: { checkoutPath: assignedEntry.checkout.path, branch: assignedEntry.checkout.branch, bytes: assignedCopy.bytes },
  });
  if (check.state === "outside-edit") return withFinding(record, "PLAN_EDITED_OUTSIDE_WORKTREE", { worktree: copy.worktree, committed: check.committed });
  if (check.state === "unchecked") return withFinding(record, "PLAN_AUTHORITY_UNCHECKED", { worktree: copy.worktree, reason: check.reason });
  return record;
}

// `stage` is set only when the record is read from the assigned worktree: the lifecycle the record
// is validated and shown under, and the primary copy's path when it differs from the worktree's.
function fullRecord(entry, copy, authority, stage = null) {
  const record = readPlanRecord(entry.scoped, copy.file, { lifecycle: stage?.lifecycle });
  const { checkout } = entry;
  const primaryRelativePath = stage && stage.primaryRelativePath !== record.plan.relativePath ? { primaryRelativePath: stage.primaryRelativePath } : {};
  return {
    ...record,
    checkoutPath: checkout.path,
    plan: { ...record.plan, ...primaryRelativePath, checkout: checkout.isMain ? null : checkout.label, authority },
  };
}

function withFinding(record, code, meta) {
  const findings = [...record.plan.validation.findings, finding(code, { meta })];
  return { ...record, plan: { ...record.plan, validation: { valid: false, findings, warnings: messagesOf(findings) } } };
}

// The identity, stage, assignment, and bytes of one copy, read without building a record. An
// unreadable copy has null bytes and nothing else.
function readCopy(file, checkoutPath) {
  const relativePath = path.relative(checkoutPath, file).split(path.sep).join("/");
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    return { file, relativePath, bytes: null };
  }
  const { frontmatter } = parseFrontmatter(bytes.toString("utf8"));
  const id = frontmatter.id;
  return {
    file,
    relativePath,
    key: typeof id === "string" && id ? id : `path:${relativePath}`,
    hash: crypto.createHash("sha256").update(bytes).digest("hex"),
    bytes,
    lifecycle: lifecycleFromPath(relativePath),
    worktree: typeof frontmatter.worktree === "string" ? frontmatter.worktree.trim() : "",
  };
}
