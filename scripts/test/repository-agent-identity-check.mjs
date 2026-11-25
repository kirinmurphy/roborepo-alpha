#!/usr/bin/env node
// The portal's GitHub bot identity routes below the browser: the account read (once for every repo,
// a five-minute cache that `fresh` skips, no token in the answer), each repo's read (listed GitHub
// repos only, nothing per repo while the account cannot be used), turning the package on only when
// that is the one step left, Home's setup offer and its remembered "No thanks", the setup launch (always `roborepo github setup` in the repo's own
// folder, a reason when it cannot open), the routes' handling of `fresh` and of a non-empty body,
// and the real reads against a fake `gh` with the package on and off.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultRegistry, registerLocalRoot, registerLocalRootPath, rootId, upsertRepository, writeRegistry,
} from "../../modules/repositories/index.mjs";
import {
  applyAgentGitRouting, clearAgentIdentityCache, inviteAgentBot, dismissAgentIdentityOffer, launchAgentIdentitySetup, loadAgentIdentityAccount, loadRepositoryAgentIdentity, turnOnAgentIdentity,
} from "../cli/repository-agent-identity.mjs";
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
  await packageTurnsOnOnlyAsTheLastStep();
  await updateRunsOnlyForTheGitGap();
  await setupLaunchIsTheServersChoice(checkout);
  await inviteNeedsAWorkingBotAndRereadsTheRepo();
  terminalLaunchStartsInTheGivenFolder(checkout);
  await offerDismissalIsRemembered();
  await routesPassFreshAndRefuseABody();
  realStatusAgainstFakeGh(checkout);
  console.log("ok: portal agent identity status, setup launch, and routes");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function readyAccount(overrides = {}) {
  return {
    state: "healthy", botLogin: "robo-bot", savedLogin: "robo-bot", userLogin: "me", signedIn: true, packageEnabled: true,
    expiresAt: null, scopes: ["repo", "read:org"], reason: null, problems: [], ...overrides,
  };
}

