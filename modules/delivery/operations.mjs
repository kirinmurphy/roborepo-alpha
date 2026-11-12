import { execFile } from "node:child_process";
import { isDeepStrictEqual, promisify } from "node:util";
import { runGitProcess } from "../repositories/git-exec.mjs";
import { normalizeGitRemote } from "../repositories/identity.mjs";
import { GIT_NETWORK_TIMEOUT_MS } from "../repositories/git-remote-operations.mjs";

const execFileAsync = promisify(execFile);

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
  await git(cwd, [
    "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "protocol.ext.allow=never",
    "fetch", "--no-tags", "--no-prune", "--no-prune-tags", "--no-recurse-submodules",
    "--refmap=", "--", remote, `+refs/heads/*:refs/remotes/${remote}/*`,
  ]);
  return `Refreshed refs/remotes/${remote}/*`;
}

async function gh(cwd, args, input = "") {
  const pending = execFileAsync("gh", args, {
    cwd, encoding: "utf8", timeout: GIT_NETWORK_TIMEOUT_MS, maxBuffer: 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: "1" },
  });
  pending.child.stdin.on("error", () => {});
  pending.child.stdin.end(input);
  const result = await pending;
  return result.stdout;
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
  const githubTransport = /^(?:https:\/\/github\.com\/|ssh:\/\/(?:git@)?github\.com\/|git@github\.com:)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/;
  const repository = normalizeGitRemote(fetchUrls)?.toLowerCase();
  const fetchValid = !fetchUrls.includes("\n") && githubTransport.test(fetchUrls)
    && /^git:github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || "");
  const pushValid = !pushUrls.includes("\n") && githubTransport.test(pushUrls);
  refuseMismatches(`Remote ${remote} must resolve to one matching GitHub fetch and push repository`, [
    [fetchValid, "its fetch URL is not one GitHub repository URL"],
    [pushValid, "its push URL is not one GitHub repository URL"],
    [!fetchValid || !pushValid || normalizeGitRemote(pushUrls)?.toLowerCase() === repository,
      "its push URL names a different repository than its fetch URL"],
  ]);
  const repo = repository.slice(4);
  return { branch, head, remote, upstream, fetchUrls, pushUrls, repo };
}

async function currentPullRequest(cwd) {
  const target = await localDeliveryTarget(cwd);
  const { repo, branch, head } = target;
  const repoInfo = JSON.parse(await gh(cwd, [
    "repo", "view", repo, "--json", "defaultBranchRef,nameWithOwner,url",
  ]));
  refuseMismatches("Pull request delivery requires a feature branch in the configured repository", [
    [repoInfo.url?.toLowerCase() === `https://${repo}`, `repository url is ${repoInfo.url}, expected https://${repo}`],
    [repoInfo.nameWithOwner?.toLowerCase() === repo.slice("github.com/".length),
      `repository is ${repoInfo.nameWithOwner}, expected ${repo.slice("github.com/".length)}`],
    [Boolean(repoInfo.defaultBranchRef?.name), "repository reports no default branch"],
    [repoInfo.defaultBranchRef?.name !== branch, `current branch ${branch} is the default branch`],
  ]);
  const prs = JSON.parse(await gh(cwd, [
    "pr", "list", "--repo", repo, "--head", branch, "--state", "open",
    "--json", "number,headRefName,headRefOid,baseRefName,isCrossRepository,state,url",
  ]));
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
    [pr.url?.toLowerCase() === `https://${repo}/pull/${pr.number}`, `url is ${pr.url}, expected https://${repo}/pull/${pr.number}`],
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
  if (operation === "retry-ci") {
    const run = JSON.parse(await gh(cwd, [
      "run", "view", value, "--repo", repo,
      "--json", "databaseId,headBranch,headSha,status,conclusion,url",
    ]));
    refuseMismatches("Workflow run must be a failed completed run for this repository and current PR head", [
      [String(run.databaseId) === value, `run id is ${run.databaseId}, expected ${value}`],
      [run.headBranch === branch, `run branch is ${run.headBranch}, expected ${branch}`],
      [run.headSha === head, `run commit is ${run.headSha}, expected pushed head ${head}`],
      [run.url?.toLowerCase() === `https://${repo}/actions/runs/${value}`, `run url is ${run.url}, expected https://${repo}/actions/runs/${value}`],
      [run.status === "completed", `run status is ${run.status}, expected completed`],
      [run.conclusion === "failure", `run conclusion is ${run.conclusion}, expected failure`],
    ]);
  }
  // GitHub reads can take long enough for another session to change the selected repository.
  const current = await localDeliveryTarget(cwd);
  // Names only the changed keys: the target holds remote URLs, which can carry tokens.
  const changed = Object.keys(target).filter((key) => !isDeepStrictEqual(current[key], target[key]));
  if (changed.length > 0) {
    throw new Error(`Current branch, head, or upstream configuration changed during pull request validation: ${changed.join(", ")}`);
  }
  if (operation === "pr-body") {
    await gh(cwd, ["pr", "edit", String(pr.number), "--repo", repo, "--body-file", "-"], value);
  } else if (operation === "pr-ready") {
    await gh(cwd, ["pr", "ready", String(pr.number), "--repo", repo]);
  } else {
    await gh(cwd, ["run", "rerun", value, "--repo", repo, "--failed"]);
  }
  return `${operation} completed for ${pr.url} at ${head}`;
}
