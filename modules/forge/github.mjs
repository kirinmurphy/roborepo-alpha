// The one place RoboRepo runs `gh`. Delivery uses the raw runner; branch protection uses the
// REST calls built on it. Every call names its repository explicitly, so none depends on which
// checkout the process happens to be in.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GIT_NETWORK_TIMEOUT_MS } from "../repositories/git-remote-operations.mjs";

const execFileAsync = promisify(execFile);

// A null value in `env` removes that variable, so a call can run as the person's own account even
// when the surrounding shell points GH_CONFIG_DIR at the bot.
function mergedEnv(extra) {
  const merged = { ...process.env, ...extra, GH_PROMPT_DISABLED: "1" };
  for (const [key, value] of Object.entries(extra || {})) if (value === null) delete merged[key];
  return merged;
}

export async function runGh(cwd, args, input = "", { timeoutMs = GIT_NETWORK_TIMEOUT_MS, env = null } = {}) {
  const pending = execFileAsync("gh", args, {
    cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 1024 * 1024,
    // `env` lets a caller run gh as another account, e.g. with GH_CONFIG_DIR set.
    env: mergedEnv(env),
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

// `--hostname` keeps every call on github.com even when GH_HOST names an Enterprise host, where a
// repo of the same name could otherwise receive the protection changes.
async function api(context, endpoint, { method = "GET", body = null } = {}) {
  const args = ["api", "--hostname", "github.com", "--method", method, "-H", "Accept: application/vnd.github+json", endpoint];
  if (body) args.push("--input", "-");
  let stdout;
  try {
    stdout = await runGh(context.cwd, args, body ? JSON.stringify(body) : "", { timeoutMs: context.timeoutMs, env: context.env });
  } catch (error) {
    throw describeGhFailure(error);
  }
  // Some writes answer 204 with no body.
  if (stdout.trim() === "") return null;
  try {
    return JSON.parse(stdout);
  } catch {
    throw new GitHubError("unavailable", "GitHub returned a response that could not be read");
  }
}

// `gh api -i user`: the signed-in account plus what the response headers say about the token (its
// scopes and expiry). Fine-grained tokens send no scopes header, so `scopes` is then null.
async function tokenInfo(context) {
  let stdout;
  try {
    stdout = await runGh(context.cwd, ["api", "-i", "--hostname", "github.com", "--method", "GET", "user"], "", { timeoutMs: context.timeoutMs, env: context.env });
  } catch (error) {
    throw describeGhFailure(error);
  }
  const split = stdout.search(/\r?\n\r?\n/);
  const head = split < 0 ? stdout : stdout.slice(0, split);
  const headers = new Map();
  for (const line of head.split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  let login = null;
  try {
    login = JSON.parse(split < 0 ? "" : stdout.slice(split).trim()).login ?? null;
  } catch {
    throw new GitHubError("unavailable", "GitHub returned a response that could not be read");
  }
  const scopeHeader = headers.get("x-oauth-scopes");
  const expiry = headers.get("github-authentication-token-expiration");
  const expiresAt = expiry ? new Date(expiry.replace(" UTC", "Z").replace(" ", "T")) : null;
  return {
    login,
    scopes: scopeHeader === undefined ? null : scopeHeader.split(",").map((scope) => scope.trim()).filter(Boolean),
    expiresAt: expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null,
  };
}

const repoPath = (repo) => `repos/${repo}`;

const PAGE_SIZE = 100;
// A list longer than this many pages is far beyond any real repo; stopping keeps a misbehaving
// answer from looping forever.
const MAX_PAGES = 20;

// Every item of a paged list. `pick` takes the items out of one page's body. A page shorter than
// PAGE_SIZE is the last one, so a list of 100 or fewer items costs one request, as before.
async function allPages(context, endpoint, pick = (body) => body) {
  const items = [];
  const separator = endpoint.includes("?") ? "&" : "?";
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = pick(await api(context, `${endpoint}${separator}per_page=${PAGE_SIZE}&page=${page}`)) || [];
    items.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return items;
}

// `context` is `{ cwd, timeoutMs }`; `repo` is `owner/name`.
export const githubClient = {
  host: "github.com",
  supported: true,
  run: runGh,

  repository: (context, repo) => api(context, repoPath(repo)),

  tokenInfo,

  // Whether an account exists on GitHub.
  async userExists(context, login) {
    try {
      await api(context, `users/${encodeURIComponent(login)}`);
      return true;
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return false;
      throw error;
    }
  },

  async isCollaborator(context, repo, login) {
    try {
      await api(context, `${repoPath(repo)}/collaborators/${encodeURIComponent(login)}`);
      return true;
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return false;
      throw error;
    }
  },

  // Invitations still waiting on a repo (as its admin), and those waiting for the signed-in account.
  repoInvitations: (context, repo) => allPages(context, `${repoPath(repo)}/invitations`),
  userInvitations: (context) => allPages(context, "user/repository_invitations"),
  inviteCollaborator: (context, repo, login) => api(context, `${repoPath(repo)}/collaborators/${encodeURIComponent(login)}`, { method: "PUT" }),
  acceptInvitation: (context, id) => api(context, `user/repository_invitations/${id}`, { method: "PATCH" }),

  async login(context) {
    return (await api(context, "user")).login;
  },

  // Every active rule that applies to the branch, from any ruleset at any level.
  branchRules: (context, repo, branch) => allPages(context, `${repoPath(repo)}/rules/branches/${encodeURIComponent(branch)}`),

  // A branch's classic (pre-ruleset) branch protection settings. GitHub answers 404 when the
  // branch has none, and also to an account that cannot administer the repo.
  branchProtection: (context, repo, branch) => api(context, `${repoPath(repo)}/branches/${encodeURIComponent(branch)}/protection`),

  // The list carries no rules; `ruleset` reads one in full.
  rulesets: (context, repo) => allPages(context, `${repoPath(repo)}/rulesets`),
  ruleset: (context, repo, id) => api(context, `${repoPath(repo)}/rulesets/${id}`),

  createRuleset: (context, repo, body) => api(context, `${repoPath(repo)}/rulesets`, { method: "POST", body }),
  updateRuleset: (context, repo, id, body) => api(context, `${repoPath(repo)}/rulesets/${id}`, { method: "PUT", body }),

  // The checks that report on pull requests: the successful job names from the newest successful
  // pull-request run of each active workflow, combined. A workflow that never runs on pull requests
  // (release, docs) contributes nothing, so it never adds a check a pull request cannot satisfy.
  // Null when no active workflow has a successful pull-request run with a passing job, so the
  // caller can keep the checks it already requires. Asking GitHub for `status=success` passes over
  // cancelled and failed runs. Each workflow is asked for its own newest run, so a quiet workflow
  // is never crowded out by a busy one.
  async pullRequestCheckJobs(context, repo) {
    const workflows = await allPages(context, `${repoPath(repo)}/actions/workflows`, (body) => body.workflows);
    const active = workflows.filter((workflow) => workflow.state === "active");
    const runIds = [];
    const names = new Set();
    // One request at a time, so a failed read leaves no other `gh` request running.
    for (const workflow of active) {
      const runs = await api(context, `${repoPath(repo)}/actions/workflows/${workflow.id}/runs?event=pull_request&status=success&per_page=1`);
      const run = runs.workflow_runs?.[0];
      if (!run) continue;
      runIds.push(run.id);
      const jobs = await allPages(context, `${repoPath(repo)}/actions/runs/${run.id}/jobs`, (body) => body.jobs);
      for (const job of jobs) if (job.conclusion === "success") names.add(job.name);
    }
    return names.size > 0 ? { runIds, jobs: [...names].sort() } : null;
  },
};
