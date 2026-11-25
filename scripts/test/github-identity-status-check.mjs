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
// A token with an expiry date well beyond the warning window, so it draws no note.
const FAR_EXPIRY = "2099-01-01 00:00:00 UTC";
// ROBOREPO_SYSTEM_CA_BUNDLE replaces the system CA bundle search with one fixture file.
const systemCa = path.join(root, "system-ca.pem");
fs.writeFileSync(systemCa, "fixture bundle\n");

try {
  const gh = createFakeGh(root);
  const checkout = clone("checkout", "git@github.com:example/project.git");
  const env = {
    ...process.env, ...gh.env, HOME: path.join(root, "home"), ROBOREPO_STATE_ROOT: stateRoot, ROBOREPO_SYSTEM_CA_BUNDLE: systemCa,
    PATH: `${gh.dir}${path.delimiter}${process.env.PATH}`, ROBOREPO_SKIP_NODE_RELEASE_CHECK: "1", ROBOREPO_SKIP_PROTECTION_CHECK: "1",
  };
  delete env.ROBOREPO_SKIP_AGENT_IDENTITY_CHECK;
  // A token exported in the caller's shell would outrank the fixture's sign-in in fake gh.
  for (const name of ["GH_CONFIG_DIR", "GH_TOKEN", "GITHUB_TOKEN"]) delete env[name];
  const node = (script, args, extraEnv = {}) => spawnSync(process.execPath, [path.join(repoRoot, script), ...args], { cwd: checkout, env: { ...env, ...extraEnv }, encoding: "utf8" });
  const line = () => node("scripts/cli/github-identity.mjs", ["--doctor"]);
  const doctor = (extraEnv = {}) => spawnSync("bash", [path.join(repoRoot, "scripts/doctor.sh"), "--verbose"], { cwd: checkout, env: { ...env, ...extraEnv }, encoding: "utf8" });

  // The managed rulesets, made by the real `roborepo protect` against the fake.
  gh.setState(fakeGitHubState());
  const protectRun = node("scripts/cli/main.mjs", ["protect"]);
  assert.equal(protectRun.status, 0, protectRun.stdout + protectRun.stderr);
  const managed = gh.readState().rulesets;

  const start = ({ token = {}, hosts = "token", enabled = true, ca = "current", ...overrides } = {}) => {
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.mkdirSync(ghDir, { recursive: true });
    if (hosts === "token") fs.writeFileSync(path.join(ghDir, "hosts.yml"), `github.com:\n    oauth_token: ${TOKEN}\n    user: ${BOT}\n`);
    if (hosts === "keychain") {
      fs.writeFileSync(path.join(ghDir, "hosts.yml"), `github.com:\n    user: ${BOT}\n`);
      fs.writeFileSync(path.join(ghDir, ".fake-token"), `${TOKEN}\n`);
    }
    const caCopy = path.join(stateRoot, "github-agent", "ca-bundle.crt");
    if (ca === "current" || ca === "config-missing" || ca === "config-other") fs.copyFileSync(systemCa, caCopy);
    const caConfig = `# Codex's sandbox denies *.pem files, so Git reads a copy of the system CA bundle.\n[http "https://github.com/"]\n\tsslCAInfo = ${caCopy}\n`;
    if (ca === "current") fs.writeFileSync(path.join(stateRoot, "github-agent", "gitconfig.local"), caConfig);
    if (ca === "config-other") fs.writeFileSync(path.join(stateRoot, "github-agent", "gitconfig.local"), "[http]\n\tsslCAInfo = /elsewhere.crt\n");
    if (ca === "stale") fs.writeFileSync(path.join(stateRoot, "github-agent", "ca-bundle.crt"), "an older bundle\n");
    if (enabled) fs.writeFileSync(path.join(stateRoot, "enabled-packages.json"), JSON.stringify({ schemaVersion: 2, packages: ["github-agent-identity"], disabled: [] }));
    gh.setState(fakeGitHubState({
      rulesets: structuredClone(managed),
      tokens: { [TOKEN]: { login: BOT, scopes: ["repo", "read:org"], expires: FAR_EXPIRY, expired: false, ...token } },
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
  // With the bot otherwise ready, turning the package on is the whole fix; with anything else
  // wrong, the setup fixes it and turns the package on at the end.
  start({ enabled: false });
  expectLine(1, /problem for example\/project: The bot is signed in, but the github-agent-identity package is off.* — turn it on: roborepo package enable github-agent-identity$/);
  start({ enabled: false, token: { scopes: ["repo"] } });
  expectLine(1, /lacks the read:org scope/);
  {
    const report = JSON.parse(node("scripts/cli/main.mjs", ["github", "status", "--json"]).stdout);
    const off = report.problems.find((entry) => entry.id === "package-off");
    assert.match(off.fix, /^Run roborepo github setup in your own terminal; it fixes the above/, "the setup is the step when more than the package is missing");
    assert.equal(report.problems.at(-1).id, "package-off", "the package finding follows what the bot account lacks");
  }
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
  // Any scope beyond repo and read:org is too broad, not only a known list of risky ones.
  start({ token: { scopes: ["repo", "read:org", "admin:public_key"] } });
  expectLine(1, /broader access than agents need \(admin:public_key\)/);
  // A fine-grained token lists no scopes, so nothing confirms what it may do.
  start({ token: { scopes: null } });
  expectLine(1, /fine-grained token.* — make a classic token/);
  const jsonReport = (extraEnv) => JSON.parse(node("scripts/cli/main.mjs", ["github", "status", "--json"], extraEnv).stdout);
  // A token the user exported does not stand in for the bot's stored one.
  start();
  const withUserToken = gh.readState();
  withUserToken.tokens.ghp_userexported0000 = { login: "octo-admin", scopes: ["repo", "read:org", "workflow"], expires: FAR_EXPIRY, expired: false };
  gh.setState(withUserToken);
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN"]) {
    const report = jsonReport({ [name]: "ghp_userexported0000" });
    assert.deepEqual([report.state, report.botLogin], ["healthy", BOT], `an exported ${name} is ignored for the bot's checks`);
  }
  // When your own sign-in or the branch protection cannot be read, the result is not confirmed:
  // never healthy, and doctor hints with the fix.
  start({ failure: "user-unauthorized" });
  let partial = jsonReport();
  assert.ok(partial.problems.some((item) => item.id === "account-unchecked" && item.severity === "unchecked"), "an unread user account is reported");
  assert.ok(partial.problems.some((item) => item.id === "protection-unchecked" && item.severity === "unchecked"), "unread branch protection is reported");
  assert.equal(partial.state, "unavailable", "a result with checks that could not run is not healthy");
  expectLine(1, /not fully checked: Your own GitHub sign-in could not be read.* — run gh auth status/);
  const partialStatus = node("scripts/cli/main.mjs", ["github", "status"]);
  assert.equal(partialStatus.status, 0, "an unconfirmed result is not a problem exit");
  assert.match(partialStatus.stdout, /could not be fully checked for example\/project:\n {2}Not checked: Your own GitHub sign-in/);
  // A problem already found survives a later read failing.
  start({ enabled: false, failure: "repo-forbidden" });
  partial = jsonReport();
  assert.equal(partial.state, "problem", "a known problem keeps the state a problem");
  assert.ok(partial.problems.some((item) => item.id === "package-off"));
  assert.ok(partial.problems.some((item) => item.id === "check-incomplete" && /could not run/.test(item.message)));
  // With no problem known, the same failed read leaves the result unconfirmed.
  start({ failure: "repo-forbidden" });
  partial = jsonReport();
  assert.equal(partial.state, "unavailable", "a failed read with nothing else wrong is not healthy");
  assert.match(partial.reason, /Resource not accessible/);
  console.log("✓ Status ignores exported tokens, flags any extra scope or a fine-grained token, and reports checks it could not run.");
  start({ rulesets: [] });
  expectLine(1, /Branch protection for this repo is missing.* — run roborepo protect in this repo/);
  // Protection that exists but falls short is a problem too, and each one's hint names roborepo protect.
  const withManaged = (edit) => {
    const rulesets = structuredClone(managed);
    edit(rulesets, (name) => rulesets.find((ruleset) => ruleset.name === name));
    return rulesets;
  };
  const protectionCases = [
    ["the merge ruleset does not require approval of the last push", withManaged((_, named) => {
      const pullRequest = named("roborepo-main-merge").rules.find((rule) => rule.type === "pull_request");
      pullRequest.parameters.require_last_push_approval = false;
    }), /Branch protection for this repo is drifted/],
    ["repo-plans is unprotected", withManaged((rulesets) => {
      rulesets.splice(rulesets.findIndex((ruleset) => ruleset.name === "roborepo-plans"), 1);
    }), /Branch protection for this repo is missing/],
    ["the merge policy is skipped", withManaged((_, named) => {
      named("roborepo-main-merge").enforcement = "disabled";
    }), /The merge rule that requires approval of the last push is skipped for this repo/],
  ];
  for (const [label, rulesets, message] of protectionCases) {
    start({ rulesets });
    const result = line();
    assert.equal(result.status, 1, `${label}: doctor hints\n${result.stdout}${result.stderr}`);
    assert.match(result.stdout, message, label);
    assert.match(result.stdout, /— run roborepo protect in this repo/, `${label}: the hint names roborepo protect`);
    const report = JSON.parse(node("scripts/cli/main.mjs", ["github", "status", "--json"]).stdout);
    assert.equal(report.state, "problem", label);
    assert.ok(report.problems.some((entry) => entry.id === "protection" && /roborepo protect/.test(entry.fix)), `${label}: status names roborepo protect`);
  }
  console.log("✓ Missing or weakened protection names roborepo protect for an admin.");

  // A repo someone else administers: you cannot see who may bypass the rules or invite the bot, so
  // the owner gets a message, and rules that apply are "unverified", never healthy.
  start({ admin: false });
  let foreign = jsonReport();
  assert.equal(foreign.state, "unverified", "rules you cannot fully see are not healthy");
  assert.equal(foreign.userAdmin, false);
  assert.ok(foreign.problems.some((entry) => entry.id === "protection-unverified" && entry.owner === true));
  assert.match(foreign.ownerMessage, /without a human approval/);
  assert.match(foreign.ownerMessage, /On the default branch: require a pull request/);
  assert.doesNotMatch(foreign.ownerMessage, /Invite robo-bot/, "a bot that can already push is not asked for again");
  expectLine(1, /cannot see who may bypass them\. — ask the repo's owner to confirm them/);
  const foreignStatus = node("scripts/cli/main.mjs", ["github", "status"]);
  assert.equal(foreignStatus.status, 0, "unverified rules are not a problem exit");
  assert.match(foreignStatus.stdout, /but the branch rules could not be verified:\n {2}Unverified: .*\n[\s\S]*Message for the repo's owner:\n {2}Hi!/);
  start({ admin: false, collaborators: [] });
  foreign = jsonReport();
  assert.equal(foreign.state, "problem");
  const notInvited = foreign.problems.find((entry) => entry.id === "not-collaborator");
  assert.ok(notInvited.owner && /you are not an admin there/.test(notInvited.message) && /Ask the repo's owner/.test(notInvited.fix));
  assert.match(foreign.ownerMessage, /1\. Invite robo-bot to example\/project as a collaborator with Write access/);
  // Rules an admin made by hand, as strict as RoboRepo's and visible to you, are as good as RoboRepo's.
  start({ rulesets: structuredClone(managed).map((ruleset) => ({ ...ruleset, name: ruleset.name.replace(/^roborepo-/, "team-") })) });
  assert.equal(jsonReport().state, "healthy", "hand-made rules an admin can see in full are not a problem");
  // The same rules from an organization ruleset: a repo admin still cannot read its bypass list.
  start({ rulesets: structuredClone(managed).map(({ bypass_actors, ...ruleset }) => ({ ...ruleset, name: ruleset.name.replace(/^roborepo-/, "org-"), source_type: "Organization", source: "example" })) });
  const orgRules = jsonReport();
  assert.equal(orgRules.state, "unverified", "rules whose bypass list nobody here can read are not healthy");
  assert.ok(orgRules.problems.some((entry) => entry.id === "protection-unverified" && /organization ruleset/.test(entry.message)));
  // Admin routes answer to the caller: the bot, with Write access, cannot create a ruleset.
  const botCreate = spawnSync("gh", ["api", "--method", "POST", "repos/example/project/rulesets", "--input", "-"], {
    cwd: checkout, env: { ...env, GH_CONFIG_DIR: ghDir }, input: JSON.stringify({ name: "x", target: "branch", enforcement: "active", rules: [] }), encoding: "utf8",
  });
  assert.notEqual(botCreate.status, 0, "a bot with Write access cannot create a ruleset");
  assert.match(botCreate.stderr, /HTTP 403/);
  console.log("✓ A repo you do not administer reads as unverified or names the owner, with a message for them.");

  start({ hosts: "keychain" });
  expectLine(1, /token is in the keychain, which agent sandboxes cannot read/);
  start({ failure: "unreachable" });
  expectLine(0, /^GitHub agent identity check skipped \(GitHub could not be reached\)$/);
  // A certificate the sandbox could not verify is named as such, never as a bad token.
  start({ failure: "tls" });
  const tlsReport = JSON.parse(node("scripts/cli/main.mjs", ["github", "status", "--json"]).stdout);
  assert.equal(tlsReport.state, "unavailable");
  assert.match(tlsReport.reason, /could not verify GitHub's certificate\. That is not a token problem.*outside the sandbox/);
  assert.ok(!tlsReport.problems.some((item) => /token/i.test(item.message)), "no token finding from a TLS failure");

  // A token close to expiry is advice: the status stays healthy and exits 0, doctor hints.
  // The warning starts two weeks out: 13 days left is a note, 15 is not.
  const inDays = (days) => new Date(Date.now() + days * 86_400_000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  start({ token: { expires: inDays(3) } });
  expectLine(1, /expires in 3 days/);
  let status = node("scripts/cli/main.mjs", ["github", "status"]);
  assert.equal(status.status, 0, status.stdout + status.stderr);
  assert.match(status.stdout, /healthy for example\/project: agents act as robo-bot\.\n {2}Note: .*expires in 3 days/);
  start({ token: { expires: inDays(13) } });
  expectLine(1, /expires in 13 days/);
  start({ token: { expires: inDays(15) } });
  expectLine(0, /^GitHub agent identity: agents act as robo-bot on example\/project$/);
  // A token with no expiry date works but gets a note naming the setup command.
  start({ token: { expires: null } });
  expectLine(1, /token never expires.* — regenerate it with an expiry date.*roborepo github setup/);
  const noExpiry = JSON.parse(node("scripts/cli/main.mjs", ["github", "status", "--json"]).stdout);
  assert.equal(noExpiry.state, "healthy", "a token without expiry is advice, not a problem");
  assert.ok(noExpiry.problems.some((item) => item.id === "no-expiry" && item.severity === "warn"));
  console.log("✓ Expiry notes start 14 days out, and a token without an expiry date gets a note.");
  // The CA bundle copy Codex's sandbox reads: missing or different from the system's is a warning.
  // A matching copy Git is not pointed at (setup stopped before writing gitconfig.local) is stale too.
  for (const ca of ["stale", "missing", "config-missing", "config-other"]) {
    start({ ca });
    const report = JSON.parse(node("scripts/cli/main.mjs", ["github", "status", "--json"]).stdout);
    const entry = report.problems.find((item) => item.id === "ca-bundle-stale");
    assert.ok(entry && entry.severity === "warn" && /roborepo github setup/.test(entry.fix), `${ca} copy is reported`);
    assert.equal(report.state, "healthy", "a stale copy is advice, not a problem");
  }
  start();
  assert.ok(!JSON.parse(node("scripts/cli/main.mjs", ["github", "status", "--json"]).stdout).problems.some((item) => item.id === "ca-bundle-stale"), "a matching copy is not reported");
  console.log("✓ ca-bundle-stale is reported when the copy is missing or differs, and not when it matches.");
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
