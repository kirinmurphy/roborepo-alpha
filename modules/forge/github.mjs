// The one place RoboRepo runs `gh`. Delivery uses the raw runner; branch protection uses the
// REST calls built on it. Every call names its repository explicitly, so none depends on which
// checkout the process happens to be in.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GIT_NETWORK_TIMEOUT_MS } from "../repositories/git-remote-operations.mjs";

const execFileAsync = promisify(execFile);

export async function runGh(cwd, args, input = "", { timeoutMs = GIT_NETWORK_TIMEOUT_MS } = {}) {
  const pending = execFileAsync("gh", args, {
    cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: "1" },
  });
  pending.child.stdin.on("error", () => {});
  pending.child.stdin.end(input);
  const result = await pending;
  return result.stdout;
}

// Why a GitHub read or write failed, in the two forms callers branch on: `kind: "http"` carries
// the status and message GitHub answered with; `kind: "unavailable"` means no answer was received
// (gh missing, not signed in, timed out, or the network failed) and `message` says which.
export class GitHubError extends Error {
  constructor(kind, message, { status = null } = {}) {
    super(message);
    this.name = "GitHubError";
    this.kind = kind;
    this.status = status;
  }
}

// `gh api` exits non-zero on an HTTP error, with GitHub's JSON error body on stdout and
// "gh: <message> (HTTP <status>)" on stderr.
function describeGhFailure(error) {
  if (error?.code === "ENOENT") return new GitHubError("unavailable", "the GitHub CLI (gh) is not installed");
  const stderr = String(error?.stderr || "");
  const http = stderr.match(/\(HTTP (\d{3})\)/);
  if (http) {
    let message = stderr.replace(/^gh:\s*/, "").replace(/\s*\(HTTP \d{3}\)[\s\S]*$/, "").trim();
    try {
      message = JSON.parse(error.stdout).message || message;
    } catch {}
    return new GitHubError("http", message, { status: Number(http[1]) });
  }
  if (/gh auth login|not logged in|authentication/i.test(stderr)) {
    return new GitHubError("unavailable", "the GitHub CLI is not signed in (run: gh auth login)");
  }
  if (error?.killed || error?.signal) return new GitHubError("unavailable", "GitHub did not answer in time");
  return new GitHubError("unavailable", "GitHub could not be reached");
}

async function api(context, endpoint, { method = "GET", body = null } = {}) {
  const args = ["api", "--method", method, "-H", "Accept: application/vnd.github+json", endpoint];
  if (body) args.push("--input", "-");
  let stdout;
  try {
    stdout = await runGh(context.cwd, args, body ? JSON.stringify(body) : "", { timeoutMs: context.timeoutMs });
  } catch (error) {
    throw describeGhFailure(error);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new GitHubError("unavailable", "GitHub returned a response that could not be read");
  }
}

const repoPath = (repo) => `repos/${repo}`;

// `context` is `{ cwd, timeoutMs }`; `repo` is `owner/name`.
export const githubClient = {
  host: "github.com",
  supported: true,
  run: runGh,

  repository: (context, repo) => api(context, repoPath(repo)),

  async login(context) {
    return (await api(context, "user")).login;
  },

  // Every active rule that applies to the branch, from any ruleset at any level.
  branchRules: (context, repo, branch) => api(context, `${repoPath(repo)}/rules/branches/${encodeURIComponent(branch)}?per_page=100`),

  // The list carries no rules; `ruleset` reads one in full.
  rulesets: (context, repo) => api(context, `${repoPath(repo)}/rulesets?per_page=100`),
  ruleset: (context, repo, id) => api(context, `${repoPath(repo)}/rulesets/${id}`),

  createRuleset: (context, repo, body) => api(context, `${repoPath(repo)}/rulesets`, { method: "POST", body }),
  updateRuleset: (context, repo, id, body) => api(context, `${repoPath(repo)}/rulesets/${id}`, { method: "PUT", body }),

  // Job names from the newest successful workflow run on the branch, or null when it has none.
  // Asking GitHub for `status=success` passes over cancelled and failed runs.
  async latestSuccessfulRunJobs(context, repo, branch) {
    const runs = await api(context, `${repoPath(repo)}/actions/runs?branch=${encodeURIComponent(branch)}&status=success&per_page=1`);
    const run = runs.workflow_runs?.[0];
    if (!run) return null;
    const jobs = await api(context, `${repoPath(repo)}/actions/runs/${run.id}/jobs?per_page=100`);
    const names = (jobs.jobs || []).filter((job) => job.conclusion === "success").map((job) => job.name);
    return { runId: run.id, jobs: [...new Set(names)].sort() };
  },
};