async function statusReadIsCachedAndCarriesNoToken(checkout) {
  clearAgentIdentityCache();
  const accountReads = [];
  const reads = [];
  let clock = 1_000;
  let account = readyAccount({ token: TOKEN });
  const readAccountReport = (options) => { accountReads.push(options); return Promise.resolve(account); };
  const read = (options) => {
    reads.push(options);
    // `token` stands for anything a future report might carry; the portal answer names its fields.
    return Promise.resolve({
      state: "problem", repository: "example/project", botLogin: options.botLogin, userAdmin: true, reason: null, token: TOKEN, ownerMessage: null,
      problems: [{ id: "invite-pending", severity: "problem", message: "robo-bot has been invited to example/project but has not accepted yet.", fix: "Run roborepo github setup in this repo, in your own terminal; it accepts the invitation as the bot.", extra: TOKEN }],
    });
  };
  const load = (options = {}) => loadRepositoryAgentIdentity({ repositoryId: GITHUB, stateRoot, platform: "darwin", now: () => clock, read, readAccountReport, ...options });

  // Home reads every repo at once: they share one account read.
  const [first] = await Promise.all([load(), load({ repositoryId: NO_CHECKOUT }), loadAgentIdentityAccount({ now: () => clock, read: readAccountReport })]);
  assert.equal(accountReads.length, 1, "concurrent reads share one account read");
  assert.equal(reads.length, 2, "one read per repo");
  reads.splice(1);
  assert.equal(reads[0].cwd, checkout, "gh runs in the repo's own checkout");
  assert.equal(reads[0].repositoryId, GITHUB);
  assert.equal(reads[0].timeoutMs, 8000);
  assert.equal(reads[0].botLogin, "robo-bot", "the repo is read for the account's bot");
  assert.equal(first.account, "ready");
  assert.equal(first.state, "problem");
  assert.deepEqual(first.findings, [{ id: "invite-pending", severity: "problem", message: "robo-bot has been invited to example/project but has not accepted yet.", fix: "Run roborepo github setup in this repo, in your own terminal; it accepts the invitation as the bot.", owner: false }]);
  assert.deepEqual(first.setupLaunch, { supported: true });
  assert.ok(!JSON.stringify(first).includes(TOKEN), "no token reaches the repo answer");

  const accountView = await loadAgentIdentityAccount({ now: () => clock, read: readAccountReport, platform: "darwin" });
  assert.equal(accountView.botLogin, "robo-bot");
  assert.equal(accountView.guide.command, "roborepo github setup");
  assert.ok(accountView.guide.steps.some((step) => step.id === "token" && step.url === "https://github.com/settings/tokens/new"));
  assert.match(accountView.guide.lead, /where the bot is signed in/);
  assert.ok(!JSON.stringify(accountView).includes(TOKEN), "no token reaches the account answer");

  clock += 60_000;
  await load();
  assert.equal(reads.length, 1, "a read within five minutes is served from the cache");
  await load({ fresh: true });
  assert.equal(reads.length, 2, "fresh skips the cache");
  assert.equal(accountReads.length, 2, "a fresh repo read also re-reads the account");
  clock += 5 * 60_000;
  await load();
  assert.equal(reads.length, 3, "an answer older than five minutes is read again");

  const linux = await load({ platform: "linux" });
  assert.equal(linux.setupLaunch.supported, false, "no one-click launch off macOS");

  const elsewhere = await loadRepositoryAgentIdentity({ repositoryId: NO_CHECKOUT, stateRoot, platform: "darwin", read, readAccountReport });
  assert.equal(elsewhere.setupLaunch.supported, false, "no launch without a checkout to run the setup in");
  assert.match(elsewhere.setupLaunch.reason, /No checkout/);
  assert.equal(reads.at(-1).cwd, os.homedir(), "without a checkout, gh still runs, from the home folder");

  // While the account cannot be used, a repo has nothing of its own to say.
  for (const waiting of [
    { state: "not-set-up", botLogin: null, savedLogin: null, signedIn: false, packageEnabled: false },
    { state: "problem", botLogin: null, problems: [{ id: "expired", severity: "problem", message: "GitHub rejected the bot's token.", fix: "Run roborepo github setup in your own terminal." }] },
    { state: "unavailable", reason: "GitHub could not be reached" },
  ]) {
    account = readyAccount(waiting);
    const before = reads.length;
    const answer = await load({ fresh: true });
    assert.equal(answer.account, "waiting", waiting.state);
    assert.equal(reads.length, before, `${waiting.state}: no repo read without a usable bot`);
  }

  const before = reads.length;
  assert.deepEqual(await loadRepositoryAgentIdentity({ repositoryId: GITLAB, stateRoot, read, readAccountReport }), { repositoryId: GITLAB, applies: false });
  assert.equal(reads.length, before, "a repo on another host never reaches GitHub");

  await assert.rejects(loadRepositoryAgentIdentity({ repositoryId: "git:github.com/example/unknown", stateRoot, read, readAccountReport }), (error) => error.code === "NOT_FOUND");
}

// The portal turns the package on only when a fresh read shows a working bot with nothing else to
// fix; anything more is the setup's.
async function packageTurnsOnOnlyAsTheLastStep() {
  clearAgentIdentityCache();
  const offOnly = readyAccount({ state: "problem", packageEnabled: false, problems: [{ id: "package-off", severity: "problem", message: "off", fix: "Turn it on: roborepo package enable github-agent-identity." }] });
  const view = await loadAgentIdentityAccount({ fresh: true, read: () => Promise.resolve(offOnly) });
  assert.equal(view.enableOffered, true, "a ready bot with the package off is offered Turn on");

  let enabled = false;
  const read = () => Promise.resolve(enabled ? readyAccount() : offOnly);
  const turnOn = () => { enabled = true; return Promise.resolve({ ok: true }); };
  const result = await turnOnAgentIdentity({ read, turnOn });
  assert.equal(result.enabled, true);
  assert.equal(result.account.state, "healthy", "the answer carries the account read after");

  for (const [label, report] of [
    ["expired token", readyAccount({ state: "problem", botLogin: null, packageEnabled: false, problems: [{ id: "expired", severity: "problem", message: "x", fix: "x" }, offOnly.problems[0]] })],
    ["stale CA bundle", readyAccount({ state: "problem", packageEnabled: false, problems: [{ id: "ca-bundle-stale", severity: "warn", message: "x", fix: "x" }, offOnly.problems[0]] })],
    ["broad scopes", readyAccount({ state: "problem", packageEnabled: false, problems: [{ id: "broad-scopes", severity: "problem", message: "x", fix: "x" }, offOnly.problems[0]] })],
  ]) {
    let called = false;
    const refused = await turnOnAgentIdentity({ read: () => Promise.resolve(report), turnOn: () => { called = true; return Promise.resolve({ ok: true }); } });
    assert.deepEqual([refused.enabled, refused.reason, called], [false, "not_ready", false], label);
    assert.equal(refused.account.enableOffered, false, `${label}: not offered`);
  }
  const advice = readyAccount({ state: "problem", packageEnabled: false, problems: [{ id: "expiring", severity: "warn", message: "x", fix: "x" }, offOnly.problems[0]] });
  assert.equal((await loadAgentIdentityAccount({ fresh: true, read: () => Promise.resolve(advice) })).enableOffered, true, "an expiry note does not stand in the way");
  const failed = await turnOnAgentIdentity({ read: () => Promise.resolve(offOnly), turnOn: () => Promise.resolve({ ok: false, message: "The package did not install completely." }) });
  assert.deepEqual([failed.enabled, failed.reason, failed.message], [false, "enable_failed", "The package did not install completely."]);
  clearAgentIdentityCache();
}

