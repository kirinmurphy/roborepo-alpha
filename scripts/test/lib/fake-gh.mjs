// A fake `gh` executable for branch-protection checks. It answers `gh api` from a JSON state file
// the way GitHub's ruleset endpoints do, including computing a branch's effective rules from the
// active rulesets, and appends every request to a log. Put `dir` first on PATH to use it.
//
// State file fields (see `fakeGitHubState` for defaults):
//   failure   null | "not-signed-in" | "unreachable" | "tls" | "hang" | "rulesets-refused"
//             | "actions-off" (runs endpoint answers 404) | "runs-error" (runs endpoint answers 502)
//             | "classic-refused" (classic protection answers 403 with the upgrade message)
//             | "classic-rate-limited" (classic protection answers 403 for a rate limit)
//             | "user-unauthorized" (calls as the user, without GH_CONFIG_DIR, answer 401)
//             | "repo-forbidden" (reading the repo itself answers 403)
//   An exported GH_TOKEN or GITHUB_TOKEN names the calling account, ahead of any stored login, as gh does.
//   login, admin, defaultBranch
//   refuseCreate  a ruleset name whose create answers 422, to fail an apply partway
//   refuseUpdate  a ruleset name whose update answers 422
//   classicProtection  optional { [branch]: GitHub's classic branch protection answer }
//   tokens    { [token]: { login, scopes: [..] | null, expires: "2027-01-01 00:00:00 UTC" | null, expired } }
//             the accounts a bot's `gh auth login --with-token` can sign in as, keyed by token
//   users     logins that exist on GitHub (default: the signed-in user and every token's login)
//   collaborators [{ login, permission: "push" | "admin" }]; invitations [{ id, invitee, repo }]
//   invitePermission  what accepting an invitation grants (default "push"); refuseInvite answers 403
//   Identity: a call with GH_CONFIG_DIR set is the account whose token is in that directory's
//   hosts.yml (or `.fake-token`, for a keychain login); without it, the `login` user. The hosts.yml
//   that `auth login --insecure-storage` writes is the only place the fake stores a token.
// List endpoints page by `per_page` and `page` as GitHub does; each log entry records the
// `--hostname` the call named.
//   rulesets  full ruleset objects; `source_type` other than "Repository" marks an inherited one
//   runs      workflow runs, newest first: { id, conclusion, jobs: [{ name, conclusion }] }, plus optional
//             `event` (default "pull_request") and `workflow` (workflow id, default 1)
//   workflows optional [{ id, state }]; by default every workflow a run names, all "active"
import fs from "node:fs";
import path from "node:path";

export const RULESETS_REFUSED_MESSAGE = "Upgrade to GitHub Pro or make this repository public to enable this feature.";

export function fakeGitHubState(overrides = {}) {
  return {
    failure: null,
    login: "octo-admin",
    admin: true,
    defaultBranch: "main",
    rulesets: [],
    runs: [{ id: 501, conclusion: "success", jobs: [{ name: "check (ubuntu-latest)", conclusion: "success" }, { name: "check (macos-latest)", conclusion: "success" }] }],
    nextId: 9000,
    tokens: {},
    collaborators: [],
    invitations: [],
    ...overrides,
  };
}

// Creates the executable under `root` and returns helpers for driving it from a check.
export function createFakeGh(root) {
  const dir = path.join(root, "fake-gh-bin");
  const env = { FAKE_GH_STATE: path.join(root, "fake-gh-state.json"), FAKE_GH_LOG: path.join(root, "fake-gh.log") };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "gh"), FAKE_GH_SOURCE, { mode: 0o755 });
  const fake = { dir, env, ...fakeGhControls(env) };
  fake.clearCalls();
  fake.setState(fakeGitHubState());
  return fake;
}

// The state and log helpers for a fake created elsewhere, located by the `env` it was given. A
// browser spec uses this to drive the fake its portal server was started with.
export function fakeGhControls(env) {
  return {
    setState: (state) => fs.writeFileSync(env.FAKE_GH_STATE, JSON.stringify(state, null, 2)),
    readState: () => JSON.parse(fs.readFileSync(env.FAKE_GH_STATE, "utf8")),
    clearCalls: () => fs.writeFileSync(env.FAKE_GH_LOG, ""),
    calls: () => fs.readFileSync(env.FAKE_GH_LOG, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
  };
}

const FAKE_GH_SOURCE = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const statePath = process.env.FAKE_GH_STATE;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const REFUSED = ${JSON.stringify(RULESETS_REFUSED_MESSAGE)};

const path = require("node:path");
const configDir = process.env.GH_CONFIG_DIR || null;
const hostsPath = configDir ? path.join(configDir, "hosts.yml") : null;
const argvLog = { argv: args, configDir };
if (args[0] === "auth") authCommand();
if (args[0] !== "api") fail(1, "fake gh: only \`gh api\` and \`gh auth\` are implemented");
const method = args[args.indexOf("--method") + 1];
const endpoint = args.find((arg) => /^(repos\\/|users?(\\/|$))/.test(arg));
const body = args.includes("--input") ? JSON.parse(fs.readFileSync(0, "utf8")) : null;
const hostname = args.includes("--hostname") ? args[args.indexOf("--hostname") + 1] : null;
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ ...argvLog, method, endpoint, body, hostname }) +"\\n");

