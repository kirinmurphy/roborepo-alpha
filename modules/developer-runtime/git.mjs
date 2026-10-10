// Git context for a discovered app's repository root: branch, commit, dirty state, ahead/behind.
//
// Two collection strategies, deliberately split:
//   fs reads     branch, detached HEAD, commit sha, upstream name — cheap, always available, and
//                correct even when the `git` binary is missing entirely.
//   subprocess   dirty, ahead/behind — see modules/repositories/git-exec.mjs for why these cannot
//                be read correctly from the filesystem.
//
// Every field is nullable and `dirty`/`ahead`/`behind` are null (never false/0) when the subprocess
// could not answer. Correct-or-absent: a card that shows nothing is honest, a card that shows
// "clean" for a repo we failed to inspect is a lie the user would act on.
//
// Refs are read from existing local state only. Nothing here contacts a remote — ahead/behind is
// measured against the remote-tracking ref as it was at the user's last fetch, which is exactly the
// "how far ahead am I" question a dashboard should answer without mutating anything.

import fs from "node:fs";
import path from "node:path";
import { realpathOf, resolveGitDir } from "../repositories/identity.mjs";
import { defaultRunGit, GIT_TIMEOUT_MS } from "../repositories/git-exec.mjs";
import { collectBranchSyncFacts } from "../repositories/branch-sync.mjs";
import {
  parseHeadRef,
  parsePackedRefs,
  shortSha,
} from "./git-refs.mjs";

export async function collectGitContext(projectRoot, options = {}) {
  if (!projectRoot) return null;
  const { scanCache = null } = options;
  if (!scanCache) return readGitContext(projectRoot, options);
  // Key on the realpath so a symlinked and unsymlinked path share one entry, matching the discipline
  // localRepositoryIdForRoot enforces for ids.
  const key = realpathOf(projectRoot, options.fsApi || fs);
  return scanCache.get(key, () => readGitContext(projectRoot, options));
}

// Collect once per unique repository root across a set of instances, then hand back a lookup keyed
// by the ORIGINAL projectRoot string so callers can attach results without re-realpathing. N apps in
// one repository cost one collection.
export async function collectGitForRoots(items, options = {}) {
  const { collectGit = collectGitContext } = options;
  const byRoot = new Map();
  const roots = new Set();
  for (const item of items) {
    const root = item?.identity?.projectRoot;
    if (root) roots.add(root);
  }
  await Promise.all(
    Array.from(roots, async (root) => {
      byRoot.set(root, await collectGit(root, options));
    }),
  );
  return byRoot;
}

async function readGitContext(projectRoot, options) {
  const { fsApi = fs, pathApi = path, runGit = defaultRunGit, timeoutMs = GIT_TIMEOUT_MS } = options;

  const resolved = resolveGitDir(projectRoot, { fsApi, pathApi });
  if (!resolved) return unavailable("not-a-git-root");

  const head = parseHeadRef(readText(fsApi, pathApi.join(resolved.gitDir, "HEAD")));
  if (!head) return unavailable("unreadable-head");

  const sha = head.detached
    ? head.head
    : resolveRefSha(head.ref, resolved, { fsApi, pathApi });
  const branchSync = head.branch
    ? await collectBranchSyncFacts(projectRoot, { fsApi, pathApi, runGit, timeoutMs })
    : null;
  const branchFact = branchSync?.branches.find((branch) => branch.name === head.branch) || null;
  const upstream = branchFact?.upstream || null;
  const aheadBehind = branchFact?.trackingState === "ok"
    ? { ahead: branchFact.ahead, behind: branchFact.behind }
    : null;

  // Every subprocess call here is independent, so pay for one round of latency rather than four.
  const [dirty, upstreamTipAt, drift] = await Promise.all([
    readDirty(projectRoot, runGit, timeoutMs),
    upstream ? readCommitTime(projectRoot, upstream, runGit, timeoutMs) : Promise.resolve(null),
    // Gated on upstream for the same reason ahead/behind is: a branch with no upstream is either in
    // a repo with no remote or one never pushed, and in both cases there is no shared baseline to
    // measure drift against. Comparing to a local main would answer a different question.
    upstream ? readBaseDrift(projectRoot, head.branch, runGit, timeoutMs) : Promise.resolve(null),
  ]);

  return {
    branch: head.branch,
    detached: head.detached,
    head: sha,
    shortHead: shortSha(sha),
    dirty,
    ahead: aheadBehind?.ahead ?? null,
    behind: aheadBehind?.behind ?? null,
    upstream,
    // Unix seconds of the remote-tracking tip, i.e. the newest commit we know the remote had as of
    // the last fetch. Paired with fetchedAt so the UI can tell "in sync" from "haven't looked".
    upstreamTipAt,
    // How far this branch has drifted from the repository's base branch. Null on the base branch
    // itself and whenever the base could not be resolved — see resolveBaseBranch.
    baseBranch: drift?.baseBranch ?? null,
    baseBehind: drift?.behind ?? null,
    baseMergeBaseAt: drift?.mergeBaseAt ?? null,
    // Age of the last fetch, which bounds how much any of the above can be trusted. Nothing in this
    // module contacts a remote, so every comparison is only as fresh as this timestamp.
    fetchedAt: readFetchTime(fsApi, pathApi, resolved),
    isWorktree: resolved.isWorktree,
    // Joins this checkout to the plan whose `worktree` frontmatter names it (see resolveGitDir).
    worktreeName: resolved.worktreeName,
    provider: { ok: true, reason: null },
  };
}