// "Update now" applies the config only while a fresh read still shows agents' pushes going out as
// the user, and answers with the account read after.
async function updateRunsOnlyForTheGitGap() {
  clearAgentIdentityCache();
  const gap = readyAccount({ state: "problem", problems: [{ id: "git-not-routed", severity: "problem", message: "Agents' git pushes still go out as you.", fix: "x" }] });
  let routed = false;
  let runs = 0;
  const read = () => Promise.resolve(routed ? readyAccount() : gap);
  const apply = () => { runs += 1; routed = true; return Promise.resolve({ ok: true }); };
  const result = await applyAgentGitRouting({ read, apply });
  assert.deepEqual([result.applied, runs, result.account.state], [true, 1, "healthy"]);

  const skipped = await applyAgentGitRouting({ read: () => Promise.resolve(readyAccount()), apply });
  assert.deepEqual([skipped.applied, skipped.reason, runs], [false, "not_needed", 1], "nothing to fix runs nothing");

  const failed = await applyAgentGitRouting({ read: () => Promise.resolve(gap), apply: () => Promise.resolve({ ok: false, error: "exit 1" }) });
  assert.deepEqual([failed.applied, failed.reason, failed.message], [false, "apply_failed", "The update did not finish: exit 1"]);
  clearAgentIdentityCache();
}