if (state.failure === "not-signed-in") fail(4, "To get started with GitHub CLI, please run:  gh auth login");
if (state.failure === "unreachable") fail(1, "error connecting to api.github.com");
// What gh prints in a macOS sandbox that blocks the system's certificate check (trustd).
if (state.failure === "tls") fail(1, 'Get "https://api.github.com/user": tls: failed to verify certificate: x509: OSStatus -26276');
// Never answers; the caller's timeout ends it.
if (state.failure === "hang") setTimeout(() => {}, 60_000);
else respond();

function respond() {

const [pathname, query = ""] = endpoint.split("?");
const identity = resolveIdentity();
const params = new URLSearchParams(query);
// GitHub's paging: per_page (default 30) items from page (default 1).
const paged = (list) => {
  const size = Number(params.get("per_page") || 30);
  const page = Number(params.get("page") || 1);
  return list.slice((page - 1) * size, page * size);
};
const route = pathname.replace(/^repos\\/[^/]+\\/[^/]+\\/?/, "");
// Admin rights belong to whoever is calling: the user per state.admin, a bot per its collaborator
// role. Every admin-only route checks this, so a write made with the bot's config fails as it would.
const callerAdmin = identity.bot
  ? ((state.collaborators || []).find((entry) => (entry.login || "").toLowerCase() === (identity.login || "").toLowerCase())?.permission === "admin")
  : state.admin;
const visible = (ruleset) => {
  if (callerAdmin) return ruleset;
  const { bypass_actors, ...rest } = ruleset;
  return rest;
};

const repoName = (pathname.match(/^repos\\/([^/]+\\/[^/]+)/) || [])[1];
const known = (login) => (login || "").toLowerCase();
const permissionOf = (login) => (state.collaborators || []).find((entry) => known(entry.login) === known(login))?.permission || null;
if (pathname === "user") reply({ login: identity.login });
const userPage = pathname.match(/^users\\/([^/]+)$/);
if (userPage) {
  const logins = state.users || [state.login, ...Object.values(state.tokens || {}).map((entry) => entry.login)];
  const canonical = logins.find((login) => known(login) === known(userPage[1]));
  if (!canonical) httpError(404, "Not Found");
  reply({ login: canonical });
}
const invitationsFor = () => (state.invitations || []).filter((entry) => known(entry.invitee) === known(identity.login));
if (pathname === "user/repository_invitations" && method === "GET") {
  reply(paged(invitationsFor().map((entry) => ({ id: entry.id, invitee: { login: entry.invitee }, repository: { full_name: entry.repo } }))));
}
const accept = pathname.match(/^user\\/repository_invitations\\/(\\d+)$/);
if (accept && method === "PATCH") {
  const found = invitationsFor().find((entry) => entry.id === Number(accept[1]));
  if (!found) httpError(404, "Not Found");
  state.invitations = state.invitations.filter((entry) => entry !== found && entry.id !== found.id);
  state.collaborators = [...(state.collaborators || []), { login: found.invitee, permission: state.invitePermission || "push" }];
  save();
  process.exit(0);
}
if (route === "") {
  if (state.failure === "repo-forbidden") httpError(403, "Resource not accessible by personal access token");
  const permission = identity.bot ? permissionOf(identity.login) : null;
  const permissions = identity.bot
    ? { admin: permission === "admin", push: permission === "admin" || permission === "push", pull: true }
    : { admin: callerAdmin, push: true, pull: true };
  reply({ default_branch: state.defaultBranch, permissions });
}
const collaborator = route.match(/^collaborators\\/([^/]+)$/);
if (collaborator) {
  const login = decodeURIComponent(collaborator[1]);
  if (method === "GET") {
    if (!permissionOf(login)) httpError(404, "Not Found");
    process.exit(0);
  }
  if (method === "PUT") {
    if (!callerAdmin || state.refuseInvite) httpError(403, "Must have admin rights to Repository.");
    if (permissionOf(login)) process.exit(0);
    state.invitations = [...(state.invitations || []), { id: state.nextId, invitee: login, repo: repoName }];
    state.nextId += 1;
    save();
    reply({ id: state.nextId - 1 });
  }
}
if (route === "invitations" && method === "GET") {
  if (!callerAdmin) httpError(403, "Must have admin rights to Repository.");
  reply(paged((state.invitations || []).filter((entry) => entry.repo === repoName).map((entry) => ({ id: entry.id, invitee: { login: entry.invitee }, repository: { full_name: entry.repo } }))));
}

const rulesTouched = /^(rules|rulesets)(\\/|$)/.test(route);
if (rulesTouched && state.failure === "rulesets-refused") httpError(403, REFUSED);

const branchRules = route.match(/^rules\\/branches\\/(.+)$/);
if (branchRules) {
  const branch = decodeURIComponent(branchRules[1]);
  const matches = (pattern) => pattern === "~ALL" || pattern === "refs/heads/" + branch
    || (pattern === "~DEFAULT_BRANCH" && branch === state.defaultBranch);
  const rules = [];
  for (const ruleset of state.rulesets) {
    const ref = (ruleset.conditions && ruleset.conditions.ref_name) || {};
    if (ruleset.enforcement !== "active" || ruleset.target !== "branch") continue;
    if (!(ref.include || []).some(matches) || (ref.exclude || []).some(matches)) continue;
    for (const rule of ruleset.rules || []) {
      rules.push({ ...rule, ruleset_source_type: ruleset.source_type, ruleset_source: ruleset.source, ruleset_id: ruleset.id });
    }
  }
  reply(paged(rules));
}

if (route === "rulesets" && method === "GET") {
  reply(paged(state.rulesets.map(({ id, name, target, source_type, source, enforcement }) => ({ id, name, target, source_type, source, enforcement }))));
}
if (route === "rulesets" && method === "POST") {
  if (!callerAdmin) httpError(403, "Resource not accessible by personal access token");
  if (state.refuseCreate && body.name === state.refuseCreate) httpError(422, "Validation Failed");
  const created = stored({ id: state.nextId, source_type: "Repository", source: "example/project" }, body);
  state.rulesets.push(created);
  state.nextId += 1;
  save();
  reply(created);
}
const one = route.match(/^rulesets\\/(\\d+)$/);
if (one) {
  const index = state.rulesets.findIndex((ruleset) => ruleset.id === Number(one[1]));
  if (index < 0) httpError(404, "Not Found");
  if (method === "GET") reply(visible(state.rulesets[index]));
  if (!callerAdmin) httpError(403, "Resource not accessible by personal access token");
  if (method === "PUT") {
    if (state.refuseUpdate && body.name === state.refuseUpdate) httpError(422, "Validation Failed");
    const { id, source_type, source } = state.rulesets[index];
    state.rulesets[index] = stored({ id, source_type, source }, body);
    save();
    reply(state.rulesets[index]);
  }
  if (method === "DELETE") {
    state.rulesets.splice(index, 1);
    save();
    reply({});
  }
}

// Classic branch protection: only an admin can read it; anyone else, or a branch without it, gets 404.
const classic = route.match(/^branches\\/([^/]+)\\/protection$/);
if (classic) {
  const settings = (state.classicProtection || {})[decodeURIComponent(classic[1])];
  if (state.failure === "classic-refused") httpError(403, REFUSED);
  if (state.failure === "classic-rate-limited") httpError(403, "API rate limit exceeded for user ID 1.");
  if (!callerAdmin || !settings) httpError(404, "Branch not protected");
  reply(settings);
}

const actionsRoute = /^actions\\//.test(route);
if (actionsRoute && state.failure === "actions-off") httpError(404, "Not Found");
if (actionsRoute && state.failure === "runs-error") httpError(502, "Server Error");
const workflowOf = (run) => run.workflow ?? 1;
if (route === "actions/workflows") {
  const workflows = state.workflows || [...new Set(state.runs.map(workflowOf))].map((id) => ({ id, state: "active" }));
  reply({ total_count: workflows.length, workflows: paged(workflows) });
}
const workflowRuns = route.match(/^actions\\/workflows\\/(\\d+)\\/runs$/);
if (workflowRuns) {
  const wanted = params.get("status");
  const event = params.get("event");
  const runs = state.runs.filter((run) => workflowOf(run) === Number(workflowRuns[1])
    && (!wanted || run.conclusion === wanted) && (!event || (run.event || "pull_request") === event));
  reply({ workflow_runs: runs.slice(0, Number(params.get("per_page") || 30)).map((run) => ({ id: run.id, conclusion: run.conclusion, status: "completed", event: run.event || "pull_request", workflow_id: workflowOf(run) })) });
}
const jobs = route.match(/^actions\\/runs\\/(\\d+)\\/jobs$/);
if (jobs) reply({ jobs: paged((state.runs.find((run) => run.id === Number(jobs[1])) || { jobs: [] }).jobs) });

httpError(404, "Not Found");
}

