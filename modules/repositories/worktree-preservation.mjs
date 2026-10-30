import fs from "node:fs";
import { createHash } from "node:crypto";
import { planEntriesByIdentity } from "../plan-suite/copy-integration.mjs";
import os from "node:os";
import path from "node:path";
import { inspectBranchLanding, FIRST_PARENT_SCAN_LIMIT } from "./worktree-landed.mjs";
import { GIT_MAX_BINARY_BUFFER, runGitProcess } from "./git-exec.mjs";
import { inventoryWorktree, inspectRawAttributes, required, writeTree } from "./worktree-snapshot.mjs";

// Every proof object is disposable. Neither preview nor a failed proof creates repository refs or
// writes the user's index. Both staged and filesystem versions must be absorbed by ONE candidate.
export async function assessWorktreePreservation(cwd, { branch, base = null, recorded = null, timeoutMs = 30000, runGit: executeGit = runGitProcess } = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-preservation-"));
  const deadline = Date.now() + timeoutMs;
  let landing = null;
  let inventory = null;
  let remainingPaths = [];
  try {
    const objects = path.resolve(cwd, required(await executeGit(cwd, ["rev-parse", "--git-path", "objects"])).trim());
    fs.mkdirSync(path.join(temporary, "objects"));
    const plumbing = { objectDirectory: path.join(temporary, "objects"), alternateObjects: objects };
    const runGit = (directory, args, options = {}) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("assessment time limit exceeded");
      return executeGit(directory, args, { ...options, plumbing: { ...plumbing, ...options.plumbing }, timeoutMs: Math.min(10000, remaining) });
    };
    const git = (args, options) => runGit(cwd, args, options);
    inventory = await inventoryWorktree(cwd, { git });
    if (!branch || inventory.branch !== `refs/heads/${branch}`) throw new Error("worktree branch changed or detached");
    if (!base) {
      const remote = await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
      base = remote.ok ? remote.stdout.trim() : (await git(["rev-parse", "--verify", "refs/heads/main"])).ok ? "refs/heads/main" : "refs/heads/master";
    }
    const baseCommit = required(await git(["rev-parse", base])).trim();
    landing = await inspectBranchLanding(cwd, branch, { base, recorded, runGit });
    const result = (state, reason, extra = {}) => ({ state, reason, landing, fingerprint: inventory.fingerprint, tip: inventory.tip, baseCommit, baseRef: base, remainingPaths, blockingPaths: [], ...extra });
    if (landing.tip && landing.tip !== inventory.tip) throw new Error("branch changed during assessment");
    const baseline = parseTree(required(await git(["ls-tree", "-r", "-z", inventory.tip], { maxBuffer: GIT_MAX_BINARY_BUFFER })));
    const objectFormat = required(await git(["rev-parse", "--show-object-format"])).trim();
    if (!["sha1", "sha256"].includes(objectFormat)) throw new Error("unsupported Git object format");
    const knownBlobs = new Set([...baseline, ...inventory.index].map((entry) => entry.oid));
    const filesystem = [];
    for (const entry of inventory.entries) {
      if (entry.mode === "directory") continue;
      // Inventory has already refused filters and conversions. Reuse raw blobs present in the
      // baseline or index; only new bytes need writing to the disposable object store.
      const oid = createHash(objectFormat).update(`blob ${entry.bytes.length}\0`).update(entry.bytes).digest("hex");
      if (!knownBlobs.has(oid)) {
        const written = required(await git(["hash-object", "-w", "--stdin"], { input: entry.bytes })).trim();
        if (written !== oid) throw new Error("filesystem blob identity changed while hashing");
        knownBlobs.add(oid);
      }
      filesystem.push({ path: entry.path, mode: entry.mode, oid });
    }
    const before = new Map(baseline.map((entry) => [entry.path, entry]));
    for (const layer of [inventory.index, filesystem]) {
      const local = new Map(layer.map((entry) => [entry.path, entry]));
      for (const file of new Set([...before.keys(), ...local.keys()])) {
        if (before.get(file)?.oid !== local.get(file)?.oid || before.get(file)?.mode !== local.get(file)?.mode) remainingPaths.push(file);
      }
    }
    remainingPaths = [...new Set(remainingPaths)].sort();
    const hasLocalContent = !sameTree(baseline, inventory.index) || !sameTree(baseline, filesystem) || inventory.entries.some((entry) => entry.mode === "directory");
    if (!landing.landed) {
      // Committed differences are remaining work too; local paths alone omit an unlanded branch.
      const committed = await git(["diff", "--name-only", "-z", baseCommit, inventory.tip], { maxBuffer: GIT_MAX_BINARY_BUFFER });
      if (committed.ok) remainingPaths = [...new Set([...remainingPaths, ...committed.stdout.split("\0").filter(Boolean)])].sort();
      return result(landing.reason === "not absorbed" || landing.reason === "no own work" ? "remaining" : "unknown", landing.reason, { hasLocalContent });
    }
    if (!hasLocalContent) return result("preserved", null, { evidenceCommit: landing.absorbingCommit, hasLocalContent: false });
    const candidates = required(await git(["rev-list", "--first-parent", "--reverse", `${landing.fork}..${baseCommit}`], { maxBuffer: GIT_MAX_BINARY_BUFFER })).trim().split("\n").filter(Boolean);
    if (candidates.length > FIRST_PARENT_SCAN_LIMIT) throw new Error("scan limit exceeded");
    let reachedLanding = false;
    let conflicted = false;
    for (const candidate of candidates) {
      if (candidate === landing.absorbingCommit) reachedLanding = true;
      if (!reachedLanding) continue;
      const candidateTree = required(await git(["rev-parse", `${candidate}^{tree}`])).trim();
      const target = parseTree(required(await git(["ls-tree", "-r", "-z", candidate], { maxBuffer: GIT_MAX_BINARY_BUFFER })));
      await inspectRawAttributes(git, target.map((entry) => entry.path), candidate);
      const mapped = await mapPlanPaths(baseline, inventory.index, filesystem, target, git);
      const parentTree = await writeTree(mapped.baseline, git);
      const parent = await syntheticCommit(parentTree, inventory.tip, git);
      let absorbs = true;
      for (const layer of [mapped.index, mapped.filesystem]) {
        const tree = await writeTree(layer, git);
        const synthetic = await syntheticCommit(tree, inventory.tip, git);
        const merge = await git(["merge-tree", "--write-tree", `--merge-base=${parent}`, candidate, synthetic], { maxBuffer: GIT_MAX_BINARY_BUFFER });
        if (!merge.ok && merge.code !== 1) throw new Error(String(merge.stderr || "tree merge unavailable").trim());
        if (merge.code === 1) conflicted = true;
        if (!merge.ok || merge.stdout.trim().split("\n")[0] !== candidateTree) { absorbs = false; break; }
      }
      if (absorbs) {
        const fresh = await inventoryWorktree(cwd, { git });
        if (fresh.fingerprint !== inventory.fingerprint || required(await git(["rev-parse", base])).trim() !== baseCommit) throw new Error("state changed during assessment");
        return result("preserved", null, { evidenceCommit: candidate, hasLocalContent: true, remainingPaths: [] });
      }
    }
    return result(conflicted ? "unknown" : "remaining", conflicted ? "local layer merge conflicted within assessed history" : "local layers not absorbed within assessed history", { hasLocalContent: true });
  } catch (error) {
    return { state: "unknown", reason: error.message, landing, fingerprint: inventory?.fingerprint || null, hasLocalContent: null, remainingPaths, blockingPaths: [] };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

function parseTree(output) {
  return output.split("\0").filter(Boolean).map((record) => {
    const match = /^(\d+) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error("unsupported tree entry");
    return { path: match[3], mode: match[1], oid: match[2] };
  });
}

function sameTree(left, right) {
  const canonical = (entries) => JSON.stringify(entries.map(({ path, mode, oid }) => ({ path, mode, oid })).sort((a, b) => a.path.localeCompare(b.path)));
  return canonical(left) === canonical(right);
}

async function syntheticCommit(tree, parent, git) {
  return required(await git(["-c", "user.name=RoboRepo", "-c", "user.email=assessment@roborepo.local", "commit-tree", tree, "-p", parent], { input: "Temporary preservation assessment\n" })).trim();
}

async function mapPlanPaths(baseline, index, filesystem, target, git) {
  const [basePlans, indexPlans, fsPlans, targetPlans] = await Promise.all([baseline, index, filesystem, target].map((entries) => planEntriesByIdentity(entries, async (oid) => required(await git(["cat-file", "blob", oid], { maxBuffer: GIT_MAX_BINARY_BUFFER })))));
  const copies = { baseline: baseline.map((entry) => ({ ...entry })), index: index.map((entry) => ({ ...entry })), filesystem: filesystem.map((entry) => ({ ...entry })) };
  for (const [id, before] of basePlans) {
    const after = targetPlans.get(id);
    if (!after || after.path === before.path) continue;
    for (const [layer, planEntries] of [["index", indexPlans], ["filesystem", fsPlans]]) {
      const local = planEntries.get(id);
      if (!local) throw new Error(`ambiguous plan lifecycle deletion: ${id}`);
      const changed = local.oid !== before.oid || local.mode !== before.mode;
      if (changed && (local.oid !== after.oid || local.mode !== after.mode)) throw new Error(`changed plan differs from candidate: ${id}`);
      const entry = copies[layer].find((entry) => entry.path === local.path);
      entry.path = after.path;
      // An unchanged index's old document is covered by committed landing, not local work.
      if (!changed) { entry.oid = after.oid; entry.mode = after.mode; }
    }
    const entry = copies.baseline.find((entry) => entry.path === before.path);
    entry.path = after.path;
    entry.oid = after.oid;
    entry.mode = after.mode;
  }
  return copies;
}
