#!/usr/bin/env node
// `roborepo github setup` (`runSetup`, driven in process with injected answers) against a fake
// `gh`, with an isolated home and state root: a full run invites as the user, signs the bot in, accepts as the bot, protects the repo and
// turns the package on; a rerun finds every step done; a failed final check leaves the package off;
// and the token never appears in any output, argument log, or file except where gh stores it. The
// CLI entry itself refuses without a real terminal, however it is invoked.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeGh, fakeGitHubState } from "./lib/fake-gh.mjs";
import { isolateGitConfig } from "./lib/git-config.mjs";

if (process.platform === "win32") {
  console.log("skip: the fake gh executable requires a POSIX executable fixture");
  process.exit(0);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = path.join(repoRoot, "scripts", "cli", "main.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-gh-setup-"));
isolateGitConfig(root);
const home = path.join(root, "home");
const stateRoot = path.join(home, ".roborepo");
const ghDir = path.join(stateRoot, "github-agent", "gh");
const TOKEN = "ghp_setupcheck9876543210abcdef";
const OTHER_TOKEN = "ghp_someoneelse1234567890";
const BOT = "robo-bot";
// An expiry date well beyond the warning window, so the final check adds no note.
const FAR_EXPIRY = "2099-01-01 00:00:00 UTC";

