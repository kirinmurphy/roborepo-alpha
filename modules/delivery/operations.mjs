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

async function requireConfiguredRemote(cwd, remote) {
  if (typeof remote !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(remote)) {
    throw new Error("Expected a configured remote name");
  }
  await git(cwd, ["check-ref-format", `refs/remotes/${remote}/probe`]);
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

async function localDeliveryTarget(cwd) {
  const branch = await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const head = await git(cwd, ["rev-parse", "--verify", "HEAD"]);
  const remote = await git(cwd, ["config", "--get", `branch.${branch}.remote`]);
  await requireConfiguredRemote(cwd, remote);
  const upstream = await git(cwd, ["config", "--get-all", `branch.${branch}.merge`]);
  if (upstream !== `refs/heads/${branch}`) throw new Error("Upstream must name the current branch");
  const fetchUrls = await git(cwd, ["remote", "get-url", "--all", remote]);
  const pushUrls = await git(cwd, ["remote", "get-url", "--push", "--all", remote]);
  const githubTransport = /^(?:https:\/\/github\.com\/|ssh:\/\/(?:git@)?github\.com\/|git@github\.com:)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/;
  const repository = normalizeGitRemote(fetchUrls)?.toLowerCase();
  if (!/^git:github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || "")
    || !githubTransport.test(fetchUrls) || !githubTransport.test(pushUrls)
    || normalizeGitRemote(pushUrls)?.toLowerCase() !== repository || fetchUrls.includes("\n") || pushUrls.includes("\n")) {
    throw new Error("Remote must resolve to one matching GitHub fetch and push repository");
  }
  const repo = repository.slice(4);
  return { branch, head, remote, upstream, fetchUrls, pushUrls, repo };
}

async function currentPullRequest(cwd) {
  const target = await localDeliveryTarget(cwd);
  const { repo, branch, head } = target;
  const repoInfo = JSON.parse(await gh(cwd, [
    "repo", "view", repo, "--json", "defaultBranchRef,nameWithOwner,url",
  ]));
  if (repoInfo.url?.toLowerCase() !== `https://${repo}` || repoInfo.nameWithOwner?.toLowerCase() !== repo.slice("github.com/".length)
    || !repoInfo.defaultBranchRef?.name || repoInfo.defaultBranchRef.name === branch) {
    throw new Error("Pull request delivery requires a feature branch in the configured repository");
  }
  const prs = JSON.parse(await gh(cwd, [
    "pr", "list", "--repo", repo, "--head", branch, "--state", "open",
    "--json", "number,headRefName,headRefOid,baseRefName,isCrossRepository,state,url",
  ]));
  if (!Array.isArray(prs) || prs.length !== 1) throw new Error("Expected exactly one open pull request for the current branch");
  const pr = prs[0];
  if (!Number.isSafeInteger(pr.number) || pr.number < 1 || pr.state !== "OPEN"
    || pr.isCrossRepository !== false || pr.headRefName !== branch || pr.headRefOid !== head
    || !pr.baseRefName || pr.baseRefName === branch || pr.url?.toLowerCase() !== `https://${repo}/pull/${pr.number}`) {
    throw new Error("Pull request repository, branch, or pushed head does not match the current feature branch");
  }
  return { pr, target };
}

export async function updatePullRequest(cwd, operation, value) {
  if (!["pr-body", "pr-ready", "retry-ci"].includes(operation)) throw new Error("Disallowed delivery operation");
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
    if (String(run.databaseId) !== value || run.headBranch !== branch || run.headSha !== head
      || run.url?.toLowerCase() !== `https://${repo}/actions/runs/${value}`
      || run.status !== "completed" || run.conclusion !== "failure") {
      throw new Error("Workflow run must be a failed completed run for this repository and current PR head");
    }
  }
  // GitHub reads can take long enough for another session to change the selected repository.
  if (!isDeepStrictEqual(await localDeliveryTarget(cwd), target)) {
    throw new Error("Current branch, head, or upstream configuration changed during pull request validation");
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
