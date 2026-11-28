import { isDeepStrictEqual } from "node:util";
import { capabilityHostNames, forgeProviderById, providerForRemoteUrl } from "../forge/index.mjs";
import { runGitProcess } from "../repositories/git-exec.mjs";
import { GIT_NETWORK_TIMEOUT_MS } from "../repositories/git-remote-operations.mjs";

// Delivery refuses any remote that no forge provider with pull requests parses before it reaches a
// host call; the provider that parsed the remote makes every call that follows.
const pullRequestProvider = (url) => {
  const found = providerForRemoteUrl(url);
  return found?.provider.manifest.capabilities.includes("pull-requests") ? found : null;
};

async function git(cwd, args) {
  const result = await runGitProcess(cwd, args, { timeoutMs: GIT_NETWORK_TIMEOUT_MS });
  if (!result.ok) throw new Error(result.stderr || result.error || "Git operation failed");
  return result.stdout.trim();
}

// `git config` exits 1 for a missing key; callers report that as unset rather than as a command
// failure. Any other failure is a real error.
async function gitConfigValues(cwd, key) {
  const result = await runGitProcess(cwd, ["config", "--get-all", key], { timeoutMs: GIT_NETWORK_TIMEOUT_MS });
  if (result.ok) return result.stdout.trim().split("\n").filter(Boolean);
  if (result.code === 1) return [];
  throw new Error(result.stderr || result.error || "Git operation failed");
}

async function requireConfiguredRemote(cwd, remote) {
  if (typeof remote !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(remote)) {
    throw new Error(`Expected a configured remote name, got ${describeRemoteArgument(remote)}`);
  }
  const refFormat = await runGitProcess(cwd, ["check-ref-format", `refs/remotes/${remote}/probe`], { timeoutMs: GIT_NETWORK_TIMEOUT_MS });
  if (!refFormat.ok) throw new Error(`Remote name ${JSON.stringify(remote)} is not a valid tracking-ref namespace`);
  const remotes = (await git(cwd, ["remote"])).split("\n");
  if (!remotes.includes(remote)) throw new Error(`Unknown configured remote: ${remote}`);
}

export async function fetchTrackingRefs(cwd, remote) {
  await requireConfiguredRemote(cwd, remote);
  // A remote's configured refspecs may write local branches. An empty refmap suppresses
  // those mappings, while the sole explicit destination stays inside its tracking namespace.
  const result = await runGitProcess(cwd, [
    "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "protocol.ext.allow=never",
    "fetch", "--no-tags", "--no-prune", "--no-prune-tags", "--no-recurse-submodules",
    "--refmap=", "--", remote, `+refs/heads/*:refs/remotes/${remote}/*`,
  ], { timeoutMs: GIT_NETWORK_TIMEOUT_MS, keepAgentGitConfig: true });
  // Git's fetch diagnostics quote the remote URL, and a URL path can carry a token that Git's
  // own credential stripping misses, so the refusal names the remote but not Git's output.
  if (!result.ok) {
    throw new Error(`Fetch from remote ${remote} failed (exit ${result.code ?? "unknown"}); Git's output is not printed because it can include the remote URL`);
  }
  return `Refreshed refs/remotes/${remote}/*`;
}

// Remote URLs and paths can carry tokens in forms no redaction pattern reliably catches, and
// refusals reach agent transcripts, so refusals name the remote and which URL failed but never
// print a URL or path.
function describeRemoteArgument(value) {
  const text = String(value);
  return /^[A-Za-z0-9._-]+$/.test(text) ? JSON.stringify(text) : "a URL, path, or other non-name value (not printed)";
}

// Names every failed condition so a refusal shows which target mismatched, not only that one did.
function refuseMismatches(summary, checks) {
  const failed = checks.filter(([ok]) => !ok).map(([, detail]) => detail);
  if (failed.length > 0) throw new Error(`${summary}: ${failed.join("; ")}`);
}

async function localDeliveryTarget(cwd) {
  const symbolic = await runGitProcess(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], { timeoutMs: GIT_NETWORK_TIMEOUT_MS });
  // `symbolic-ref --quiet` exits 1 only for a detached HEAD; anything else is a repository error.
  if (symbolic.code === 1) throw new Error("HEAD is detached; delivery needs a checked-out feature branch");
  if (!symbolic.ok) throw new Error(symbolic.stderr || symbolic.error || "Git operation failed");
  const branch = symbolic.stdout.trim();
  const head = await git(cwd, ["rev-parse", "--verify", "HEAD"]);
  const remotes = await gitConfigValues(cwd, `branch.${branch}.remote`);
  if (remotes.length !== 1) {
    throw new Error(remotes.length === 0 ? `No branch.${branch}.remote is configured` : `Multiple branch.${branch}.remote values are configured`);
  }
  const [remote] = remotes;
  await requireConfiguredRemote(cwd, remote);
  const merges = await gitConfigValues(cwd, `branch.${branch}.merge`);
  const upstream = merges.join("\n");
  if (upstream !== `refs/heads/${branch}`) {
    // The merge setting is free-form config and can hold a credentialed URL; print only a ref.
    const shown = merges.length === 0 ? "none configured"
      : merges.length > 1 ? `${merges.length} merge values`
        : /^refs\/[A-Za-z0-9._/-]+$/.test(upstream) ? upstream : "a non-ref value (not printed)";
    throw new Error(`Upstream must name the current branch: ${shown}, expected refs/heads/${branch}`);
  }
  const fetchUrls = await git(cwd, ["remote", "get-url", "--all", remote]);
  const pushUrls = await git(cwd, ["remote", "get-url", "--push", "--all", remote]);
  const fetched = pullRequestProvider(fetchUrls);
  const pushed = pullRequestProvider(pushUrls);
  const hosts = capabilityHostNames("pull-requests");
  refuseMismatches(`Remote ${remote} must resolve to one matching ${hosts} fetch and push repository`, [
    [Boolean(fetched), `its fetch URL is not one ${hosts} repository URL`],
    [Boolean(pushed), `its push URL is not one ${hosts} repository URL`],
    [!fetched || !pushed || (pushed.provider === fetched.provider && pushed.host === fetched.host && pushed.repo === fetched.repo),
      "its push URL names a different repository than its fetch URL"],
  ]);
  // `repo` is `<host>/<owner>/<name>`, the form every provider call pins its host with.
  const repo = `${fetched.host}/${fetched.repo}`;
  return { branch, head, remote, upstream, fetchUrls, pushUrls, repo, providerId: fetched.provider.id };
}