// The repository's default branch, used as the drift baseline. `origin/HEAD` is the repo's own
// answer when it is set; main/master are guesses that are right often enough to be worth trying.
// When none resolve we return null and the caller reports no drift at all — a drift number measured
// against the wrong base is worse than no number, since it would be acted on.
async function resolveBaseBranch(cwd, runGit, timeoutMs) {
  const symbolic = await runGit(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], {
    timeoutMs,
  });
  if (symbolic?.ok) {
    const ref = symbolic.stdout.trim();
    if (ref) return ref.replace(/^refs\/remotes\//, "");
  }
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    const verify = await runGit(cwd, ["rev-parse", "--verify", "--quiet", candidate], { timeoutMs });
    if (verify?.ok && verify.stdout.trim()) return candidate;
  }
  return null;
}

// Two facts about the same relationship: how many commits landed on the base that this branch does
// not have (volume of the deferred merge), and when the two last shared history (how stale the
// branch point is). Time predicts conflict pain better than count, so the UI leads with it, but
// both are cheap once the merge-base is known.
async function readBaseDrift(cwd, branch, runGit, timeoutMs) {
  const baseBranch = await resolveBaseBranch(cwd, runGit, timeoutMs);
  if (!baseBranch) return null;
  // On the base branch itself there is no drift to report; comparing it to itself always yields 0
  // and would render a permanently reassuring badge that never means anything.
  if (branch && (baseBranch === branch || baseBranch === `origin/${branch}`)) return null;

  const mergeBase = await runGit(cwd, ["merge-base", "HEAD", baseBranch], { timeoutMs });
  if (!mergeBase?.ok) return null;
  const mergeBaseSha = mergeBase.stdout.trim();
  if (!mergeBaseSha) return null;

  const [behind, mergeBaseAt] = await Promise.all([
    runGit(cwd, ["rev-list", "--count", `HEAD..${baseBranch}`], { timeoutMs }),
    readCommitTime(cwd, mergeBaseSha, runGit, timeoutMs),
  ]);
  return {
    baseBranch,
    behind: behind?.ok ? toCount(behind.stdout) : null,
    mergeBaseAt,
  };
}

// Committer date in Unix seconds for any rev. `%ct` rather than `%at` so the number tracks when the
// commit landed on this history, not when its patch was originally authored — a rebased commit
// keeps an old author date that would overstate staleness.
async function readCommitTime(cwd, rev, runGit, timeoutMs) {
  const result = await runGit(cwd, ["log", "-1", "--format=%ct", rev], { timeoutMs });
  if (!result?.ok) return null;
  return toCount(result.stdout);
}

// FETCH_HEAD's mtime is when `git fetch` last wrote, which is the cheapest honest answer to "how
// current is our picture of the remote". Read from the filesystem rather than a subprocess since it
// is a single stat. Absent on a repo that has never fetched, which is correctly reported as null.
function readFetchTime(fsApi, pathApi, resolved) {
  for (const dir of uniqueDirs(resolved)) {
    try {
      const stat = fsApi.statSync(pathApi.join(dir, "FETCH_HEAD"));
      return Math.floor(stat.mtimeMs / 1000);
    } catch {
      // Try the common dir before giving up: a linked worktree fetches into the primary repository.
    }
  }
  return null;
}

function toCount(stdout) {
  const value = Number.parseInt(String(stdout).trim(), 10);
  return Number.isFinite(value) ? value : null;
}

// A branch ref lives either as a loose file under refs/ or packed into packed-refs. A linked
// worktree keeps its own HEAD and refs in gitDir but shares packed-refs with the primary repository
// via commonDir, so both locations are checked.
function resolveRefSha(ref, resolved, { fsApi, pathApi }) {
  if (!ref) return null;
  // Loose refs in either directory beat packed-refs in either, so these are two ordered passes
  // rather than one interleaved loop.
  const dirs = uniqueDirs(resolved);
  for (const dir of dirs) {
    const loose = readText(fsApi, pathApi.join(dir, ref));
    if (loose && /^[0-9a-f]{40}$/i.test(loose.trim())) return loose.trim().toLowerCase();
  }
  for (const dir of dirs) {
    const packed = readText(fsApi, pathApi.join(dir, "packed-refs"));
    if (!packed) continue;
    const sha = parsePackedRefs(packed).get(ref);
    if (sha) return sha;
  }
  return null;
}

function uniqueDirs({ gitDir, commonDir }) {
  return gitDir === commonDir ? [gitDir] : [gitDir, commonDir];
}

// `--porcelain=v1 -z` gives a stable, machine-readable listing; we only need whether it is empty.
// The file list itself is deliberately discarded — the snapshot is served over HTTP and there is no
// reason to put a user's in-progress filenames on the wire.
async function readDirty(cwd, runGit, timeoutMs) {
  const result = await runGit(cwd, ["status", "--porcelain=v1", "--untracked-files=normal", "-z"], {
    timeoutMs,
  });
  if (!result?.ok) return null;
  return result.stdout.trim().length > 0;
}

function readText(fsApi, filePath) {
  try {
    return fsApi.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function unavailable(reason) {
  return {
    branch: null,
    detached: false,
    head: null,
    shortHead: null,
    dirty: null,
    ahead: null,
    behind: null,
    upstream: null,
    upstreamTipAt: null,
    baseBranch: null,
    baseBehind: null,
    baseMergeBaseAt: null,
    fetchedAt: null,
    isWorktree: false,
    worktreeName: null,
    provider: { ok: false, reason },
  };
}
