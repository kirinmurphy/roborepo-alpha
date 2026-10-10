import { runGitProcess } from "./git-exec.mjs";

export const FIRST_PARENT_SCAN_LIMIT = 500;
const GIT_TIMEOUT_MS = 10000;

// A branch is landed only after it carried a commit of its own and some first-parent base commit
// absorbed its current tree. Keeping the absorbing commit makes the answer stable as base moves on.
export async function inspectBranchLanding(cwd, branch, { base = null, scanLimit = FIRST_PARENT_SCAN_LIMIT, runGit = runGitProcess } = {}) {
  const git = (args) => runGit(cwd, args, { timeoutMs: GIT_TIMEOUT_MS });
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
  if (candidates.length > scanLimit) return verdict("scan limit exceeded", { base: baseRef, tip, fork, start, ownWork });
  for (const commit of candidates) {
    const [merged, tree] = await Promise.all([
      git(["merge-tree", "--write-tree", commit, tip]),
      git(["rev-parse", `${commit}^{tree}`]),
    ]);
    if (!tree.ok || (!merged.ok && merged.code !== 1)) {
      return verdict("scan unavailable", { base: baseRef, tip, fork, start, ownWork });
    }
    if (merged.ok && tree.ok && lines(merged.stdout)[0] === tree.stdout.trim()) {
      return verdict("landed", { landed: true, absorbingCommit: commit, base: baseRef, tip, fork, start, ownWork });
    }
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
