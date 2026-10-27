import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectRawAttributes } from "./worktree-snapshot.mjs";
import { runGitProcess } from "./git-exec.mjs";

export const FIRST_PARENT_SCAN_LIMIT = 500;
const GIT_TIMEOUT_MS = 10000;

// A branch is landed only after it carried a commit of its own and some first-parent base commit
// absorbed its current tree. Keeping the absorbing commit makes the answer stable as base moves on.
//
// `recorded` is an absorbing commit an earlier check reported. It is evidence to verify, not a
// result to trust: when it is still a first-parent base commit after the fork and still absorbs the
// branch's current tip, that one merge check replaces the scan (`reused: true`). Otherwise the full
// scan runs as if nothing had been recorded.
async function inspectLanding(cwd, branch, { base = null, recorded = null, scanLimit = FIRST_PARENT_SCAN_LIMIT, runGit = runGitProcess } = {}) {
  const git = (args, options = {}) => runGit(cwd, args, { timeoutMs: GIT_TIMEOUT_MS, ...options });
  const baseRef = base || await defaultBase(git);
  if (!baseRef) return verdict("base unavailable");
  const tipResult = await git(["rev-parse", `refs/heads/${branch}`]);
  if (!tipResult.ok) return verdict("branch unavailable", { base: baseRef });
  const tip = tipResult.stdout.trim();
  const forkResult = await git(["merge-base", baseRef, tip]);
  if (!forkResult.ok) return verdict("fork unavailable", { base: baseRef, tip });
  const fork = forkResult.stdout.trim();

  const reflog = await git(["reflog", "show", "--format=%H", `refs/heads/${branch}`]);
  const reflogEntries = reflog.ok ? lines(reflog.stdout) : [];
  // Without a reflog, a merged branch's original start cannot be reconstructed reliably. A
  // conservative empty own-work range keeps it available for manual review.
  const start = reflogEntries.at(-1) || tip;
  const ownCommitsResult = await git(["rev-list", `${start}..${tip}`]);
  const baseCommitsResult = await git(["rev-list", "--first-parent", baseRef]);
  if (!ownCommitsResult.ok || !baseCommitsResult.ok) return verdict("history unavailable", { base: baseRef, tip, fork });
  const baseFirstParent = new Set(lines(baseCommitsResult.stdout));
  const ownWork = lines(ownCommitsResult.stdout).some((commit) => !baseFirstParent.has(commit));
  if (!ownWork) return verdict("no own work", { base: baseRef, tip, fork, start });

  const candidatesResult = await git(["rev-list", "--first-parent", "--reverse", `${fork}..${baseRef}`]);
  if (!candidatesResult.ok) return verdict("history unavailable", { base: baseRef, tip, fork, start, ownWork });
  const candidates = lines(candidatesResult.stdout);
  const absorbs = async (commit) => {
    for (const source of [commit, tip]) {
      const files = await git(["ls-tree", "-r", "--name-only", "-z", source]);
      if (!files.ok) return null;
      try { await inspectRawAttributes(git, files.stdout.split("\0").filter(Boolean), source); }
      catch { return null; }
    }
    const [merged, tree] = await Promise.all([
      git(["merge-tree", "--write-tree", commit, tip]),
      git(["rev-parse", `${commit}^{tree}`]),
    ]);
    if (!tree.ok || (!merged.ok && merged.code !== 1)) return null;
    return merged.ok && lines(merged.stdout)[0] === tree.stdout.trim();
  };
  const landed = (commit, reused) => verdict("landed", { landed: true, absorbingCommit: commit, reused, base: baseRef, tip, fork, start, ownWork });
  if (recorded && candidates.includes(recorded) && await absorbs(recorded)) return landed(recorded, true);
  if (candidates.length > scanLimit) return verdict("scan limit exceeded", { base: baseRef, tip, fork, start, ownWork });
  for (const commit of candidates) {
    const absorbed = await absorbs(commit);
    if (absorbed === null) return verdict("scan unavailable", { base: baseRef, tip, fork, start, ownWork });
    if (absorbed) return landed(commit, false);
  }
  return verdict("not absorbed", { base: baseRef, tip, fork, start, ownWork });
}

async function defaultBase(git) {
  const remote = await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (remote.ok && remote.stdout.trim()) return remote.stdout.trim();
  for (const name of ["main", "master"]) {
    if ((await git(["rev-parse", "--verify", `refs/heads/${name}`])).ok) return `refs/heads/${name}`;
  }
  return null;
}

function verdict(reason, details = {}) {
  return { landed: false, reason, absorbingCommit: null, ...details };
}

function lines(output) {
  return output.trim().split("\n").filter(Boolean);
}

export async function inspectBranchLanding(cwd, branch, options = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-landing-"));
  try {
    const execute = options.runGit || runGitProcess;
    const deadline = Date.now() + 30000;
    const config = await execute(cwd, ["config", "--null", "--list"]);
    if (!config.ok || /(?:^|\0)(?:merge\.[^\n]+\.driver|filter\.[^\n]+)\n/.test(config.stdout)) return verdict("unsupported Git drivers");
    const objects = await execute(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (!objects.ok) return verdict("object store unavailable");
    fs.mkdirSync(path.join(temporary, "objects"));
    const runGit = (directory, args, settings = {}) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return Promise.resolve({ ok: false, stdout: "", code: null, error: "assessment time limit exceeded" });
      return execute(directory, args, { ...settings, timeoutMs: Math.min(GIT_TIMEOUT_MS, remaining), plumbing: { ...settings.plumbing, objectDirectory: path.join(temporary, "objects"), alternateObjects: path.join(objects.stdout.trim(), "objects") } });
    };
    return await inspectLanding(cwd, branch, { ...options, runGit });
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
