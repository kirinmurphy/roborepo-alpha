#!/usr/bin/env node
// The portal's GitHub bot identity routes below the browser: the status read (listed repos only,
// GitHub repos only, a five-minute cache that `fresh` skips, no token in the answer), the setup
// launch (always `roborepo github setup` in the repo's own folder, a reason when it cannot open),
// the routes' handling of `fresh` and of a non-empty setup body, and the real status read against a
// fake `gh` with the package on and off.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultRegistry, registerLocalRoot, registerLocalRootPath, rootId, upsertRepository, writeRegistry,
} from "../../modules/repositories/index.mjs";
import { clearAgentIdentityCache, launchAgentIdentitySetup, loadRepositoryAgentIdentity } from "../cli/repository-agent-identity.mjs";
import { launchInTerminal } from "../cli/terminal-launch.mjs";
import { shellQuote } from "../harnesses/shell-quote.mjs";
import { repositoriesRoutes } from "../cli/portal-routes-repositories.mjs";
import { dispatchRoutes } from "../cli/portal-router.mjs";
import { createFakeGh, fakeGitHubState } from "./lib/fake-gh.mjs";
import { isolateGitConfig } from "./lib/git-config.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-agent-identity-portal-"));
isolateGitConfig(tmp);
const stateRoot = path.join(tmp, "state");
const GITHUB = "git:github.com/example/project";
const NO_CHECKOUT = "git:github.com/example/elsewhere";
const GITLAB = "git:gitlab.com/example/project";
const TOKEN = "ghp_portalcheck0123456789";

