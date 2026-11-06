import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { GIT_MAX_BINARY_BUFFER, runGitProcess } from "./git-exec.mjs";
import { inspectCommitLanding, defaultLandingBase } from "./worktree-landed.mjs";
import { assessSnapshotPreservation } from "./worktree-preservation.mjs";
import { readSnapshot, required, SNAPSHOT_PREFIX } from "./worktree-snapshot.mjs";

export const BACKUP_PREFIX = "refs/roborepo/abandoned/";

// Approval binds the exact inventory and its resolutions. It is never inferred from ref names,
// archive age, or the snapshot commit's parent alone.
export async function legacyRecovery(cwd, { discard = [], approve = null, apply = false, base = null, runGit = runGitProcess } = {}) {
  base ||= await defaultLandingBase((args) => runGit(cwd, args));
  const resolvedBase = base ? await runGit(cwd, ["rev-parse", "--verify", `${base}^{commit}`]) : null;
  const baseCommit = resolvedBase?.ok ? resolvedBase.stdout.trim() : null;
  const baseChecks = baseCommit ? await baseRefChecks(cwd, base, baseCommit, runGit) : null;
  const requested = new Set(discard);
  if ([...requested].some((ref) => typeof ref !== "string" || (!ref.startsWith(BACKUP_PREFIX) && !ref.startsWith(SNAPSHOT_PREFIX)))) throw new Error("--discard requires an exact legacy recovery ref");
  const raw = required(await runGit(cwd, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(creatordate:iso-strict)", BACKUP_PREFIX, SNAPSHOT_PREFIX], { maxBuffer: GIT_MAX_BINARY_BUFFER }));
  const items = [];
  for (const record of raw.trim().split("\n").filter(Boolean).sort()) {
    const [ref, object, createdAt] = record.split("\0");
    const item = { ref, object, createdAt: null, objectDate: createdAt || null, kind: ref.startsWith(SNAPSHOT_PREFIX) ? "snapshot" : "committed-tip", class: "unknown", paths: [], layerCounts: {}, proof: null, proofLimits: [] };
    try {
      if (item.kind === "snapshot") {
        const { manifest } = await readSnapshot(cwd, object);
        item.createdAt = manifest.createdAt || null;
        item.tip = manifest.tip;
        item.paths = [...new Set([...manifest.index, ...manifest.entries].map((entry) => entry.path))].sort();
        item.layerCounts = { index: manifest.index.length, tracked: 0, untracked: 0, ignored: 0 };
        for (const entry of manifest.entries) item.layerCounts[entry.layer]++;
        if (baseCommit) {
          item.proof = await assessSnapshotPreservation(cwd, manifest, { base: baseCommit, runGit });
          item.class = item.proof.state === "preserved" ? "preserved" : item.proof.state === "remaining" ? "unique" : "unknown";
        }
      } else {
        item.tip = required(await runGit(cwd, ["rev-parse", "--verify", `${object}^{commit}`])).trim();
        item.paths = required(await runGit(cwd, ["ls-tree", "-r", "--name-only", "-z", item.tip], { maxBuffer: GIT_MAX_BINARY_BUFFER })).split("\0").filter(Boolean).sort();
        item.layerCounts = { committed: item.paths.length };
        if (baseCommit) {
          item.proof = await inspectCommitLanding(cwd, item.tip, { base: baseCommit, runGit });
          item.class = item.proof.landed ? "preserved" : item.proof.reason === "not absorbed" ? "unique" : "unknown";
        }
      }
      if (item.class !== "preserved") item.proofLimits.push(item.proof?.reason || "base unavailable");
      else if (!baseChecks) item.proofLimits.push("base cannot be verified atomically");
    } catch (error) {
      item.class = "invalid";
      item.proofLimits.push(error.message);
    }
    item.resolution = requested.has(ref) ? "discard" : item.class === "preserved" && baseChecks ? "delete-preserved" : "keep";
    items.push(item);
  }
  const absent = [...requested].filter((ref) => !items.some((item) => item.ref === ref)).sort();
  const digest = createHash("sha256").update(JSON.stringify({ base, baseCommit, baseChecks, items: items.map(({ ref, object, class: classification, resolution, proof }) => ({ ref, object, class: classification, resolution, evidenceCommit: proof?.evidenceCommit || proof?.absorbingCommit || null, baseCommit: proof?.baseCommit || null })), absent })).digest("hex");
  const proposed = items.filter((item) => item.resolution !== "keep").map((item) => item.ref);
  const result = { ok: true, action: "preview", digest, items, proposed, unresolved: items.filter((item) => item.resolution === "keep").map((item) => item.ref), absent, outcomes: [] };
  if (!apply) return result;
  if (!approve || approve !== digest) return { ...result, ok: false, action: "kept", reason: "legacy recovery inventory changed or approval missing; review the new digest" };
  for (const item of items.filter((entry) => entry.resolution !== "keep")) {
    // Keep the base fixed through deletion and address the recovery ref itself, even if symbolic.
    const deleted = item.resolution === "delete-preserved"
      ? await runGit(cwd, ["update-ref", "--stdin"], {
        input: ["start", ...baseChecks, "option no-deref", `delete ${item.ref} ${item.object}`, "prepare", "commit", ""].join("\n"),
      })
      : await runGit(cwd, ["update-ref", "--no-deref", "-d", item.ref, item.object]);
    result.outcomes.push({ ref: item.ref, object: item.object, ok: deleted.ok, reason: deleted.ok ? null : deleted.error || deleted.stderr || "ref deletion failed" });
  }
  return { ...result, ok: result.outcomes.every((entry) => entry.ok), action: result.outcomes.every((entry) => entry.ok) ? "applied" : "partial" };
}

async function baseRefChecks(cwd, base, commit, runGit) {
  if (base === commit) return [];
  const resolved = base.startsWith("refs/") || base === "HEAD"
    ? base
    : (await runGit(cwd, ["rev-parse", "--symbolic-full-name", "--verify", base])).stdout?.trim();
  const checks = [];
  const seen = new Set();
  let ref = resolved;
  while (ref && !seen.has(ref)) {
    if (ref !== "HEAD" && (!ref.startsWith("refs/") || !(await runGit(cwd, ["check-ref-format", ref])).ok)) return null;
    seen.add(ref);
    const symbolic = await runGit(cwd, ["symbolic-ref", "--quiet", "--no-recurse", ref]);
    if (symbolic.code === 1) return [...checks, "option no-deref", `verify ${ref} ${commit}`];
    if (!symbolic.ok) return null;
    const target = symbolic.stdout.trim();
    if (!target.startsWith("refs/") || !(await runGit(cwd, ["check-ref-format", target])).ok) return null;
    checks.push("option no-deref", `symref-verify ${ref} ${target}`);
    ref = target;
  }
  return null;
}

export async function restoreLegacyBackup(cwd, ref, destination, { apply = false, runGit = runGitProcess } = {}) {
  let target = null;
  let started = false;
  try {
    if (typeof ref !== "string" || !ref.startsWith(BACKUP_PREFIX)) throw new Error("restore requires an exact abandoned ref");
    required(await runGit(cwd, ["check-ref-format", ref]));
    const tip = required(await runGit(cwd, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
    target = path.resolve(destination);
    if (fs.existsSync(target)) throw new Error("restore destination already exists");
    for (let parent = path.dirname(target); ; parent = path.dirname(parent)) {
      try { if (fs.lstatSync(parent).isSymbolicLink()) throw new Error("symlink ancestor in restore destination"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (parent === path.dirname(parent)) break;
    }
    const result = { ok: true, action: "preview", ref, tip, destination: target };
    if (!apply) return result;
    // Restore the resolved object even if another actor moves the backup ref during this call.
    started = true;
    required(await runGit(cwd, ["worktree", "add", "--detach", target, tip], { timeoutMs: 120000 }));
    return { ...result, action: "restored" };
  } catch (error) { return { ok: false, action: "kept", reason: error.message, incompleteDestination: started ? target : null }; }
}

export async function legacyRecoveryCount(cwd, { runGit = runGitProcess } = {}) {
  const output = required(await runGit(cwd, ["for-each-ref", "--format=%(refname)", BACKUP_PREFIX, SNAPSHOT_PREFIX], { maxBuffer: GIT_MAX_BINARY_BUFFER }));
  return output.trim().split("\n").filter(Boolean).length;
}