// "Invite the bot" runs on the server for a repo with no checkout too, only with a working bot, and
// answers with the repo read afresh.
async function inviteNeedsAWorkingBotAndRereadsTheRepo() {
  clearAgentIdentityCache();
  const calls = [];
  let accepted = false;
  const read = ({ repositoryId }) => Promise.resolve({
    state: accepted ? "healthy" : "problem", repository: "example/elsewhere", botLogin: "robo-bot", userAdmin: true, reason: null, ownerMessage: null,
    problems: accepted ? [] : [{ id: "not-collaborator", severity: "problem", message: "robo-bot cannot push.", fix: "x" }], repositoryId,
  });
  const invite = (options) => { calls.push(options); accepted = true; return Promise.resolve({ ok: true }); };
  const result = await inviteAgentBot({ repositoryId: NO_CHECKOUT, stateRoot, readAccountReport: () => Promise.resolve(readyAccount()), read, invite });
  assert.equal(result.invited, true);
  assert.equal(result.repository.state, "healthy", "the answer carries the repo read after");
  assert.deepEqual([calls.length, calls[0].repositoryId, calls[0].botLogin], [1, NO_CHECKOUT, "robo-bot"]);

  clearAgentIdentityCache();
  const refused = await inviteAgentBot({
    repositoryId: GITHUB, stateRoot, readAccountReport: () => Promise.resolve(readyAccount()), read,
    invite: () => Promise.resolve({ ok: false, message: "GitHub refused: Must have admin rights." }),
  });
  assert.deepEqual([refused.invited, refused.reason, refused.message], [false, "refused", "GitHub refused: Must have admin rights."]);

  clearAgentIdentityCache();
  let tried = false;
  const waiting = await inviteAgentBot({
    repositoryId: GITHUB, stateRoot, read, invite: () => { tried = true; return Promise.resolve({ ok: true }); },
    readAccountReport: () => Promise.resolve(readyAccount({ state: "problem", botLogin: null, problems: [{ id: "expired", severity: "problem", message: "x", fix: "x" }] })),
  });
  assert.deepEqual([waiting.invited, waiting.reason, tried], [false, "not_ready", false], "no invite without a working bot");
  await assert.rejects(inviteAgentBot({ repositoryId: "git:github.com/example/unknown", stateRoot, read, invite }), (error) => error.code === "NOT_FOUND");
  clearAgentIdentityCache();
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
  assert.equal(request.closeOnSuccess, true, "a finished setup closes its window");
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
  assert.ok(body.split("\n").includes(`exec ${shellQuote(process.execPath)} x`), "without closeOnSuccess the program replaces the shell");

  // closeOnSuccess: the script parses, closes only its own Terminal window (found by tty) after a
  // success, and keeps the window open after a failure.
  launchInTerminal({ name: "closing", executable: process.execPath, args: ["x"], cwd: checkout, closeOnSuccess: true }, { platform: "darwin", dir, run });
  const closing = path.join(dir, "closing.command");
  const script = fs.readFileSync(closing, "utf8");
  assert.equal(spawnSync("sh", ["-n", closing]).status, 0, "the script parses");
  assert.doesNotMatch(script, /^exec /m);
  assert.match(script, /if tty of t is "'"\$tty"'" then close w/);
  assert.match(script, /It stopped\. Read the message above, then close this window\./);
  assert.match(script, /if \[ "\$TERM_PROGRAM" != "Apple_Terminal" \]; then\n  printf "\\nDone\. You can close this window\.\\n"/);
  // A failing program exits with its status and never reaches the close.
  const failing = path.join(dir, "failing.command");
  launchInTerminal({ name: "failing", executable: "/usr/bin/false", closeOnSuccess: true }, { platform: "darwin", dir, run });
  const failed = spawnSync("sh", [failing], { encoding: "utf8", env: { ...process.env, TERM_PROGRAM: "Apple_Terminal" } });
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /It stopped/);
  // Outside Terminal a success only says the window can be closed.
  launchInTerminal({ name: "passing", executable: "/usr/bin/true", closeOnSuccess: true }, { platform: "darwin", dir, run });
  const passed = spawnSync("sh", [path.join(dir, "passing.command")], { encoding: "utf8", env: { ...process.env, TERM_PROGRAM: "iTerm.app" } });
  assert.equal(passed.status, 0);
  assert.match(passed.stdout, /Done\. You can close this window\./);
  assert.equal(launchInTerminal({ name: "setup", executable: process.execPath, cwd: "relative/folder" }, { platform: "darwin", dir, run }).reason, "no_folder");
  assert.equal(launchInTerminal({ name: "setup", executable: process.execPath, cwd: path.join(tmp, "absent") }, { platform: "darwin", dir, run }).reason, "no_folder");
}

