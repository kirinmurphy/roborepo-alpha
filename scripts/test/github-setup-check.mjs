#!/usr/bin/env node
// `roborepo github setup` in scripted mode against a fake `gh`, with an isolated home and state
// root: a full run invites as the user, signs the bot in, accepts as the bot, protects the repo and
// turns the package on; a rerun finds every step done; a failed final check leaves the package off;
// and the token never appears in any output, argument log, or file except where gh stores it.
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

try {
  const gh = createFakeGh(root);
  const checkout = clone("checkout", "git@github.com:example/project.git");
  // ROBOREPO_SYSTEM_CA_BUNDLE replaces the system CA bundle search with one fixture file.
  const systemCa = path.join(root, "system-ca.pem");
  fs.writeFileSync(systemCa, "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n");
  const env = {
    ROBOREPO_SYSTEM_CA_BUNDLE: systemCa,
    ...process.env, ...gh.env, HOME: home, ROBOREPO_STATE_ROOT: stateRoot, SKIP_MCP: "1",
    PATH: `${gh.dir}${path.delimiter}${process.env.PATH}`, ROBOREPO_GITHUB_SETUP_SCRIPTED: "1",
  };
  delete env.GH_CONFIG_DIR;
  const setup = (answers) => spawnSync(process.execPath, [cli, "github", "setup"], { cwd: checkout, env, encoding: "utf8", input: answers });
  const claudeSettings = () => JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  const packageOn = () => claudeSettings().env?.GH_CONFIG_DIR === ghDir;

  const fresh = (overrides = {}) => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}");
    fs.copyFileSync(path.join(repoRoot, "generated", "codex", "config.toml"), path.join(home, ".codex", "config.toml"));
    gh.setState(fakeGitHubState({
      tokens: { [TOKEN]: { login: BOT, scopes: ["repo", "read:org"], expires: null, expired: false }, [OTHER_TOKEN]: { login: "someone-else", scopes: ["repo", "read:org"], expires: null, expired: false } },
      ...overrides,
    }));
    gh.clearCalls();
  };

  // A full run.
  fresh();
  let result = setup(`${BOT}\n${TOKEN}\ny\n`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /You are octo-admin, setting up example\/project/);
  assert.match(result.stdout, /Invited robo-bot to example\/project/);
  assert.match(result.stdout, /Token stored; signed in as robo-bot/);
  assert.match(result.stdout, /Invitation accepted as robo-bot/);
  assert.match(result.stdout, /Branch protection is now protected/);
  assert.match(result.stdout, /Agents now act on GitHub as robo-bot\. New agent sessions pick this up\./);
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
  assert.equal(login.configDir, ghDir);

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
  result = setup("");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const step of ["Bot account \\(robo-bot\\)", "Invitation", "Token", "Invitation accepted", "Branch protection", "Package on"]) {
    assert.match(result.stdout, new RegExp(`✓ ${step}.*: already done`), step);
  }
  assert.match(result.stdout, /✓ certificate bundle: already current/);
  assert.doesNotMatch(result.stdout, /Bot account login:|Paste the token|Protect the plans/);
  assert.ok(!gh.calls().some((call) => call.method === "PUT" || call.method === "PATCH" || call.method === "POST" || call.argv[0] === "auth"), "a rerun changes nothing");
  console.log("✓ A rerun prints every step as already done and makes no change.");

  // A token kept only in the keychain is not done: setup asks again and stores it in hosts.yml.
  fs.writeFileSync(path.join(ghDir, "hosts.yml"), `github.com:\n    user: ${BOT}\n`);
  fs.writeFileSync(path.join(ghDir, ".fake-token"), `${TOKEN}\n`);
  result = setup(`${TOKEN}\n`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Paste the token/);
  assert.match(result.stdout, /keeps its token in the keychain/);
  assert.match(fs.readFileSync(path.join(ghDir, "hosts.yml"), "utf8"), /oauth_token: ghp_setupcheck/);
  assert.equal(fs.statSync(path.join(ghDir, "hosts.yml")).mode & 0o777, 0o600);
  console.log("✓ A keychain-only login is replaced by a token in hosts.yml, mode 0600.");

  // A token for another account is refused and signed out again.
  fresh();
  result = setup(`${BOT}\n${OTHER_TOKEN}\n`);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /belongs to someone-else, not robo-bot/);
  assert.ok(!fs.existsSync(path.join(ghDir, "hosts.yml")), "the wrong login was removed");
  assert.ok(!packageOn());
  console.log("✓ A token for the wrong account is signed out again.");

  // The bot's own login, a missing account, and a refused invitation stop the run.
  fresh();
  result = setup("octo-admin\n");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /different account from your own/);
  fresh();
  result = setup("nobody-here\n");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no account named nobody-here/);
  fresh({ refuseInvite: true });
  result = setup(`${BOT}\n`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /refused the invitation: Must have admin rights/);

  // A failing final check leaves the package off.
  fresh({ invitePermission: "admin" });
  result = setup(`${BOT}\n${TOKEN}\ny\n`);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /The bot is not ready/);
  assert.match(result.stderr, /robo-bot is an admin of example\/project/);
  assert.match(result.stderr, /Fix: .*roborepo github setup|Fix: Lower robo-bot/);
  assert.ok(!packageOn(), "the package stays off");
  assert.ok(!fs.existsSync(path.join(stateRoot, "enabled-packages.json")) || !fs.readFileSync(path.join(stateRoot, "enabled-packages.json"), "utf8").includes("github-agent-identity"));
  assert.doesNotMatch(result.stdout, /Agents now act/);
  console.log("✓ A failing check prints each problem with its fix, exits 1, and leaves the package off.");

  // Without a terminal and without the test hook, setup refuses.
  const noTty = spawnSync(process.execPath, [cli, "github", "setup"], { cwd: checkout, env: { ...env, ROBOREPO_GITHUB_SETUP_SCRIPTED: "" }, encoding: "utf8", input: "" });
  assert.equal(noTty.status, 1);
  assert.match(noTty.stderr, /needs your own terminal/);
  console.log("✓ Without a terminal, setup refuses.");
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
