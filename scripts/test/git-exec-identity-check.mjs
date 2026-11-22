// runGitProcess drops GIT_CONFIG_* env by default. `keepAgentGitConfig` keeps only the pairs RoboRepo
// renders into agent shells (core.hooksPath, and include.path naming the agent identity's gitconfig),
// renumbered; the wrapper's own hooksPath override still wins over a pair that sets it.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runGitProcess, runGitProcessSync } from "../../modules/repositories/git-exec.mjs";

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

  // GIT_CONFIG_PARAMETERS stays stripped even with the option.
  process.env.GIT_CONFIG_PARAMETERS = "'roborepo.params'='1'";
  assert.equal((await get("roborepo.params", keep)).ok, false);

  console.log("git-exec identity check passed");
} finally {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  fs.rmSync(root, { recursive: true, force: true });
}
