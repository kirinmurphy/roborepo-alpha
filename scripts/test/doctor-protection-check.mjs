#!/usr/bin/env node
// Doctor's branch protection line against a fake `gh`: the line for each state, that a hint never
// turns doctor red, and that ROBOREPO_SKIP_PROTECTION_CHECK=1 keeps doctor off GitHub entirely.

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
const root = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-doctor-protection-"));
isolateGitConfig(root);

const MAIN = { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } };
const ruleset = (id, name, conditions, rules, extra = {}) => ({
  id, name, target: "branch", source_type: "Repository", source: "example/project", enforcement: "active",
  bypass_actors: [], conditions, rules, ...extra,
});

try {
  const gh = createFakeGh(root);
  const checkout = clone("checkout", "git@github.com:example/project.git");
  const env = { ...process.env, ...gh.env, PATH: `${gh.dir}${path.delimiter}${process.env.PATH}`, ROBOREPO_SKIP_NODE_RELEASE_CHECK: "1", ROBOREPO_SKIP_AGENT_IDENTITY_CHECK: "1" };
  delete env.ROBOREPO_SKIP_PROTECTION_CHECK;
  const line = (cwd = checkout) => spawnSync(process.execPath, [path.join(repoRoot, "scripts/cli/protect.mjs"), "--doctor"], { cwd, env, encoding: "utf8" });
  const doctor = (extraEnv = {}) => spawnSync("bash", [path.join(repoRoot, "scripts/doctor.sh"), "--verbose"], { cwd: checkout, env: { ...env, ...extraEnv }, encoding: "utf8" });
  const start = (overrides) => {
    gh.setState(fakeGitHubState(overrides));
    gh.clearCalls();
  };
  const expectLine = (status, pattern) => {
    const result = line();
    assert.equal(result.status, status, result.stdout + result.stderr);
    assert.match(result.stdout, pattern);
    assert.equal(result.stdout.trim().split("\n").length, 1, "doctor gets exactly one line");
  };

  start();
  expectLine(1, /^branch protection is incomplete for example\/project — run: roborepo protect$/m);
  start({ admin: false, login: "octo-reader" });
  expectLine(1, /incomplete for example\/project — a repo admin must run: roborepo protect \(signed in as octo-reader\)/);

  // Let the real command protect the fake repo, then read the remaining states from that.
  start();
  const protectedRun = spawnSync(process.execPath, [path.join(repoRoot, "scripts/cli/main.mjs"), "protect"], { cwd: checkout, env, encoding: "utf8" });
  assert.equal(protectedRun.status, 0, protectedRun.stdout + protectedRun.stderr);
  const managed = gh.readState().rulesets;
  expectLine(0, /^branch protection matches the RoboRepo policy for example\/project$/m);

  const skipped = structuredClone(managed);
  skipped.find((entry) => entry.name === "roborepo-main-merge").enforcement = "disabled";
  start({ rulesets: skipped });
  expectLine(0, /matches the RoboRepo policy for example\/project; merge rules are skipped for this repo/);

  const drifted = structuredClone(managed);
  drifted.find((entry) => entry.name === "roborepo-main-merge").rules[1].parameters.required_status_checks.push({ context: "retired-job" });
  start({ rulesets: drifted });
  expectLine(1, /has drifted from the RoboRepo policy for example\/project — run: roborepo protect/);
  start({ rulesets: drifted, admin: false, login: "octo-reader" });
  expectLine(1, /has drifted .* a repo admin must run: roborepo protect \(signed in as octo-reader\)/);

  start({ rulesets: managed.map((entry) => ({ ...entry, id: entry.id - 8000, name: entry.name.replace("roborepo-", "hand-") })) });
  expectLine(0, /example\/project branches are protected by hand-made rulesets \(hand-plans, hand-main-integrity, hand-main-merge\); roborepo protect would manage them/);

  start({ rulesets: [...structuredClone(managed), ruleset(40, "sign-everything", { ref_name: { include: ["~ALL"], exclude: [] } }, [{ type: "required_signatures" }])] });
  expectLine(1, /rule required_signatures from ruleset sign-everything will refuse plan saves in example\/project — exclude the plans branch from that ruleset/);
  start({ rulesets: structuredClone(managed), classicProtection: { "repo-plans": { lock_branch: { enabled: true } } } });
  expectLine(1, /branch protection setting lock_branch on the plans branch will refuse plan saves in example\/project — turn it off in the repo's branch protection settings/);

  start({ failure: "not-signed-in" });
  expectLine(0, /branch protection check skipped \(the GitHub CLI is not signed in \(run: gh auth login\)\)/);
  start({ failure: "rulesets-refused" });
  expectLine(1, /RoboRepo cannot manage branch protection for example\/project \(GitHub does not offer rulesets for this repo: .*\) — run roborepo protect --check for the manual steps/);
  console.log("✓ Each protection state maps to its doctor line: ok when nothing needs doing, a hint otherwise.");

  // A ruleset GitHub returns in a shape the reader cannot handle is a crash, not a hint: one line
  // with no stack trace and exit 3, which doctor reports as a failure.
  start({ rulesets: [ruleset(1, "roborepo-plans", MAIN, "x")] });
  const crashed = line();
  assert.equal(crashed.status, 3, crashed.stdout + crashed.stderr);
  assert.equal(crashed.stdout.trim().split("\n").length, 1, crashed.stdout);
  assert.doesNotMatch(crashed.stdout + crashed.stderr, /^\s+at /m);
  const crashedDoctor = doctor();
  assert.notEqual(crashedDoctor.status, 0, crashedDoctor.stdout + crashedDoctor.stderr);
  assert.match(crashedDoctor.stderr, /^fail: branch protection check crashed: /m);
  assert.doesNotMatch(crashedDoctor.stderr, /^\s+at /m);
  console.log("✓ An unexpected error exits 3 with one line, and doctor reports it as crashed.");

  // Outside a Git repo with a GitHub origin, doctor adds no line and gh is never called.
  start();
  for (const cwd of [clone("gitlab-clone", "git@gitlab.com:example/project.git"), fs.mkdtempSync(path.join(root, "not-a-repo-"))]) {
    const result = line(cwd);
    assert.deepEqual([result.status, result.stdout], [0, ""]);
  }
  assert.deepEqual(gh.calls(), []);
  console.log("✓ A repo on another host, or no repo, adds no line.");

  // Through doctor itself: a hint is printed and doctor still passes; the skip stays off GitHub.
  start({ rulesets: [ruleset(41, "protect-main", MAIN, [{ type: "deletion" }])] });
  let result = doctor();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^hint: branch protection is incomplete for example\/project — run: roborepo protect$/m);
  assert.ok(gh.calls().length > 0);
  gh.clearCalls();
  result = doctor({ ROBOREPO_SKIP_PROTECTION_CHECK: "1" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^ok: branch protection check skipped \(ROBOREPO_SKIP_PROTECTION_CHECK=1\)$/m);
  assert.deepEqual(gh.calls(), [], "the skip variable makes no gh call");
  console.log("✓ doctor prints the hint without failing, and ROBOREPO_SKIP_PROTECTION_CHECK=1 makes no gh call.");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function clone(name, origin) {
  const dir = path.join(root, name);
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "-q", "-b", "main", dir);
  git("-C", dir, "remote", "add", "origin", origin);
  return dir;
}
