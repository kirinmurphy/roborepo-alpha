import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { withTemporaryStorage } from "./temporary-storage.mjs";
import { inspectBranchLanding, inspectCommitLanding, FIRST_PARENT_SCAN_LIMIT } from "./worktree-landed.mjs";
import { GIT_MAX_BINARY_BUFFER, runGitProcess } from "./git-exec.mjs";
import { inventoryWorktree, inspectRawAttributes, required, writeTree } from "./worktree-snapshot.mjs";

// Every proof object is disposable. Neither preview nor a failed proof creates repository refs or
// writes the user's index. Both staged and filesystem versions must be absorbed by ONE candidate.
export async function assessWorktreePreservation(cwd, options = {}) {
  return withTemporaryStorage("preservation", (temporary) => inspectPreservation(cwd, temporary, options));
}

async function inspectPreservation(cwd, temporary, { branch, base = null, recorded = null, timeoutMs = 30000, runGit: executeGit = runGitProcess } = {}) {
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
    inventory = await inventoryWorktree(cwd, { git, deadline });
    if (!branch || inventory.branch !== `refs/heads/${branch}`) throw new Error("worktree branch changed or detached");
    if (!base) {
      const remote = await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
      base = remote.ok ? remote.stdout.trim() : (await git(["rev-parse", "--verify", "refs/heads/main"])).ok ? "refs/heads/main" : "refs/heads/master";
    }
    const baseCommit = required(await git(["rev-parse", base])).trim();
    landing = await inspectBranchLanding(cwd, branch, { base, recorded, runGit });
    const result = (state, reason, extra = {}) => ({ state, reason, landing, fingerprint: inventory.fingerprint, tip: inventory.tip, baseCommit, baseRef: base, remainingPaths, blockingPaths: [], cleanupWarnings: landing?.cleanupWarnings || [], ...extra });
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
    const emptyDirectories = inventory.entries.filter((entry) => entry.mode === "directory").map((entry) => entry.path);
    remainingPaths = [...new Set([...remainingPaths, ...emptyDirectories])].sort();
    const hasLocalContent = remainingPaths.length > 0;
    if (!landing.landed) {
      // Committed differences are remaining work too; local paths alone omit an unlanded branch.
      const committed = await git(["diff", "--name-only", "-z", baseCommit, inventory.tip], { maxBuffer: GIT_MAX_BINARY_BUFFER });
      if (committed.ok) remainingPaths = [...new Set([...remainingPaths, ...committed.stdout.split("\0").filter(Boolean)])].sort();
      return result(landing.reason === "not absorbed" || landing.reason === "no own work" ? "remaining" : "unknown", landing.reason, { hasLocalContent });
    }
    if (emptyDirectories.length) return result("remaining", "empty directories have no retained Git representation", { hasLocalContent });
    if (!hasLocalContent) return result("preserved", null, { evidenceCommit: landing.absorbingCommit, hasLocalContent: false });
    const candidates = required(await git(["rev-list", "--first-parent", "--reverse", `${landing.fork}..${baseCommit}`], { maxBuffer: GIT_MAX_BINARY_BUFFER })).trim().split("\n").filter(Boolean);
    if (candidates.length > FIRST_PARENT_SCAN_LIMIT) throw new Error("scan limit exceeded");
    const proof = await assessLayers({ baseline, index: inventory.index, filesystem, tip: inventory.tip, candidates, landing, git, temporary });
    if (proof.state === "preserved") {
      const fresh = await inventoryWorktree(cwd, { git, deadline });
      if (fresh.fingerprint !== inventory.fingerprint || required(await git(["rev-parse", base])).trim() !== baseCommit) throw new Error("state changed during assessment");
      return result("preserved", null, { ...proof, hasLocalContent: true, remainingPaths: [] });
    }
    return result(proof.state, proof.reason, { hasLocalContent: true });
  } catch (error) {
    return { state: "unknown", reason: error.message, landing, fingerprint: inventory?.fingerprint || null, hasLocalContent: null, remainingPaths, blockingPaths: [], cleanupWarnings: [...(landing?.cleanupWarnings || []), ...(error.cleanupWarnings || [])] };
  }
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

