// The GitHub provider's `repository` and `pull-requests` capabilities: which remote URLs are GitHub
// repos, and the pull request calls `roborepo delivery` makes. Every call names its repo as
// `github.com/<owner>/<name>`, so GH_HOST cannot send it to another instance. The answers keep gh's
// field names, which the contract (modules/forge/contract.mjs) documents as the shared shape.
import { normalizeGitRemote } from "../../../repositories/identity.mjs";
import { githubClient, runGh } from "./client.mjs";

// Only the transports agents' Git is routed through: HTTPS, and SSH, which the package rewrites.
const GITHUB_TRANSPORT = /^(?:https:\/\/github\.com\/|ssh:\/\/(?:git@)?github\.com\/|git@github\.com:)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/;

// `{ host, repo }` (repo as `owner/name`, lowercased) for one GitHub repository URL; null for
// anything else, including a value holding several URLs.
function parseRemote(url) {
  const value = String(url ?? "");
  if (value.includes("\n") || !GITHUB_TRANSPORT.test(value)) return null;
  const id = normalizeGitRemote(value)?.toLowerCase() || "";
  const match = /^git:(github\.com)\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(id);
  return match ? { host: match[1], repo: match[2] } : null;
}

export const githubRepository = {
  parseRemote,
  repository: (context, repo) => githubClient.repository(context, repo),
};

const json = async (cwd, args) => JSON.parse(await runGh(cwd, args));

// `repo` is `github.com/<owner>/<name>`.
export const githubPullRequests = {
  repositoryUrl: (repo) => `https://${repo}`,
  pullRequestUrl: (repo, number) => `https://${repo}/pull/${number}`,
  checkRunUrl: (repo, id) => `https://${repo}/actions/runs/${id}`,

  async repositoryInfo(cwd, repo) {
    const info = await json(cwd, ["repo", "view", repo, "--json", "defaultBranchRef,nameWithOwner,url"]);
    return { url: info.url, fullName: info.nameWithOwner, defaultBranch: info.defaultBranchRef?.name ?? null };
  },
  findPullRequests: (cwd, repo, branch) => json(cwd, [
    "pr", "list", "--repo", repo, "--head", branch, "--state", "open",
    "--json", "number,headRefName,headRefOid,baseRefName,isCrossRepository,state,url",
  ]),
  async checkRun(cwd, repo, id) {
    const run = await json(cwd, ["run", "view", id, "--repo", repo, "--json", "databaseId,headBranch,headSha,status,conclusion,url"]);
    return { id: run.databaseId, headBranch: run.headBranch, headSha: run.headSha, status: run.status, conclusion: run.conclusion, url: run.url };
  },
  editBody: (cwd, repo, number, body) => runGh(cwd, ["pr", "edit", String(number), "--repo", repo, "--body-file", "-"], body),
  markReady: (cwd, repo, number) => runGh(cwd, ["pr", "ready", String(number), "--repo", repo]),
  rerunFailedChecks: (cwd, repo, id) => runGh(cwd, ["run", "rerun", id, "--repo", repo, "--failed"]),
};
