// runGitProcess drops GIT_CONFIG_* env by default. `keepAgentGitConfig` keeps only the pairs RoboRepo
// renders into agent shells (core.hooksPath, and include.path naming the agent identity's gitconfig),
// renumbered; the wrapper's own hooksPath override still wins over a pair that sets it.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentGitConfigPaths, runGitProcess, runGitProcessSync } from "../../modules/repositories/git-exec.mjs";
import { githubProvider } from "../../modules/forge/providers/github/index.mjs";
import { fakeManifest, fakeProvider } from "./fixtures/forge-fake-provider/index.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-git-identity-"));
const home = path.join(root, "home");
fs.mkdirSync(home);
const saved = { ...process.env };

const AGENT_GITCONFIG = path.join("package-runtime", "github-agent-identity", "gitconfig");

function setPairs(pairs) {
  for (const key of Object.keys(process.env)) {
    if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) delete process.env[key];
  }
  process.env.GIT_CONFIG_COUNT = String(pairs.length);
  pairs.forEach(([key, value], i) => {
    process.env[`GIT_CONFIG_KEY_${i}`] = key;
    process.env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
}

try {
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  process.env.HOME = home;
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  const stateRoot = path.join(root, "state");
  process.env.ROBOREPO_STATE_ROOT = stateRoot;
  runGitProcessSync(repo, ["init", "-q"]);

  // The identity's gitconfig, at the rendered `~/.roborepo/...` path and under the state root.
  for (const base of [path.join(home, ".roborepo"), stateRoot]) {
    fs.mkdirSync(path.join(base, path.dirname(AGENT_GITCONFIG)), { recursive: true });
    fs.writeFileSync(path.join(base, AGENT_GITCONFIG), "[roborepo]\n\tincluded = 1\n");
  }
  const otherInclude = path.join(root, "other.gitconfig");
  fs.writeFileSync(otherInclude, "[roborepo]\n\tother = 1\n");

  const get = (key, options) => runGitProcess(repo, ["config", "--get", key], options);
  const getSync = (key, options) => runGitProcessSync(repo, ["config", "--get", key], options);
  const keep = { keepAgentGitConfig: true };

  // An unrecognized pair sits between the allowed ones, so the kept pairs must be renumbered.
  setPairs([
    ["core.sshCommand", "ssh -i /tmp/key"],
    ["core.hooksPath", path.join(root, "agent-hooks")],
    ["credential.helper", "store"],
    ["include.path", "~/.roborepo/package-runtime/github-agent-identity/gitconfig"],
    ["include.path", otherInclude],
    ["roborepo.test", "1"],
  ]);

  assert.equal((await get("roborepo.included")).ok, false, "the default strips the GIT_CONFIG_* pairs");
  assert.equal(getSync("roborepo.included").ok, false, "the sync default strips the pairs");

  assert.equal((await get("roborepo.included", keep)).stdout.trim(), "1", "the rendered include.path pair survives");
  assert.equal(getSync("roborepo.included", keep).stdout.trim(), "1");
  assert.equal((await get("core.sshCommand", keep)).ok, false, "a core.sshCommand pair is dropped even with the option");
  assert.equal((await get("credential.helper", keep)).ok, false, "a credential.helper pair is dropped even with the option");
  assert.equal(getSync("credential.helper", keep).ok, false);
  assert.equal((await get("roborepo.other", keep)).ok, false, "include.path naming another file is dropped");
  assert.equal((await get("roborepo.test", keep)).ok, false, "any other pair is dropped");

  // core.hooksPath survives as a pair, but the wrapper's `-c core.hooksPath=/dev/null` outranks it.
  assert.equal((await get("core.hooksPath")).stdout.trim(), "/dev/null");
  assert.equal((await get("core.hooksPath", keep)).stdout.trim(), "/dev/null", "-c core.hooksPath=/dev/null outranks the env pair");
  assert.equal(getSync("core.hooksPath", keep).stdout.trim(), "/dev/null");
  const origins = (await runGitProcess(repo, ["config", "--show-origin", "--get-all", "core.hooksPath"], keep)).stdout;
  assert.match(origins, /agent-hooks/, "the core.hooksPath pair is kept");

  // The include.path pair expanded under the state root is accepted too.
  setPairs([["include.path", path.join(stateRoot, AGENT_GITCONFIG)]]);
  assert.equal((await get("roborepo.included", keep)).stdout.trim(), "1", "the expanded state-root path is accepted");
  // A relative state root names the same absolute file the CLI renders.
  process.env.ROBOREPO_STATE_ROOT = path.relative(process.cwd(), stateRoot);
  assert.equal((await get("roborepo.included", keep)).stdout.trim(), "1", "a relative state root still accepts the absolute include");
  process.env.ROBOREPO_STATE_ROOT = stateRoot;

  // An inherited count far past the pairs that exist must not stall the call before Git starts.
  process.env.GIT_CONFIG_COUNT = "999999999999";
  const started = Date.now();
  assert.equal((await get("roborepo.included", keep)).stdout.trim(), "1", "an oversized count still keeps the pair");
  assert.ok(Date.now() - started < 5000, "an oversized count is bounded by the pairs that exist");
  setPairs([["include.path", path.join(stateRoot, AGENT_GITCONFIG)]]);

  // GIT_CONFIG_PARAMETERS stays stripped even with the option, except the settings a sandbox sets
  // so Git can use its proxy (as the Claude sandbox does), in either quoting form Git writes.
  process.env.GIT_CONFIG_PARAMETERS = "'roborepo.params'='1'";
  assert.equal((await get("roborepo.params", keep)).ok, false);
  process.env.GIT_CONFIG_PARAMETERS = [
    "'http.proxyAuthMethod=basic'",
    "'credential.http://127.0.0.1:52569.helper='",
    "'roborepo.params=1'",
    "'credential.helper=store'",
    "'http.https://example.com.proxy'='http://it'\\''s'",
  ].join(" ");
  assert.equal((await get("http.proxyAuthMethod")).ok, false, "the default strips the sandbox's proxy settings too");
  assert.equal((await get("http.proxyAuthMethod", keep)).stdout.trim(), "basic", "the sandbox's proxy auth method is kept");
  assert.equal(getSync("http.proxyAuthMethod", keep).stdout.trim(), "basic");
  assert.equal((await get("http.https://example.com.proxy", keep)).stdout.trim(), "http://it's", "a URL-scoped proxy with a quote survives");
  const helpers = (await runGitProcess(repo, ["config", "--get-regexp", "^credential\\."], keep)).stdout;
  assert.match(helpers, /^credential\.http:\/\/127\.0\.0\.1:52569\.helper ?$/m, "the empty helper reset for the proxy is kept");
  assert.doesNotMatch(helpers, /store/, "a credential helper is never added");
  assert.equal((await get("roborepo.params", keep)).ok, false, "any other parameter is dropped");
  // Git writes `!` as '\!' in the parameters it passes to child processes; read them from Git itself.
  const gitWritten = runGitProcessSync(repo, [
    "-c", "alias.params=!printenv GIT_CONFIG_PARAMETERS",
    "-c", "http.https://p.example.proxy=http://u!p@proxy",
    "params",
  ]).stdout.trim();
  assert.match(gitWritten, /\\!/, "Git escapes the exclamation mark");
  process.env.GIT_CONFIG_PARAMETERS = gitWritten;
  assert.equal((await get("http.https://p.example.proxy", keep)).stdout.trim(), "http://u!p@proxy", "a proxy with `!` survives");
  // A URL-scoped key whose subsection contains `=` keeps its whole name.
  process.env.GIT_CONFIG_PARAMETERS = "'http.https://a=b@p.example.proxy'='http://proxy'";
  assert.equal((await get("http.https://a=b@p.example.proxy", keep)).stdout.trim(), "http://proxy", "a key with `=` stays whole");
  process.env.GIT_CONFIG_PARAMETERS = "'http.proxyAuthMethod=basic' 'unterminated";
  assert.equal((await get("http.proxyAuthMethod", keep)).ok, false, "a malformed value keeps nothing");
  delete process.env.GIT_CONFIG_PARAMETERS;

  // The kept includes come from every forge provider with an agent account, not from GitHub alone.
  const withFake = agentGitConfigPaths({ manifests: [githubProvider.manifest, fakeProvider.manifest] });
  for (const id of ["github-agent-identity", fakeManifest.agent.packageId]) {
    assert.ok(withFake.has(`~/.roborepo/package-runtime/${id}/gitconfig`), `${id}'s rendered include is kept`);
    assert.ok(withFake.has(path.join(stateRoot, "package-runtime", id, "gitconfig")), `${id}'s include under the state root is kept`);
  }
  assert.ok(![...agentGitConfigPaths()].some((entry) => entry.includes(fakeManifest.agent.packageId)), "the shipped list has no fake provider");

  console.log("git-exec identity check passed");
} finally {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  fs.rmSync(root, { recursive: true, force: true });
}