try {
  const checkout = clone("project", "git@github.com:example/project.git");
  const registry = defaultRegistry();
  for (const id of [GITHUB, NO_CHECKOUT, GITLAB]) upsertRepository(registry, { id, kind: "git", displayName: id.split("/").pop() });
  registerLocalRoot(registry, GITHUB, { rootId: rootId(checkout), kind: "primary" });
  registerLocalRootPath(registry, GITHUB, { rootId: rootId(checkout), path: checkout });
  writeRegistry({ stateRoot, registry });

  await statusReadIsCachedAndCarriesNoToken(checkout);
  await setupLaunchIsTheServersChoice(checkout);
  terminalLaunchStartsInTheGivenFolder(checkout);
  await routesPassFreshAndRefuseABody();
  realStatusAgainstFakeGh(checkout);
  console.log("ok: portal agent identity status, setup launch, and routes");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function statusReadIsCachedAndCarriesNoToken(checkout) {
  clearAgentIdentityCache();
  const reads = [];
  let clock = 1_000;
  const read = (options) => {
    reads.push(options);
    // `token` stands for anything a future report might carry; the portal answer names its fields.
    return Promise.resolve({
      state: "problem", repository: "example/project", botLogin: "robo-bot", userLogin: "me", packageEnabled: true,
      expiresAt: null, scopes: ["repo"], reason: null, token: TOKEN,
      problems: [{ id: "expired", severity: "problem", message: "The bot's token has expired.", fix: "Run roborepo github setup in your own terminal.", extra: TOKEN }],
    });
  };
  const load = (options = {}) => loadRepositoryAgentIdentity({ repositoryId: GITHUB, stateRoot, platform: "darwin", now: () => clock, read, ...options });

  const first = await load();
  assert.equal(reads.length, 1);
  assert.equal(reads[0].cwd, checkout, "gh runs in the repo's own checkout");
  assert.equal(reads[0].repositoryId, GITHUB);
  assert.equal(reads[0].timeoutMs, 8000);
  assert.equal(first.state, "problem");
  assert.deepEqual(first.findings, [{ id: "expired", severity: "problem", message: "The bot's token has expired.", fix: "Run roborepo github setup in your own terminal." }]);
  assert.deepEqual(first.setupLaunch, { supported: true });
  assert.equal(first.guide.command, "roborepo github setup");
  assert.ok(first.guide.links.some((link) => link.url === "https://github.com/settings/tokens/new"));
  assert.ok(!JSON.stringify(first).includes(TOKEN), "no token reaches the portal answer");

  clock += 60_000;
  await load();
  assert.equal(reads.length, 1, "a read within five minutes is served from the cache");
  await load({ fresh: true });
  assert.equal(reads.length, 2, "fresh skips the cache");
  clock += 5 * 60_000;
  await load();
  assert.equal(reads.length, 3, "an answer older than five minutes is read again");

  const linux = await load({ platform: "linux" });
  assert.equal(linux.setupLaunch.supported, false, "no one-click launch off macOS");

  const elsewhere = await loadRepositoryAgentIdentity({ repositoryId: NO_CHECKOUT, stateRoot, platform: "darwin", read });
  assert.equal(elsewhere.setupLaunch.supported, false, "no launch without a checkout to run the setup in");
  assert.match(elsewhere.setupLaunch.reason, /No checkout/);
  assert.equal(reads.at(-1).cwd, os.homedir(), "without a checkout, gh still runs, from the home folder");

  const before = reads.length;
  assert.deepEqual(await loadRepositoryAgentIdentity({ repositoryId: GITLAB, stateRoot, read }), { repositoryId: GITLAB, applies: false });
  assert.equal(reads.length, before, "a repo on another host never reaches GitHub");

  await assert.rejects(loadRepositoryAgentIdentity({ repositoryId: "git:github.com/example/unknown", stateRoot, read }), (error) => error.code === "NOT_FOUND");
}

async function setupLaunchIsTheServersChoice(checkout) {
  const launches = [];
  const launch = (request, options) => { launches.push({ request, options }); return { ok: true }; };
  const result = await launchAgentIdentitySetup({ repositoryId: GITHUB, stateRoot, platform: "darwin", launch });
  assert.deepEqual(result, { launched: true });
  assert.equal(launches.length, 1);
  const { request } = launches[0];
  assert.equal(request.executable, process.execPath, "the Node running the portal");
  assert.deepEqual(request.args, [path.join(repoRoot, "scripts", "cli", "main.mjs"), "github", "setup"]);
  assert.ok(path.isAbsolute(request.args[0]) && fs.existsSync(request.args[0]));
  assert.equal(request.cwd, checkout, "the setup runs in the repo's folder, so it sets up that repo");
  assert.match(request.name, /^github-setup-[A-Za-z0-9-]+$/);

  const failed = await launchAgentIdentitySetup({ repositoryId: GITHUB, stateRoot, platform: "darwin", launch: () => ({ ok: false, reason: "launch_failed", error: "open exited 1" }) });
  assert.deepEqual(failed, { launched: false, reason: "launch_failed", error: "open exited 1" });
  assert.equal((await launchAgentIdentitySetup({ repositoryId: GITHUB, stateRoot, platform: "linux", launch })).reason, "unsupported_platform");
  assert.equal((await launchAgentIdentitySetup({ repositoryId: NO_CHECKOUT, stateRoot, platform: "darwin", launch })).reason, "no_checkout");
  assert.equal((await launchAgentIdentitySetup({ repositoryId: GITLAB, stateRoot, platform: "darwin", launch })).reason, "not_github");
  assert.equal(launches.length, 1, "only the first call opened a terminal");
  await assert.rejects(launchAgentIdentitySetup({ repositoryId: "git:github.com/example/unknown", stateRoot, platform: "darwin", launch }), (error) => error.code === "NOT_FOUND");
}

function terminalLaunchStartsInTheGivenFolder(checkout) {
  const dir = path.join(tmp, "launch");
  const run = () => ({ status: 0 });
  assert.deepEqual(launchInTerminal({ name: "setup", executable: process.execPath, args: ["x"], cwd: checkout }, { platform: "darwin", dir, run }), { ok: true });
  const body = fs.readFileSync(path.join(dir, "setup.command"), "utf8");
  assert.ok(body.split("\n").includes(`cd ${shellQuote(checkout)} || exit 1`), body);
  assert.equal(launchInTerminal({ name: "setup", executable: process.execPath, cwd: "relative/folder" }, { platform: "darwin", dir, run }).reason, "no_folder");
  assert.equal(launchInTerminal({ name: "setup", executable: process.execPath, cwd: path.join(tmp, "absent") }, { platform: "darwin", dir, run }).reason, "no_folder");
}

async function routesPassFreshAndRefuseABody() {
  const calls = [];
  const handlers = {
    loadRepositoryAgentIdentity: (params) => {
      calls.push(["load", params]);
      if (params.repositoryId === "missing") return Promise.reject(Object.assign(new Error("unknown repository: missing"), { code: "NOT_FOUND" }));
      return Promise.resolve({ applies: false });
    },
    launchAgentIdentitySetup: (params) => { calls.push(["launch", params]); return Promise.resolve({ launched: true }); },
  };
  const id = encodeURIComponent(GITHUB);
  const get = await request("GET", `/api/repositories/${id}/agent-identity`, "fresh=1", handlers);
  assert.equal(get.status, 200);
  assert.deepEqual(calls.shift(), ["load", { repositoryId: GITHUB, fresh: true }]);
  await request("GET", `/api/repositories/${id}/agent-identity`, "", handlers);
  assert.deepEqual(calls.shift(), ["load", { repositoryId: GITHUB, fresh: false }]);
  assert.equal((await request("GET", "/api/repositories/missing/agent-identity", "", handlers)).status, 404);
  calls.length = 0;

  const refused = await request("POST", `/api/repositories/${id}/agent-identity/setup`, "", handlers, JSON.stringify({ command: "rm -rf /" }));
  assert.equal(refused.status, 400);
  assert.deepEqual(calls, [], "a body is refused before anything launches");
  const launched = await request("POST", `/api/repositories/${id}/agent-identity/setup`, "", handlers, "");
  assert.equal(launched.status, 200);
  assert.deepEqual(JSON.parse(launched.body), { launched: true });
  assert.deepEqual(calls, [["launch", { repositoryId: GITHUB }]]);
}

// The real read in a child process, because the state folder and package state are read when the
// modules load. With the package on, a healthy bot reads as `healthy`; with it off, as a problem
// whose fix is the setup.
function realStatusAgainstFakeGh(checkout) {
  if (process.platform === "win32") return;
  const gh = createFakeGh(tmp);
  const ghDir = path.join(stateRoot, "github-agent", "gh");
  const systemCa = path.join(tmp, "system-ca.crt");
  fs.writeFileSync(systemCa, "fixture bundle\n");
  fs.mkdirSync(ghDir, { recursive: true });
  fs.writeFileSync(path.join(ghDir, "hosts.yml"), `github.com:\n    oauth_token: ${TOKEN}\n    user: robo-bot\n`);
  fs.copyFileSync(systemCa, path.join(stateRoot, "github-agent", "ca-bundle.crt"));
  const env = {
    ...process.env, ...gh.env, HOME: path.join(tmp, "home"), ROBOREPO_STATE_ROOT: stateRoot, ROBOREPO_SYSTEM_CA_BUNDLE: systemCa,
    PATH: `${gh.dir}${path.delimiter}${process.env.PATH}`,
  };
  delete env.GH_CONFIG_DIR;
  // Protection rulesets as `roborepo protect` writes them, so the healthy case is fully healthy.
  const protect = spawnSync(process.execPath, [path.join(repoRoot, "scripts/cli/main.mjs"), "protect"], { cwd: checkout, env, encoding: "utf8" });
  assert.equal(protect.status, 0, protect.stdout + protect.stderr);
  const rulesets = gh.readState().rulesets;
  const read = (enabled) => {
    fs.writeFileSync(path.join(stateRoot, "enabled-packages.json"), JSON.stringify({ schemaVersion: 2, packages: enabled ? ["github-agent-identity"] : [], disabled: [] }));
    gh.setState(fakeGitHubState({
      rulesets: structuredClone(rulesets),
      tokens: { [TOKEN]: { login: "robo-bot", scopes: ["repo", "read:org"], expires: "2099-01-01 00:00:00 UTC", expired: false } },
      collaborators: [{ login: "robo-bot", permission: "push" }],
    }));
    const script = `import { loadRepositoryAgentIdentity } from ${JSON.stringify(path.join(repoRoot, "scripts/cli/repository-agent-identity.mjs"))};
      console.log(JSON.stringify(await loadRepositoryAgentIdentity({ repositoryId: ${JSON.stringify(GITHUB)}, fresh: true })));`;
    // Started from another folder, as the portal is: the package state must not depend on the cwd.
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: tmp, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(!result.stdout.includes(TOKEN), "no token in the answer");
    return JSON.parse(result.stdout);
  };
  const on = read(true);
  assert.deepEqual([on.state, on.botLogin, on.packageEnabled, on.findings], ["healthy", "robo-bot", true, []]);
  const off = read(false);
  assert.equal(off.state, "problem");
  assert.deepEqual(off.findings.map((entry) => [entry.id, entry.fix]), [["package-off", "Run roborepo github setup in your own terminal."]]);
}

function request(method, urlPath, qs, handlers, body = "") {
  return new Promise((resolve) => {
    const listeners = {};
    const req = { method, on: (event, fn) => { listeners[event] = fn; return req; } };
    const res = {
      writeHead(status) { this.status = status; },
      setHeader() {},
      end(payload) { resolve({ status: this.status, body: String(payload ?? "") }); },
    };
    dispatchRoutes([repositoriesRoutes], req, res, urlPath, qs, handlers);
    if (method !== "GET") {
      if (body) listeners.data?.(Buffer.from(body));
      listeners.end?.();
    }
  });
}

function clone(name, origin) {
  const dir = path.join(tmp, name);
  const run = (...args) => {
    const result = spawnSync("git", args, { cwd: tmp, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  run("init", "-q", "-b", "main", dir);
  run("-C", dir, "remote", "add", "origin", origin);
  return fs.realpathSync(dir);
}