// GitHub fills in the pull_request defaults a request leaves out.
function stored(identity, body) {
  const rules = (body.rules || []).map((rule) => (rule.type === "pull_request"
    ? { ...rule, parameters: { allowed_merge_methods: ["merge", "squash", "rebase"], ...rule.parameters } }
    : rule));
  return { ...identity, ...body, rules };
}
function save() { fs.writeFileSync(statePath, JSON.stringify(state, null, 2)); }
function reply(value) {
  if (args.includes("-i") && endpoint === "user") {
    const info = tokenOf(configDir);
    let head = "HTTP/2.0 200 OK\\r\\nContent-Type: application/json\\r\\n";
    if (info && info.scopes) head += "X-Oauth-Scopes: " + info.scopes.join(", ") + "\\r\\n";
    if (info && info.expires) head += "Github-Authentication-Token-Expiration: " + info.expires + "\\r\\n";
    process.stdout.write(head + "\\r\\n");
  }
  process.stdout.write(JSON.stringify(value));
  process.exit(0);
}
// The token a config directory holds: hosts.yml's oauth_token, else the keychain stand-in.
function savedToken(dir) {
  for (const [file, pattern] of [["hosts.yml", /oauth_token:\\s*(\\S+)/], [".fake-token", /^(\\S+)/]]) {
    try {
      const match = pattern.exec(fs.readFileSync(path.join(dir, file), "utf8"));
      if (match) return match[1];
    } catch {}
  }
  return null;
}
// Like gh, an exported GH_TOKEN or GITHUB_TOKEN wins over any stored login. A function, because
// requests are answered before later top-level declarations run.
function envToken() { return process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null; }
function tokenOf(dir) {
  const token = envToken() || (dir ? savedToken(dir) : null);
  return token ? (state.tokens || {})[token] || null : null;
}
function resolveIdentity() {
  if (envToken()) {
    const info = tokenOf(null);
    if (!info || info.expired) httpError(401, "Bad credentials");
    return { login: info.login, bot: info.login !== state.login };
  }
  if (!configDir && state.failure === "user-unauthorized") httpError(401, "Bad credentials");
  if (!configDir) return { login: state.login, bot: false };
  if (!fs.existsSync(hostsPath)) fail(4, "To get started with GitHub CLI, please run:  gh auth login");
  const info = tokenOf(configDir);
  if (!info || info.expired) httpError(401, "Bad credentials");
  return { login: info.login, bot: true };
}
function authCommand() {
  fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ ...argvLog, method: null, endpoint: null }) + "\\n");
  if (!configDir) fail(1, "fake gh: auth needs GH_CONFIG_DIR");
  if (args[1] === "logout") {
    fs.rmSync(hostsPath, { force: true });
    fs.rmSync(path.join(configDir, ".fake-token"), { force: true });
    process.exit(0);
  }
  if (args[1] === "token") {
    const token = savedToken(configDir);
    if (!token) fail(1, "no oauth token found for github.com");
    process.stdout.write(token + "\\n");
    process.exit(0);
  }
  if (args[1] !== "login" || !args.includes("--with-token")) fail(1, "fake gh: unsupported auth command");
  const token = fs.readFileSync(0, "utf8").trim();
  const info = (state.tokens || {})[token];
  if (!info) fail(1, "error validating token: HTTP 401 Bad credentials");
  fs.mkdirSync(configDir, { recursive: true });
  const entry = "github.com:\\n    user: " + info.login + "\\n    git_protocol: https\\n";
  if (args.includes("--insecure-storage")) fs.writeFileSync(hostsPath, entry.replace("    user:", "    oauth_token: " + token + "\\n    user:"), { mode: state.hostsMode || 0o644 });
  else {
    fs.writeFileSync(hostsPath, entry);
    fs.writeFileSync(path.join(configDir, ".fake-token"), token + "\\n");
  }
  process.exit(0);
}
function fail(code, message) { process.stderr.write(message + "\\n"); process.exit(code); }
function httpError(status, message) {
  process.stdout.write(JSON.stringify({ message, status: String(status) }));
  fail(1, "gh: " + message + " (HTTP " + status + ")");
}
`;
