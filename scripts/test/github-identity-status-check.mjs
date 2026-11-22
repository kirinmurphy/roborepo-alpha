#!/usr/bin/env node
// `roborepo github status` and doctor's agent identity line against a fake `gh`: the line and exit
// code for each state, that a hint never turns doctor red, and that
// ROBOREPO_SKIP_AGENT_IDENTITY_CHECK=1 keeps doctor off GitHub.
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
const root = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-gh-identity-status-"));
isolateGitConfig(root);
const stateRoot = path.join(root, "state");
const ghDir = path.join(stateRoot, "github-agent", "gh");
const TOKEN = "ghp_statuscheck0123456789";
const BOT = "robo-bot";

try {
  const gh = createFakeGh(root);
  const checkout = clone("checkout", "git@github.com:example/project.git");
  const env = {
    ...process.env, ...gh.env, HOME: path.join(root, "home"), ROBOREPO_STATE_ROOT: stateRoot,
    PATH: `${gh.dir}${path.delimiter}${process.env.PATH}`, ROBOREPO_SKIP_NODE_RELEASE_CHECK: "1", ROBOREPO_SKIP_PROTECTION_CHECK: "1",
  };
  delete env.ROBOREPO_SKIP_AGENT_IDENTITY_CHECK;
  delete env.GH_CONFIG_DIR;
  const node = (script, args, extraEnv = {}) => spawnSync(process.execPath, [path.join(repoRoot, script), ...args], { cwd: checkout, env: { ...env, ...extraEnv }, encoding: "utf8" });
  const line = () => node("scripts/cli/github-identity.mjs", ["--doctor"]);
  const doctor = (extraEnv = {}) => spawnSync("bash", [path.join(repoRoot, "scripts/doctor.sh"), "--verbose"], { cwd: checkout, env: { ...env, ...extraEnv }, encoding: "utf8" });

  // The managed rulesets, made by the real `roborepo protect` against the fake.
  gh.setState(fakeGitHubState());
  const protectRun = node("scripts/cli/main.mjs", ["protect"]);
  assert.equal(protectRun.status, 0, protectRun.stdout + protectRun.stderr);
  const managed = gh.readState().rulesets;

  const start = ({ token = {}, hosts = "token", enabled = true, ...overrides } = {}) => {
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.mkdirSync(ghDir, { recursive: true });
    if (hosts === "token") fs.writeFileSync(path.join(ghDir, "hosts.yml"), `github.com:\n    oauth_token: ${TOKEN}\n    user: ${BOT}\n`);
    if (hosts === "keychain") {
      fs.writeFileSync(path.join(ghDir, "hosts.yml"), `github.com:\n    user: ${BOT}\n`);
      fs.writeFileSync(path.join(ghDir, ".fake-token"), `${TOKEN}\n`);
    }
    if (enabled) fs.writeFileSync(path.join(stateRoot, "enabled-packages.json"), JSON.stringify({ schemaVersion: 2, packages: ["github-agent-identity"], disabled: [] }));
    gh.setState(fakeGitHubState({
      rulesets: structuredClone(managed),
      tokens: { [TOKEN]: { login: BOT, scopes: ["repo", "read:org"], expires: null, expired: false, ...token } },
      collaborators: [{ login: BOT, permission: "push" }],
      ...overrides,
    }));
    gh.clearCalls();
  };
  const expectLine = (status, pattern) => {
    const result = line();
    assert.equal(result.status, status, result.stdout + result.stderr);
    assert.match(result.stdout.trim(), pattern);
    assert.equal(result.stdout.trim().split("\n").length, 1, "doctor gets exactly one line");
  };

  // Not set up: an ok line, and no GitHub call at all.
  start({ hosts: "none", enabled: false });
  expectLine(0, /^GitHub agent identity not set up \(optional\) — run roborepo github setup in your own terminal$/);
  assert.deepEqual(gh.calls(), []);

  start();
  expectLine(0, /^GitHub agent identity: agents act as robo-bot on example\/project$/);
  start({ enabled: false });
  expectLine(1, /problem for example\/project: A bot is signed in but the github-agent-identity package is off.* — run roborepo github setup$/);
  start({ collaborators: [{ login: BOT, permission: "admin" }] });
  expectLine(1, /robo-bot is an admin of example\/project/);
  start({ collaborators: [] });
  expectLine(1, /robo-bot cannot push to example\/project/);
  start({ collaborators: [], invitations: [{ id: 5, invitee: BOT, repo: "example/project" }] });
  expectLine(1, /invited to example\/project but has not accepted/);
  start({ login: BOT });
  expectLine(1, /is your own account/);
  start({ token: { expired: true } });
  expectLine(1, /rejected the bot's token/);
  start({ token: { expires: "2020-01-01 00:00:00 UTC" } });
  expectLine(1, /token has expired/);
  start({ token: { scopes: ["repo", "read:org", "workflow"] } });
  expectLine(1, /broader access than agents need \(workflow\)/);
  start({ token: { scopes: ["repo"] } });
  expectLine(1, /lacks the read:org scope/);
  start({ rulesets: [] });
  expectLine(1, /Branch protection for this repo is missing/);
  start({ hosts: "keychain" });
  expectLine(1, /token is in the keychain, which agent sandboxes cannot read/);
  start({ failure: "unreachable" });
  expectLine(0, /^GitHub agent identity check skipped \(GitHub could not be reached\)$/);

  // A token close to expiry is advice: the status stays healthy and exits 0, doctor hints.
  const soon = new Date(Date.now() + 3 * 86_400_000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  start({ token: { expires: soon } });
  expectLine(1, /expires in 3 days/);
  let status = node("scripts/cli/main.mjs", ["github", "status"]);
  assert.equal(status.status, 0, status.stdout + status.stderr);
  assert.match(status.stdout, /healthy for example\/project: agents act as robo-bot\.\n {2}Note: .*expires in 3 days/);
  console.log("✓ Each identity state maps to its doctor line; a warning is a hint, a problem is a hint, never a failure.");

  // The status command: exit codes and JSON.
  start();
  status = node("scripts/cli/main.mjs", ["github", "status", "--json"]);
  assert.equal(status.status, 0, status.stdout + status.stderr);
  assert.deepEqual([JSON.parse(status.stdout).state, JSON.parse(status.stdout).botLogin], ["healthy", BOT]);
  start({ collaborators: [{ login: BOT, permission: "admin" }] });
  status = node("scripts/cli/main.mjs", ["github", "status"]);
  assert.equal(status.status, 1);
  assert.match(status.stdout, /has problems for example\/project:\n {2}Problem: .*admin.*\n {4}Fix: /);
  start({ hosts: "none", enabled: false });
  status = node("scripts/cli/main.mjs", ["github", "status"]);
  assert.equal(status.status, 0);
  assert.match(status.stdout, /not set up \(optional\)/);
  start({ failure: "unreachable" });
  status = node("scripts/cli/main.mjs", ["github", "status"]);
  assert.equal(status.status, 0);
  assert.match(status.stdout, /could not be checked for example\/project: GitHub could not be reached/);
  console.log("✓ github status exits 1 only for a problem, and --json prints the report.");

  // Outside a GitHub repo doctor adds no line.
  start();
  const other = spawnSync(process.execPath, [path.join(repoRoot, "scripts/cli/github-identity.mjs"), "--doctor"], { cwd: clone("gitlab", "git@gitlab.com:example/project.git"), env, encoding: "utf8" });
  assert.deepEqual([other.status, other.stdout], [0, ""]);
  assert.deepEqual(gh.calls(), []);

  // Through doctor: a hint is printed and doctor passes; the skip variable makes no gh call.
  start({ collaborators: [{ login: BOT, permission: "admin" }] });
  let result = doctor();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^hint: GitHub agent identity problem for example\/project: .*admin/m);
  assert.ok(gh.calls().length > 0);
  gh.clearCalls();
  result = doctor({ ROBOREPO_SKIP_AGENT_IDENTITY_CHECK: "1" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^ok: GitHub agent identity check skipped \(ROBOREPO_SKIP_AGENT_IDENTITY_CHECK=1\)$/m);
  assert.deepEqual(gh.calls(), [], "the skip variable makes no gh call");
  console.log("✓ doctor prints the hint without failing, and ROBOREPO_SKIP_AGENT_IDENTITY_CHECK=1 makes no gh call.");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
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