// Legacy manifests already identify immutable raw blobs. Assess those layers directly, without
// restoring or dropping entries through the current disposable-artifact policy.
export async function assessSnapshotPreservation(cwd, manifest, { base = "refs/heads/main", runGit: executeGit = runGitProcess } = {}) {
  return withTemporaryStorage("preservation", async (temporary) => {
    try {
      const common = required(await executeGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
      fs.mkdirSync(path.join(temporary, "objects"));
      const deadline = Date.now() + 30000;
      const git = (args, options = {}) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("assessment time limit exceeded");
        return executeGit(cwd, args, { ...options, timeoutMs: Math.min(10000, remaining), plumbing: { objectDirectory: path.join(temporary, "objects"), alternateObjects: path.join(common, "objects"), ...options.plumbing } });
      };
      const baseCommit = required(await git(["rev-parse", `${base}^{commit}`])).trim();
      const landing = await inspectCommitLanding(cwd, manifest.tip, { base: baseCommit, runGit: executeGit });
      if (!landing.landed) return { state: "unknown", reason: landing.reason, landing, baseCommit };
      if (manifest.entries.some((entry) => entry.mode === "directory")) return { state: "unknown", reason: "captured empty directories have no retained Git representation", landing, baseCommit };
      const baseline = parseTree(required(await git(["ls-tree", "-r", "-z", manifest.tip], { maxBuffer: GIT_MAX_BINARY_BUFFER })));
      const filesystem = manifest.entries;
      if (sameTree(baseline, manifest.index) && sameTree(baseline, filesystem)) return { state: "preserved", evidenceCommit: landing.absorbingCommit, baseCommit, landing, layers: ["committed", "index", "filesystem"] };
      const candidates = required(await git(["rev-list", "--first-parent", "--reverse", `${landing.fork}..${baseCommit}`], { maxBuffer: GIT_MAX_BINARY_BUFFER })).trim().split("\n").filter(Boolean);
      if (landing.proof === "reachable") candidates.unshift(landing.fork);
      if (candidates.length > FIRST_PARENT_SCAN_LIMIT) throw new Error("scan limit exceeded");
      const proof = await assessLayers({ baseline, index: manifest.index, filesystem, tip: manifest.tip, candidates, landing: landing.proof === "reachable" ? { ...landing, absorbingCommit: candidates[0] } : landing, git, temporary });
      return { ...proof, baseCommit, landing, layers: proof.state === "preserved" ? ["committed", "index", "filesystem"] : [] };
    } catch (error) { return { state: "unknown", reason: error.message }; }
  });
}

async function assessLayers({ baseline, index, filesystem, tip, candidates, landing, git, temporary }) {
  let reachedLanding = false;
  let conflicted = false;
  for (const candidate of candidates) {
    if (candidate === landing.absorbingCommit) reachedLanding = true;
    if (!reachedLanding) continue;
    const candidateTree = required(await git(["rev-parse", `${candidate}^{tree}`])).trim();
    const target = parseTree(required(await git(["ls-tree", "-r", "-z", candidate], { maxBuffer: GIT_MAX_BINARY_BUFFER })));
    await inspectRawAttributes(git, target.map((entry) => entry.path), candidate, { indexFile: path.join(temporary, "attributes-index") });
    const parentTree = await writeTree(baseline, git);
    const parent = await syntheticCommit(parentTree, tip, git);
    let absorbs = true;
    for (const layer of [index, filesystem]) {
      const tree = await writeTree(layer, git);
      const synthetic = await syntheticCommit(tree, tip, git);
      const merge = await git(["merge-tree", "--write-tree", `--merge-base=${parent}`, candidate, synthetic], { maxBuffer: GIT_MAX_BINARY_BUFFER });
      if (!merge.ok && merge.code !== 1) throw new Error(String(merge.stderr || "tree merge unavailable").trim());
      if (merge.code === 1) conflicted = true;
      if (!merge.ok || merge.stdout.trim().split("\n")[0] !== candidateTree) { absorbs = false; break; }
    }
    if (absorbs) return { state: "preserved", reason: null, evidenceCommit: candidate };
  }
  return { state: conflicted ? "unknown" : "remaining", reason: conflicted ? "local layer merge conflicted within assessed history" : "local layers not absorbed within assessed history" };
}