// "No thanks" to Home's offer is a marker in RoboRepo's state, read with every account answer.
async function offerDismissalIsRemembered() {
  const offerRoot = path.join(tmp, "offer-state");
  const read = () => Promise.resolve(readyAccount());
  assert.equal((await loadAgentIdentityAccount({ fresh: true, stateRoot: offerRoot, read })).offerDismissed, false);
  assert.deepEqual(dismissAgentIdentityOffer({ stateRoot: offerRoot, now: () => new Date("2026-11-24T10:00:00Z") }), { offerDismissed: true });
  assert.equal(fs.readFileSync(path.join(offerRoot, "agent-identity", "offer-dismissed"), "utf8"), "2026-11-24T10:00:00.000Z\n");
  assert.equal((await loadAgentIdentityAccount({ fresh: true, stateRoot: offerRoot, read })).offerDismissed, true);
  clearAgentIdentityCache();
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
    loadAgentIdentityAccount: (params) => { calls.push(["account", params]); return Promise.resolve({ state: "healthy" }); },
    turnOnAgentIdentity: () => { calls.push(["enable"]); return Promise.resolve({ enabled: true }); },
    dismissAgentIdentityOffer: () => { calls.push(["dismiss"]); return { offerDismissed: true }; },
    applyAgentGitRouting: () => { calls.push(["update"]); return Promise.resolve({ applied: true }); },
    inviteAgentBot: (params) => { calls.push(["invite", params]); return Promise.resolve({ invited: true }); },
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
  calls.length = 0;

  await request("GET", "/api/agent-identity", "fresh=1", handlers);
  await request("GET", "/api/agent-identity", "", handlers);
  assert.deepEqual(calls.splice(0), [["account", { fresh: true }], ["account", { fresh: false }]]);
  assert.equal((await request("POST", "/api/agent-identity/enable", "", handlers, JSON.stringify({ id: "something-else" }))).status, 400);
  assert.deepEqual(calls, [], "a body is refused before anything is enabled");
  const turned = await request("POST", "/api/agent-identity/enable", "", handlers, "");
  assert.equal(turned.status, 200);
  assert.deepEqual(calls.splice(0), [["enable"]]);
  assert.equal((await request("POST", "/api/agent-identity/dismiss-offer", "", handlers, JSON.stringify({ forever: false }))).status, 400);
  assert.deepEqual(calls, [], "a body is refused before anything is saved");
  const dismissed = await request("POST", "/api/agent-identity/dismiss-offer", "", handlers, "");
  assert.deepEqual(JSON.parse(dismissed.body), { offerDismissed: true });
  assert.deepEqual(calls.splice(0), [["dismiss"]]);
  assert.equal((await request("POST", "/api/agent-identity/update", "", handlers, JSON.stringify({ args: ["--on-conflict", "overwrite"] }))).status, 400);
  assert.deepEqual(calls, [], "a body is refused before anything is applied");
  const updated = await request("POST", "/api/agent-identity/update", "", handlers, "");
  assert.deepEqual(JSON.parse(updated.body), { applied: true });
  assert.deepEqual(calls.splice(0), [["update"]]);
  assert.equal((await request("POST", `/api/repositories/${id}/agent-identity/invite`, "", handlers, JSON.stringify({ login: "someone" }))).status, 400);
  assert.deepEqual(calls, [], "a body is refused before anyone is invited");
  const inviting = await request("POST", `/api/repositories/${id}/agent-identity/invite`, "", handlers, "");
  assert.deepEqual(JSON.parse(inviting.body), { invited: true });
  assert.deepEqual(calls, [["invite", { repositoryId: GITHUB }]]);
}

// The real reads in a child process, because the state folder and package state are read when the
// modules load. With the package on, a healthy bot reads as `healthy` for the account and the repo;
// with it off, the account's one finding is the package, its fix is turning it on, and the portal
// offers Turn on.
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
    const module = JSON.stringify(path.join(repoRoot, "scripts/cli/repository-agent-identity.mjs"));
    const script = `import { loadAgentIdentityAccount, loadRepositoryAgentIdentity } from ${module};
      const account = await loadAgentIdentityAccount({ fresh: true });
      const repo = await loadRepositoryAgentIdentity({ repositoryId: ${JSON.stringify(GITHUB)} });
      console.log(JSON.stringify({ account, repo }));`;
    // Started from another folder, as the portal is: the package state must not depend on the cwd.
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: tmp, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(!result.stdout.includes(TOKEN), "no token in the answer");
    return JSON.parse(result.stdout);
  };
  const on = read(true);
  assert.deepEqual([on.account.state, on.account.botLogin, on.account.packageEnabled, on.account.findings, on.account.enableOffered], ["healthy", "robo-bot", true, [], false]);
  assert.deepEqual([on.repo.account, on.repo.state, on.repo.userAdmin, on.repo.findings], ["ready", "healthy", true, []]);
  const off = read(false);
  assert.equal(off.account.state, "problem");
  assert.deepEqual(off.account.findings.map((entry) => [entry.id, entry.fix]), [["package-off", "Turn it on: roborepo package enable github-agent-identity."]]);
  assert.equal(off.account.enableOffered, true);
  assert.deepEqual([off.repo.state, off.repo.findings], ["healthy", []], "the package is the account's, so the repo stays clean");
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
