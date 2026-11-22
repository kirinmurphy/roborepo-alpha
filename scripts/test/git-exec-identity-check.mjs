// runGitProcess drops GIT_CONFIG_* env by default; `keepAgentGitConfig` keeps only the numbered
// pairs, and the wrapper's own hooksPath override still wins over a pair that sets it.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runGitProcess, runGitProcessSync } from "../../modules/repositories/git-exec.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-git-identity-"));
const home = path.join(root, "home");
fs.mkdirSync(home);
const saved = { ...process.env };

try {
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  process.env.HOME = home;
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  runGitProcessSync(repo, ["init", "-q"]);

  process.env.GIT_CONFIG_COUNT = "2";
  process.env.GIT_CONFIG_KEY_0 = "core.hooksPath";
  process.env.GIT_CONFIG_VALUE_0 = path.join(root, "agent-hooks");
  process.env.GIT_CONFIG_KEY_1 = "roborepo.test";
  process.env.GIT_CONFIG_VALUE_1 = "1";

  const get = (key, options) => runGitProcess(repo, ["config", "--get", key], options);
  const getSync = (key, options) => runGitProcessSync(repo, ["config", "--get", key], options);

  const dropped = await get("roborepo.test");
  assert.equal(dropped.ok, false, "the default strips the GIT_CONFIG_* pairs");
  assert.equal(getSync("roborepo.test").ok, false, "the sync default strips the pairs");

  const kept = await get("roborepo.test", { keepAgentGitConfig: true });
  assert.equal(kept.stdout.trim(), "1", "the option keeps the pairs");
  assert.equal(getSync("roborepo.test", { keepAgentGitConfig: true }).stdout.trim(), "1");

  assert.equal((await get("core.hooksPath")).stdout.trim(), "/dev/null");
  assert.equal((await get("core.hooksPath", { keepAgentGitConfig: true })).stdout.trim(), "/dev/null", "-c core.hooksPath=/dev/null outranks the env pair");
  assert.equal(getSync("core.hooksPath", { keepAgentGitConfig: true }).stdout.trim(), "/dev/null");

  // GIT_CONFIG_PARAMETERS stays stripped even with the option.
  process.env.GIT_CONFIG_PARAMETERS = "'roborepo.params'='1'";
  assert.equal((await get("roborepo.params", { keepAgentGitConfig: true })).ok, false);

  console.log("git-exec identity check passed");
} finally {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  fs.rmSync(root, { recursive: true, force: true });
}
