// One predicate for the evidence-only primary exception. The note names evidence; Git proves it
// anew. General plan edits continue to belong to the assigned worktree.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parsePlanMarkdown } from "./index.mjs";
import { blobId, producedBlobs } from "./plan-authority.mjs";
import { canonicalRepositoryId, resolveProjectIdentity } from "../repositories/identity.mjs";
import { runGitProcessSync } from "../repositories/git-exec.mjs";

const FIELDS = {
  repository: "Repository identity", worktree: "Worktree", branch: "Branch", tip: "Assessed branch tip",
  baseRef: "Base ref", baseCommit: "Base commit", absorbingCommit: "Absorbing commit",
  primaryBlob: "Primary precursor blob", worktreeBlob: "Worktree precursor blob",
};
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export function parseRecoveryRecord(markdown) {
  const lines = unfencedLines(markdown);
  const review = lines.findIndex((line) => /^## Review\s*$/i.test(line));
  if (review < 0) return null;
  let end = lines.findIndex((line, index) => index > review && /^#{1,2} /.test(line));
  if (end < 0) end = lines.length;
  const section = lines.slice(review + 1, end);
  const starts = section.flatMap((line, index) => /^### Post-merge recovery\s*$/i.test(line) ? [index] : []);
  if (starts.length !== 1) return null;
  const rest = section.slice(starts[0] + 1);
  const next = rest.findIndex((line) => /^### /.test(line));
  const body = next < 0 ? rest : rest.slice(0, next);
  const record = {};
  for (const [key, label] of Object.entries(FIELDS)) {
    const pattern = new RegExp(`^[-*] ${label}:\\s*\\x60?([^\\x60]+?)\\x60?\\s*$`, "i");
    const values = body.map((line) => pattern.exec(line)?.[1]).filter(Boolean);
    if (values.length !== 1) return null;
    record[key] = values[0];
  }
  return record;
}

export function verifiedLandedRecovery({ primary, relativePath, markdown, worktree, copy, requireCommitted = true }) {
  const record = parseRecoveryRecord(markdown);
  const fail = (reason) => ({ ok: false, reason });
  if (!record) return fail("no unique recovery record");
  if (!worktree?.branch || !copy?.markdown) return fail("assigned worktree unavailable or detached");
  if (record.repository !== canonicalRepositoryId(resolveProjectIdentity(primary)) || record.worktree !== worktree.name || record.branch !== worktree.branch) return fail("recovery identity mismatch");
  if (![record.tip, record.baseCommit, record.absorbingCommit, record.primaryBlob, record.worktreeBlob].every((value) => SHA.test(value))) return fail("invalid recovery object ids");
  if (!/^refs\/(?:heads|remotes)\/[a-zA-Z0-9._/-]+$/.test(record.baseRef)) return fail("invalid recovery base ref");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-recovery-"));
  try {
    const deadline = Date.now() + 30000;
    const objects = path.resolve(primary, checked(runGitProcessSync(primary, ["rev-parse", "--git-path", "objects"])).trim());
    fs.mkdirSync(path.join(temporary, "objects"));
    const git = (args) => {
      if (Date.now() >= deadline) throw new Error("recovery verification time limit");
      return runGitProcessSync(primary, args, { timeoutMs: Math.min(10000, deadline - Date.now()), plumbing: { objectDirectory: path.join(temporary, "objects"), alternateObjects: objects } });
    };
    const format = checked(git(["rev-parse", "--show-object-format"])).trim();
    const base = checked(git(["rev-parse", record.baseRef])).trim();
    const tip = checked(git(["rev-parse", `refs/heads/${worktree.branch}`])).trim();
    const primaryOid = blobId(Buffer.from(markdown), format);
    if (requireCommitted && checked(git(["rev-parse", `HEAD:${relativePath}`])).trim() !== primaryOid) return fail("primary recovery evidence is not committed");
    if (blobId(Buffer.from(copy.markdown), format) !== record.worktreeBlob) return fail("worktree precursor changed");
    const precursor = checked(git(["cat-file", "blob", record.primaryBlob]));
    if (checked(git(["rev-parse", `${record.baseCommit}:${relativePath}`])).trim() !== record.primaryBlob) return fail("primary precursor not committed at assessed base");
    if (evidenceExcluded(markdown) !== evidenceExcluded(precursor) || evidenceExcluded(copy.markdown) !== evidenceExcluded(precursor)) return fail("recovery changed requirements or conflicts with the worktree copy");
    for (const heading of ["## Review", "### Result", "### Approval", "### Post-merge recovery"]) {
      if (markdown.split("\n").filter((line) => line.trim().toLowerCase() === heading.toLowerCase()).length !== 1) return fail("duplicate or missing recovery review section");
    }
    const current = parsePlanMarkdown(markdown);
    const before = parsePlanMarkdown(precursor);
    if (current.frontmatter.id !== before.frontmatter.id || current.frontmatter.worktree !== record.worktree) return fail("plan identity or assignment mismatch");
    const { result, approval, findings } = current.review;
    if (current.tasks.some((task) => !task.done)) return fail("required checks or findings remain open");
    const other = parsePlanMarkdown(copy.markdown).review;
    if (other.approval?.decision === "approved" && (other.approval.commit !== approval?.commit || other.approval.confirmedBy !== approval?.confirmedBy)) return fail("conflicting approval records");
    if (!result || result.status !== "complete" || !approval || approval.decision !== "approved" || !approval.confirmedBy || findings.open || current.notTested.unchecked) return fail("incomplete review or missing explicit approval");
    if (!SHA.test(result.commit) || !SHA.test(result.baseCommit) || !SHA.test(approval.commit)) return fail("review packet lacks full commit ids");
    if (!git(["cat-file", "-e", `${result.baseCommit}^{commit}`]).ok) return fail("reviewed base is unavailable");
    const staged = runGitProcessSync(worktree.path, ["diff", "--cached", "--name-only"]);
    if (!staged.ok || staged.stdout.trim()) return fail("pending staged work in the assigned worktree");
    for (const reviewed of [record.tip, result.commit, approval.commit]) {
      if (checked(git(["diff", "--name-only", reviewed, tip, "--", ".", ":(exclude)docs/plans"])).trim()) return fail("implementation changed after review or recovery");
    }
    const history = checked(git(["rev-list", "--first-parent", base])).trim().split("\n");
    if (!history.includes(record.baseCommit) || !history.includes(record.absorbingCommit) || history.indexOf(record.absorbingCommit) < history.indexOf(record.baseCommit)) return fail("landing evidence is outside assessed base history");
    const known = producedBlobs(checked(git(["log", "--raw", "--no-abbrev", "--format=", record.baseCommit, "--", "docs/plans"])));
    if (!known.has(record.worktreeBlob) && record.worktreeBlob !== record.primaryBlob) return fail("worktree precursor is not integrated");
    // No repository-provided command may be invoked by merge-tree, even from historical attributes.
    const config = checked(git(["config", "--null", "--list"]));
    if (/(?:^|\0)(?:merge\.[^\n]+\.driver|filter\.[^\n]+)\n/.test(config)) return fail("external Git drivers prevent recovery verification");
    const merged = git(["merge-tree", "--write-tree", record.absorbingCommit, record.tip]);
    if (!merged.ok || merged.stdout.trim().split("\n")[0] !== checked(git(["rev-parse", `${record.absorbingCommit}^{tree}`])).trim()) return fail("recorded base commit does not absorb the assessed branch");
    if (checked(git(["rev-parse", record.baseRef])).trim() !== base || checked(git(["rev-parse", `refs/heads/${worktree.branch}`])).trim() !== tip) return fail("state changed during recovery verification");
    return { ok: true, reason: "verified-landed-recovery", record, tip, base };
  } catch (error) { return fail(error.message); }
  finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

export function evidenceExcluded(markdown) {
  const lines = String(markdown).split("\n");
  const visible = unfencedLines(markdown);
  let inReview = false;
  let omit = false;
  return lines.filter((line, index) => {
    const heading = visible[index];
    if (/^#{1,2} /.test(heading)) { inReview = /^## Review\s*$/i.test(heading); omit = false; }
    if (inReview && /^### /.test(heading)) omit = /^### (?:Result|Approval|Post-merge recovery)\s*$/i.test(heading);
    return !omit;
  }).join("\n").trimEnd();
}

function checked(result) {
  if (!result.ok) throw new Error(String(result.stderr || result.error || "Git recovery verification unavailable").trim());
  return result.stdout;
}

function unfencedLines(markdown) {
  let fence = null;
  return String(markdown).split("\n").map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && !fence) { fence = marker; return ""; }
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length) fence = null;
      return "";
    }
    return line;
  });
}
