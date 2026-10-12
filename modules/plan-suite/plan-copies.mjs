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
import { checkOutsideEdits, resolvePlanAuthority } from "./plan-authority.mjs";
import { lifecycleFromPath, parseFrontmatter, planFilesInRepository, readPlanRecord, repositoryRecord } from "./index.mjs";

export function scanCheckout(checkout, canonical) {
  const { files, scoped } = planFilesInRepository(repositoryRecord(checkout.path, canonical));
  return { checkout, scoped, copies: files.map((file) => readCopy(file, checkout.path)) };
}

export function selectRecords([primary, ...others]) {
  const worktrees = new Map(others.filter((entry) => entry.checkout.isWorktree).map((entry) => [entry.checkout.label, entry]));
  const records = [];
  const seen = new Set();
  for (const copy of primary.copies) {
    // A repeated id in one checkout is a genuine duplicate; both stay so DUPLICATE_PLAN_ID fires.
    records.push(seen.has(copy.key) ? fullRecord(primary, copy, { source: "primary" }) : authoritativeRecord(primary, copy, worktrees));
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

function authoritativeRecord(primary, copy, worktrees) {
  const assignedEntry = copy.worktree ? worktrees.get(copy.worktree) : null;
  const assignedCopy = assignedEntry?.copies.find((candidate) => candidate.key === copy.key) || null;
  const authority = resolvePlanAuthority({ primary: copy, assigned: assignedEntry ? { copy: assignedCopy } : null });
  if (authority.source === "primary") {
    const record = fullRecord(primary, copy, { source: "primary" });
    return authority.reason ? withFinding(record, "PLAN_WORKTREE_COPY_UNAVAILABLE", { worktree: copy.worktree, reason: authority.reason }) : record;
  }
  const record = fullRecord(assignedEntry, assignedCopy, { source: "worktree", worktree: copy.worktree });
  if (copy.hash === assignedCopy.hash) return record;
  const check = checkOutsideEdits({
    primary: { checkoutPath: primary.checkout.path, relativePath: copy.relativePath, bytes: copy.bytes },
    assigned: { branch: assignedEntry.checkout.branch, bytes: assignedCopy.bytes },
  });
  if (check.state === "outside-edit") return withFinding(record, "PLAN_EDITED_OUTSIDE_WORKTREE", { worktree: copy.worktree, committed: check.committed });
  if (check.state === "unchecked") return withFinding(record, "PLAN_AUTHORITY_UNCHECKED", { worktree: copy.worktree, reason: check.reason });
  return record;
}

function fullRecord(entry, copy, authority) {
  const record = readPlanRecord(entry.scoped, copy.file);
  const { checkout } = entry;
  return {
    ...record,
    checkoutPath: checkout.path,
    plan: { ...record.plan, checkout: checkout.isMain ? null : checkout.label, authority },
  };
}

function withFinding(record, code, meta) {
  const findings = [...record.plan.validation.findings, finding(code, { meta })];
  return { ...record, plan: { ...record.plan, validation: { valid: false, findings, warnings: messagesOf(findings) } } };
}

// The identity, stage, assignment, and bytes of one copy, read without building a record. An
// unreadable copy is keyed by its path, so it never stands in for a plan's other copies.
function readCopy(file, checkoutPath) {
  const relativePath = path.relative(checkoutPath, file).split(path.sep).join("/");
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    return { file, relativePath, key: `path:${file}`, hash: null, bytes: null, lifecycle: lifecycleFromPath(relativePath), worktree: "" };
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