const pullRequestsOf = (target) => forgeProviderById(target.providerId).adapters.pullRequests;

async function currentPullRequest(cwd) {
  const target = await localDeliveryTarget(cwd);
  const { repo, branch, head } = target;
  const host = pullRequestsOf(target);
  const ownerRepo = repo.slice(repo.indexOf("/") + 1);
  const repoInfo = await host.repositoryInfo(cwd, repo);
  const repositoryUrl = host.repositoryUrl(repo);
  refuseMismatches("Pull request delivery requires a feature branch in the configured repository", [
    [repoInfo.url?.toLowerCase() === repositoryUrl, `repository url is ${repoInfo.url}, expected ${repositoryUrl}`],
    [repoInfo.fullName?.toLowerCase() === ownerRepo, `repository is ${repoInfo.fullName}, expected ${ownerRepo}`],
    [Boolean(repoInfo.defaultBranch), "repository reports no default branch"],
    [repoInfo.defaultBranch !== branch, `current branch ${branch} is the default branch`],
  ]);
  const prs = await host.findPullRequests(cwd, repo, branch);
  if (!Array.isArray(prs) || prs.length !== 1) {
    throw new Error(`Expected exactly one open pull request for ${branch}, found ${Array.isArray(prs) ? prs.length : "an unreadable list"}`);
  }
  const pr = prs[0];
  refuseMismatches("Pull request does not match the current feature branch", [
    [Number.isSafeInteger(pr.number) && pr.number >= 1, `number ${pr.number} is not a valid pull request number`],
    [pr.state === "OPEN", `state is ${pr.state}, expected OPEN`],
    [pr.isCrossRepository === false, "head is in another repository"],
    [pr.headRefName === branch, `head branch is ${pr.headRefName}, expected ${branch}`],
    [pr.headRefOid === head, `head commit is ${pr.headRefOid}, expected pushed head ${head}`],
    [Boolean(pr.baseRefName) && pr.baseRefName !== branch, `base branch ${pr.baseRefName} must differ from ${branch}`],
    [pr.url?.toLowerCase() === host.pullRequestUrl(repo, pr.number), `url is ${pr.url}, expected ${host.pullRequestUrl(repo, pr.number)}`],
  ]);
  return { pr, target };
}

export async function updatePullRequest(cwd, operation, value) {
  if (!["pr-body", "pr-ready", "retry-ci"].includes(operation)) throw new Error(`Disallowed delivery operation: ${JSON.stringify(operation)}`);
  if (operation === "retry-ci" && (!/^[1-9][0-9]*$/.test(value || "") || !Number.isSafeInteger(Number(value)))) {
    throw new Error("Expected a numeric workflow run ID");
  }
  if (operation === "pr-body" && typeof value !== "string") throw new Error("Expected a UTF-8 pull request body");
  const { pr, target } = await currentPullRequest(cwd);
  const { repo, branch, head } = target;
  const host = pullRequestsOf(target);
  if (operation === "retry-ci") {
    const run = await host.checkRun(cwd, repo, value);
    const runUrl = host.checkRunUrl(repo, value);
    refuseMismatches("Workflow run must be a failed completed run for this repository and current PR head", [
      [String(run.id) === value, `run id is ${run.id}, expected ${value}`],
      [run.headBranch === branch, `run branch is ${run.headBranch}, expected ${branch}`],
      [run.headSha === head, `run commit is ${run.headSha}, expected pushed head ${head}`],
      [run.url?.toLowerCase() === runUrl, `run url is ${run.url}, expected ${runUrl}`],
      [run.status === "completed", `run status is ${run.status}, expected completed`],
      [run.conclusion === "failure", `run conclusion is ${run.conclusion}, expected failure`],
    ]);
  }
  // Host reads can take long enough for another session to change the selected repository.
  const current = await localDeliveryTarget(cwd);
  // Names only the changed keys: the target holds remote URLs, which can carry tokens.
  const changed = Object.keys(target).filter((key) => !isDeepStrictEqual(current[key], target[key]));
  if (changed.length > 0) {
    throw new Error(`Current branch, head, or upstream configuration changed during pull request validation: ${changed.join(", ")}`);
  }
  if (operation === "pr-body") {
    await host.editBody(cwd, repo, pr.number, value);
  } else if (operation === "pr-ready") {
    await host.markReady(cwd, repo, pr.number);
  } else {
    await host.rerunFailedChecks(cwd, repo, value);
  }
  return `${operation} completed for ${pr.url} at ${head}`;
}