try {
  const gh = createFakeGh(root);
  const checkout = clone("checkout", "git@github.com:example/project.git");
  // ROBOREPO_SYSTEM_CA_BUNDLE replaces the system CA bundle search with one fixture file.
  const systemCa = path.join(root, "system-ca.pem");
  fs.writeFileSync(systemCa, "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n");
  // The fixture CA comes after the caller's environment, so an exported override cannot replace it.
  const env = {
    ...process.env, ...gh.env, HOME: home, ROBOREPO_STATE_ROOT: stateRoot, SKIP_MCP: "1",
    ROBOREPO_SYSTEM_CA_BUNDLE: systemCa,
    PATH: `${gh.dir}${path.delimiter}${process.env.PATH}`,
  };
  // A gh sign-in or token from the caller's shell would outrank the fixture's in fake gh; the
  // exported-token case below sets one on purpose.
  const inherited = ["GH_CONFIG_DIR", "GH_TOKEN", "GITHUB_TOKEN"];
  for (const name of inherited) delete env[name];
  // The setup module reads its state root at import, so the environment is set before importing it.
  Object.assign(process.env, env);
  for (const name of inherited) delete process.env[name];
  const { runSetup } = await import("../cli/github-setup.mjs");
  // Answers come from a list, one per question, like the lines a person would type.
  const setup = async (answers) => {
    const lines = answers === "" ? [] : answers.replace(/\n$/, "").split("\n");
    const out = [];
    const err = [];
    const io = { log: (text) => out.push(text), error: (text) => err.push(text) };
    const next = (question) => { out.push(question); return lines.shift() ?? ""; };
    const input = { ask: async (question) => next(question), askHidden: async (question) => next(question) };
    const status = await runSetup({ input, io, cwd: checkout });
    return { status, stdout: out.join("\n"), stderr: err.join("\n") };
  };
  const claudeSettings = () => JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  const packageOn = () => claudeSettings().env?.GH_CONFIG_DIR === ghDir;

  const fresh = (overrides = {}) => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}");
    fs.copyFileSync(path.join(repoRoot, "generated", "codex", "config.toml"), path.join(home, ".codex", "config.toml"));
    gh.setState(fakeGitHubState({
      tokens: { [TOKEN]: { login: BOT, scopes: ["repo", "read:org"], expires: FAR_EXPIRY, expired: false }, [OTHER_TOKEN]: { login: "someone-else", scopes: ["repo", "read:org"], expires: FAR_EXPIRY, expired: false } },
      ...overrides,
    }));
    gh.clearCalls();
  };

  // A full run.
  fresh();
  let result = await setup(`${BOT}\n${TOKEN}\ny\n`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /You are octo-admin, setting up example\/project/);
  assert.match(result.stdout, /Invited robo-bot to example\/project/);
  assert.match(result.stdout, /Token stored; signed in as robo-bot/);
  assert.match(result.stdout, /Invitation accepted as robo-bot/);
  assert.match(result.stdout, /Branch protection is now protected/);
  assert.match(result.stdout, /Agents now act on GitHub as robo-bot\. New agent sessions pick this up\./);
  // The pages are printed to copy into the bot's browser, never opened in your own.
  assert.match(result.stdout, /another browser, so your own session stays signed in: https:\/\/github\.com\/signup/);
  assert.match(result.stdout, /In the browser where robo-bot is signed in, open https:\/\/github\.com\/settings\/tokens\/new/);
  assert.match(result.stdout, /cannot read the keychain, so the token is stored in .*hosts\.yml/);
  const state = gh.readState();
  assert.deepEqual(state.collaborators, [{ login: BOT, permission: "push" }]);
  assert.deepEqual(state.invitations, []);
  assert.equal(state.rulesets.length, 3, "protection was applied");
  assert.ok(packageOn(), "the package is on");
  assert.equal(fs.statSync(path.join(ghDir, "hosts.yml")).mode & 0o777, 0o600, "hosts.yml is private even when gh leaves it wider");
  assert.equal(fs.statSync(ghDir).mode & 0o777, 0o700);
  assert.match(result.stdout, /✓ certificate bundle: copied for Codex's sandbox/);
  const caCopy = path.join(stateRoot, "github-agent", "ca-bundle.crt");
  assert.deepEqual(fs.readFileSync(caCopy), fs.readFileSync(systemCa), "the CA copy is identical to the system bundle");
  const localConfig = fs.readFileSync(path.join(stateRoot, "github-agent", "gitconfig.local"), "utf8");
  assert.equal(localConfig.split("\n").filter((line) => !line.startsWith("#")).join("\n"), `[http "https://github.com/"]\n\tsslCAInfo = ${caCopy}\n`);

  const calls = gh.calls();
  const invite = calls.find((call) => call.method === "PUT" && /collaborators\/robo-bot$/.test(call.endpoint));
  assert.ok(invite && invite.configDir === null, "the invitation is sent as the user");
  const accept = calls.find((call) => call.method === "PATCH");
  assert.ok(accept && accept.configDir === ghDir, "the invitation is accepted as the bot");
  const login = calls.find((call) => call.argv[0] === "auth" && call.argv[1] === "login");
  assert.deepEqual(login.argv, ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--with-token", "--insecure-storage"]);
  assert.equal(login.configDir, path.join(stateRoot, "github-agent", "gh-staging"), "the token is tried in a staging folder first");
  assert.ok(!fs.existsSync(path.join(stateRoot, "github-agent", "gh-staging")), "the staging folder is removed afterwards");

  // The token appears nowhere but the hosts.yml gh wrote (and the fake's own server-side state).
  const allowed = new Set([path.join(ghDir, "hosts.yml"), path.join(root, "fake-gh-state.json")].map((file) => fs.realpathSync(file)));
  assert.ok(fs.readFileSync(path.join(ghDir, "hosts.yml"), "utf8").includes(TOKEN), "the fake stored the token in hosts.yml");
  assert.ok(!(result.stdout + result.stderr).includes(TOKEN), "the token is never printed");
  assert.ok(!fs.readFileSync(gh.env.FAKE_GH_LOG, "utf8").includes(TOKEN), "the token is in no argument");
  const leaks = filesUnder(root).filter((file) => !allowed.has(fs.realpathSync(file)) && fs.readFileSync(file).includes(TOKEN));
  assert.deepEqual(leaks, [], "no other file holds the token");
  console.log("✓ A full run invites as the user, signs the bot in, accepts as the bot, protects the repo, enables the package, and leaks no token.");

  // A rerun finds every step done and asks nothing.
  gh.clearCalls();
  result = await setup("");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const step of ["Bot account \\(robo-bot\\)", "Invitation", "Token", "Invitation accepted", "Branch protection", "Package on"]) {
    assert.match(result.stdout, new RegExp(`✓ ${step}.*: already done`), step);
  }
  assert.match(result.stdout, /✓ certificate bundle: already current/);
  assert.doesNotMatch(result.stdout, /Bot account login:|Paste the token|Protect the plans/);
  assert.ok(!gh.calls().some((call) => call.method === "PUT" || call.method === "PATCH" || call.method === "POST" || call.argv[0] === "auth"), "a rerun changes nothing");
  console.log("✓ A rerun prints every step as already done and makes no change.");

  // The token expires (or is revoked): a rerun renews it for the saved bot without the new-account
  // steps, asks only for the token, and leaves every other step alone.
  const RENEWED = "ghp_renewedtoken000111222333";
  const expiredState = gh.readState();
  expiredState.tokens[TOKEN].expired = true;
  expiredState.tokens[RENEWED] = { login: BOT, scopes: ["repo", "read:org"], expires: FAR_EXPIRY, expired: false };
  gh.setState(expiredState);
  gh.clearCalls();
  result = await setup(`${RENEWED}\n`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /✓ Bot account: robo-bot \(GitHub no longer accepts its saved token/);
  assert.doesNotMatch(result.stdout, /Bot account login:|github\.com\/signup|Protect the plans/);
  assert.match(result.stdout, /In the browser where robo-bot is signed in, open https:\/\/github\.com\/settings\/tokens$/m, "renewal names the token list, where Regenerate is");
  assert.match(result.stdout, /Regenerate token/);
  assert.match(result.stdout, /Token stored; signed in as robo-bot/);
  for (const step of ["Invitation", "Invitation accepted", "Branch protection", "Package on"]) {
    assert.match(result.stdout, new RegExp(`✓ ${step}.*: already done`), `renewal: ${step}`);
  }
  assert.ok(fs.readFileSync(path.join(ghDir, "hosts.yml"), "utf8").includes(RENEWED), "the new token replaced the old one");
  assert.ok(!(result.stdout + result.stderr).includes(RENEWED), "the renewed token is never printed");
  assert.ok(!gh.calls().some((call) => call.method === "PUT" || call.method === "PATCH"), "renewal sends no invitation and accepts none");
  console.log("✓ An expired token is renewed for the saved bot: only the token is asked for, every other step is already done.");
  const restored = gh.readState();
  restored.tokens[TOKEN].expired = false;
  gh.setState(restored);

  // A token that still works but expires soon can be replaced on a rerun, before agents fail.
  const SOON = "ghp_expiressoon0000111122223333";
  const soonExpiry = new Date(Date.now() + 3 * 86_400_000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  const soonState = gh.readState();
  soonState.tokens[SOON] = { login: BOT, scopes: ["repo", "read:org"], expires: soonExpiry, expired: false };
  gh.setState(soonState);
  const hostsFile = path.join(ghDir, "hosts.yml");
  fs.writeFileSync(hostsFile, `github.com:\n    oauth_token: ${SOON}\n    user: ${BOT}\n`, { mode: 0o600 });
  result = await setup("n\n");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Note: The bot's token expires in 3 days\.\nReplace the bot's token now\? \[Y\/n\]/);
  assert.match(result.stdout, /✓ Token: already done/, "declining keeps the working token");
  assert.ok(fs.readFileSync(hostsFile, "utf8").includes(SOON));
  result = await setup(`y\n${TOKEN}\n`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Regenerate token/, "replacing a working token is a renewal");
  assert.ok(fs.readFileSync(hostsFile, "utf8").includes(TOKEN), "accepting installs the new token");
  console.log("✓ A working token that expires soon can be replaced on a rerun, or kept.");

  // A replacement the checks reject is never installed: the working token stays in place.
  const BROAD = "ghp_workflowscope0000111122223333";
  const broadState = gh.readState();
  broadState.tokens[SOON] = { login: BOT, scopes: ["repo", "read:org"], expires: soonExpiry, expired: false };
  broadState.tokens[BROAD] = { login: BOT, scopes: ["repo", "read:org", "workflow"], expires: FAR_EXPIRY, expired: false };
  gh.setState(broadState);
  fs.writeFileSync(hostsFile, `github.com:\n    oauth_token: ${SOON}\n    user: ${BOT}\n`, { mode: 0o600 });
  result = await setup(`y\n${BROAD}\n`);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /That token was not stored: .*broader access than agents need \(workflow\)/);
  assert.ok(fs.readFileSync(hostsFile, "utf8").includes(SOON), "the working token is kept");
  assert.ok(!fs.existsSync(path.join(stateRoot, "github-agent", "gh-staging")), "the staging folder is removed after a rejection");
  fs.writeFileSync(hostsFile, `github.com:\n    oauth_token: ${TOKEN}\n    user: ${BOT}\n`, { mode: 0o600 });
  console.log("✓ A replacement token the checks reject is not stored, and the working one stays.");

  // A token the user exported does not stand in for the bot's stored one.
  const exported = gh.readState();
  exported.tokens.ghp_userexported0000 = { login: "octo-admin", scopes: ["repo", "read:org", "workflow"], expires: FAR_EXPIRY, expired: false };
  gh.setState(exported);
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN"]) {
    process.env[name] = "ghp_userexported0000";
    try {
      result = await setup("");
    } finally {
      delete process.env[name];
    }
    assert.equal(result.status, 0, `${name}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /✓ Bot account \(robo-bot\): already done/, `${name}: the bot is still found`);
  }
  console.log("✓ An exported GH_TOKEN or GITHUB_TOKEN does not replace the bot's stored token.");

  // The package is selected but one of its files is missing: a rerun installs it again.
  const assetFile = path.join(stateRoot, "package-runtime", "github-agent-identity", "gitconfig");
  assert.ok(fs.existsSync(assetFile), `the package's Git config is installed at ${assetFile}`);
  fs.rmSync(assetFile);
  result = await setup("");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /Package on: already done/);
  assert.ok(fs.existsSync(assetFile), "the rerun reinstalled the missing file");
  console.log("✓ A selected package with a missing file is re-applied, not reported done.");

  // An install whose GIT_CONFIG_COUNT predates the bot's include: the package's files are all in
  // place, but Git ignores the include. A rerun refuses to report success and names the update that adds it.
  // Routing gaps are read only for enabled harnesses, so Codex (whose config holds the pairs) is on.
  const harnessState = path.join(stateRoot, "harnesses", "state.json");
  fs.mkdirSync(path.dirname(harnessState), { recursive: true });
  fs.writeFileSync(harnessState, JSON.stringify({
    schemaVersion: 2, lastDiscoveredAt: new Date().toISOString(),
    providers: { codex: { enabled: true, selectionSource: "user", confidence: "confirmed", evidence: [], warnings: [] } },
  }));
  const codexConfig = path.join(home, ".codex", "config.toml");
  assert.match(fs.readFileSync(codexConfig, "utf8"), /^GIT_CONFIG_VALUE_1 = "~\/\.roborepo\/package-runtime\/github-agent-identity\/gitconfig"$/m);
  fs.writeFileSync(codexConfig, fs.readFileSync(codexConfig, "utf8").replace(/^GIT_CONFIG_COUNT = "2"$/m, 'GIT_CONFIG_COUNT = "1"'));
  result = await setup("");
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /Package on: already done|Agents now act/);
  assert.match(result.stderr, /your Codex settings don't include the bot's Git settings yet.*Run roborepo update, then rerun this\./);
  fs.writeFileSync(codexConfig, fs.readFileSync(codexConfig, "utf8").replace(/^GIT_CONFIG_COUNT = "1"$/m, 'GIT_CONFIG_COUNT = "2"'));
  result = await setup("");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /✓ Package on: already done/);
  fs.rmSync(harnessState);
  console.log("✓ A package whose Git include sits beyond GIT_CONFIG_COUNT is not reported as done.");

  // A working token kept only in the keychain is moved to hosts.yml without asking for a new one.
  fs.writeFileSync(path.join(ghDir, "hosts.yml"), `github.com:\n    user: ${BOT}\n`);
  fs.writeFileSync(path.join(ghDir, ".fake-token"), `${TOKEN}\n`);
  result = await setup("");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /Paste the token|settings\/tokens/);
  assert.match(result.stdout, /✓ Token: moved from the keychain to .*hosts\.yml, where agents can read it\./);
  assert.match(result.stdout, /✓ Token: already done/);
  assert.match(fs.readFileSync(path.join(ghDir, "hosts.yml"), "utf8"), /oauth_token: ghp_setupcheck/);
  assert.equal(fs.statSync(path.join(ghDir, "hosts.yml")).mode & 0o777, 0o600);
  console.log("✓ A working keychain token is moved to hosts.yml, mode 0600, without asking again.");

  // A token for another account is refused and never stored.
  fresh();
  result = await setup(`${BOT}\n${OTHER_TOKEN}\n`);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /belongs to someone-else, not robo-bot/);
  assert.ok(!fs.existsSync(path.join(ghDir, "hosts.yml")), "the wrong login was removed");
  assert.ok(!packageOn());
  console.log("✓ A token for the wrong account is refused and never stored.");

  // The bot's own login, a missing account, and a refused invitation stop the run.
  fresh();
  result = await setup("octo-admin\n");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /different account from your own/);
  fresh();
  result = await setup("nobody-here\n");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no account named nobody-here/);
  // A refused invitation does not stop the bot account's own steps; the final check names it and
  // the package stays off.
  fresh({ refuseInvite: true });
  result = await setup(`${BOT}\n${TOKEN}\ny\n`);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /You cannot invite robo-bot to example\/project \(GitHub: Must have admin rights/);
  assert.match(result.stdout, /✓ Token stored/);
  assert.match(result.stderr, /robo-bot cannot push to example\/project/);
  assert.ok(!packageOn(), "the package stays off");
  // In a repo someone else administers, the final check prints the message for its owner.
  fresh({ admin: false });
  result = await setup(`${BOT}\n${TOKEN}\ny\n`);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /you are not an admin there, so setup cannot invite it/);
  assert.match(result.stderr, /Message for the repo's owner:\nHi!/);
  assert.match(result.stderr, /Invite robo-bot to example\/project as a collaborator with Write access/);
  assert.ok(!packageOn(), "the package stays off");
  console.log("✓ A repo you cannot invite to finishes the bot's steps, leaves the package off, and prints a message for the owner.");

  // A failing final check leaves the package off.
  fresh({ invitePermission: "admin" });
  result = await setup(`${BOT}\n${TOKEN}\ny\n`);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /The bot is not ready/);
  assert.match(result.stderr, /robo-bot is an admin of example\/project/);
  assert.match(result.stderr, /Fix: .*roborepo github setup|Fix: Lower robo-bot/);
  assert.ok(!packageOn(), "the package stays off");
  assert.ok(!fs.existsSync(path.join(stateRoot, "enabled-packages.json")) || !fs.readFileSync(path.join(stateRoot, "enabled-packages.json"), "utf8").includes("github-agent-identity"));
  assert.doesNotMatch(result.stdout, /Agents now act/);
  console.log("✓ A failing check prints each problem with its fix, exits 1, and leaves the package off.");

  // A GH_CONFIG_DIR you set yourself is not the package's to replace: the install is partial, so
  // setup fails rather than reporting that agents act as the bot.
  fresh();
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ env: { GH_CONFIG_DIR: "/somewhere/else/gh" } }));
  result = await setup(`${BOT}\n${TOKEN}\ny\n`);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /The package did not install completely/);
  assert.doesNotMatch(result.stdout, /Agents now act/);
  assert.equal(claudeSettings().env.GH_CONFIG_DIR, "/somewhere/else/gh", "your own setting is left alone");
  console.log("✓ A partial package install (your own GH_CONFIG_DIR) fails setup instead of reporting success.");

  // A login typed in another case is accepted, and the token check uses GitHub's own spelling.
  fresh();
  result = await setup(`ROBO-Bot\n${TOKEN}\ny\n`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Bot account: robo-bot/);
  assert.match(result.stdout, /Token stored; signed in as robo-bot/);
  assert.match(result.stdout, /Agents now act on GitHub as robo-bot/);
  assert.deepEqual(gh.readState().collaborators, [{ login: BOT, permission: "push" }]);
  assert.ok(packageOn());
  console.log("✓ A login typed in a different case completes setup.");

  // The CLI refuses without a real terminal, even with the old scripting switch set: nothing is
  // asked, written, or sent to GitHub.
  fresh();
  const before = fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8");
  const piped = spawnSync(process.execPath, [cli, "github", "setup"], {
    cwd: checkout, env: { ...env, ROBOREPO_GITHUB_SETUP_SCRIPTED: "1" }, encoding: "utf8", input: `${BOT}\n${TOKEN}\ny\n`,
  });
  assert.notEqual(piped.status, 0);
  assert.match(piped.stderr, /needs your own terminal/);
  assert.deepEqual(gh.calls(), [], "no gh call was made");
  assert.ok(!fs.existsSync(path.join(stateRoot, "github-agent")), "nothing was written");
  assert.equal(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"), before);
  assert.ok(!(piped.stdout + piped.stderr).includes(TOKEN));
  console.log("✓ Without a terminal the CLI refuses, whatever the environment says.");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function filesUnder(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(full));
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

function clone(name, origin) {
  const dir = path.join(root, name);
  const run = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  run("init", "-q", "-b", "main", dir);
  run("-C", dir, "remote", "add", "origin", origin);
  return dir;
}
