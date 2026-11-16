// A fake `gh` executable for branch-protection checks. It answers `gh api` from a JSON state file
// the way GitHub's ruleset endpoints do, including computing a branch's effective rules from the
// active rulesets, and appends every request to a log. Put `dir` first on PATH to use it.
//
// State file fields (see `fakeGitHubState` for defaults):
//   failure   null | "not-signed-in" | "unreachable" | "hang" | "rulesets-refused"
//             | "actions-off" (runs endpoint answers 404) | "runs-error" (runs endpoint answers 502)
//   login, admin, defaultBranch
//   rulesets  full ruleset objects; `source_type` other than "Repository" marks an inherited one
//   runs      workflow runs on the default branch, newest first: { id, conclusion, jobs: [{ name, conclusion }] }
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

if (args[0] !== "api") fail(1, "fake gh: only \`gh api\` is implemented");
const method = args[args.indexOf("--method") + 1];
const endpoint = args.find((arg) => /^(repos\\/|user$)/.test(arg));
const body = args.includes("--input") ? JSON.parse(fs.readFileSync(0, "utf8")) : null;
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ method, endpoint, body }) + "\\n");

if (state.failure === "not-signed-in") fail(4, "To get started with GitHub CLI, please run:  gh auth login");
if (state.failure === "unreachable") fail(1, "error connecting to api.github.com");
// Never answers; the caller's timeout ends it.
if (state.failure === "hang") setTimeout(() => {}, 60_000);
else respond();

function respond() {

const [pathname, query = ""] = endpoint.split("?");
const params = new URLSearchParams(query);
const route = pathname.replace(/^repos\\/[^/]+\\/[^/]+\\/?/, "");
const visible = (ruleset) => {
  if (state.admin) return ruleset;
  const { bypass_actors, ...rest } = ruleset;
  return rest;
};

if (pathname === "user") reply({ login: state.login });
if (route === "") reply({ default_branch: state.defaultBranch, permissions: { admin: state.admin, push: true, pull: true } });

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
  reply(rules);
}

if (route === "rulesets" && method === "GET") {
  reply(state.rulesets.map(({ id, name, target, source_type, source, enforcement }) => ({ id, name, target, source_type, source, enforcement })));
}
if (route === "rulesets" && method === "POST") {
  if (!state.admin) httpError(403, "Resource not accessible by personal access token");
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
  if (!state.admin) httpError(403, "Resource not accessible by personal access token");
  if (method === "PUT") {
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

if (route === "actions/runs" && state.failure === "actions-off") httpError(404, "Not Found");
if (route === "actions/runs" && state.failure === "runs-error") httpError(502, "Server Error");
if (route === "actions/runs") {
  const wanted = params.get("status");
  const runs = state.runs.filter((run) => !wanted || run.conclusion === wanted);
  reply({ workflow_runs: runs.slice(0, Number(params.get("per_page") || 30)).map(({ id, conclusion }) => ({ id, conclusion, status: "completed" })) });
}
const jobs = route.match(/^actions\\/runs\\/(\\d+)\\/jobs$/);
if (jobs) reply({ jobs: (state.runs.find((run) => run.id === Number(jobs[1])) || { jobs: [] }).jobs });

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
function reply(value) { process.stdout.write(JSON.stringify(value)); process.exit(0); }
function fail(code, message) { process.stderr.write(message + "\\n"); process.exit(code); }
function httpError(status, message) {
  process.stdout.write(JSON.stringify({ message, status: String(status) }));
  fail(1, "gh: " + message + " (HTTP " + status + ")");
}
`;
