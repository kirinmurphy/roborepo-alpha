#!/usr/bin/env node
// Runs the fast pre-push check (scripts/test/pre-push-check.sh) against a throwaway clone and a
// scratch remote whose default branch is not main. The script cds to its own repo root, so a copy of
// it sits in the clone beside stubs of the two checks it runs, which have their own tests.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-pre-push-gate-")));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

const ZERO = "0".repeat(40);
const UNKNOWN = "1234567890".repeat(4);
const DEFAULT_BRANCH = "trunk";
const SKIPPED = "skipped git diff --check";

// Hermetic git: an agent shell injects its own core.hooksPath through GIT_CONFIG_*, and a hook
// running this test would export GIT_DIR.
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: path.join(tmp, "gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
};
for (const key of Object.keys(env)) {
  if (/^GIT_CONFIG_(?:COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)$/.test(key) || /^GIT_(?:DIR|WORK_TREE|INDEX_FILE|PAGER)$/.test(key)) delete env[key];
}
fs.writeFileSync(env.GIT_CONFIG_GLOBAL, "");

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

const remote = path.join(tmp, "remote.git");
const work = path.join(tmp, "work");
git(tmp, "init", "-q", "--bare", `--initial-branch=${DEFAULT_BRANCH}`, remote);
git(tmp, "init", "-q", `--initial-branch=${DEFAULT_BRANCH}`, work);
git(work, "remote", "add", "origin", remote);

const doctorRan = path.join(tmp, "doctor-ran");
fs.mkdirSync(path.join(work, "scripts/test"), { recursive: true });
fs.copyFileSync(path.join(repoRoot, "scripts/test/pre-push-check.sh"), path.join(work, "scripts/test/pre-push-check.sh"));
fs.writeFileSync(path.join(work, "scripts/doctor.sh"), `echo "\${ROBOREPO_SKIP_NODE_RELEASE_CHECK:-unset}" > "${doctorRan}"\nexit "\${STUB_DOCTOR_EXIT:-0}"\n`);
fs.writeFileSync(path.join(work, "scripts/test/docs-reference-check.mjs"), "process.exit(Number(process.env.STUB_DOCS_EXIT || 0));\n");

function commit(file, content, message = file) {
  fs.writeFileSync(path.join(work, file), content);
  git(work, "add", "-A");
  git(work, "commit", "-qm", message);
  return git(work, "rev-parse", "HEAD");
}

function branch(name, from = DEFAULT_BRANCH) {
  git(work, "switch", "-qc", name, from);
}

function prePush({ remoteName = "origin", url = remote, local, remoteSha = ZERO, ref = "refs/heads/topic", extraEnv = {} }) {
  return spawnSync("bash", [path.join(work, "scripts/test/pre-push-check.sh"), remoteName, url], {
    cwd: tmp,
    env: { ...env, ...extraEnv },
    encoding: "utf8",
    input: `${ref} ${local} ${ref} ${remoteSha}\n`,
  });
}

function assertPasses(result, label) {
  assert.equal(result.status, 0, `${label}: ${result.stderr}`);
  assert.ok(!result.stderr.includes(SKIPPED), `${label}: the diff check ran instead of skipping: ${result.stderr}`);
}

// The failure line names the base it diffed from, which is how these prove the default was resolved.
function assertRefusedFrom(result, base, label) {
  assert.equal(result.status, 1, `${label}: ${result.stderr}`);
  assert.ok(result.stderr.includes("pre-push: push refused"), `${label}: ${result.stderr}`);
  assert.ok(result.stderr.includes(`git diff --check ${base.slice(0, 12)}..`), `${label}: expected a diff from ${base}: ${result.stderr}`);
}

// A whitespace error already on the default branch sits behind every merge base below, so a check
// that diffed from anywhere earlier would refuse the clean branches too.
commit("legacy.txt", "already published   \n", "legacy whitespace");
const base = commit("base.txt", "base\n");
git(work, "push", "-q", "--no-verify", "origin", DEFAULT_BRANCH);
git(work, "fetch", "-q", "origin");

branch("clean");
const clean = commit("clean.txt", "clean\n");
branch("dirty", DEFAULT_BRANCH);
const dirty = commit("dirty.txt", "trailing space \n");

// The default branch moves on, so the merge base is not its tip.
git(work, "switch", "-q", DEFAULT_BRANCH);
commit("later.txt", "later\n");
git(work, "push", "-q", "--no-verify", "origin", DEFAULT_BRANCH);
git(work, "fetch", "-q", "origin");

// New branch, default branch recorded locally.
git(work, "remote", "set-head", "origin", DEFAULT_BRANCH);
assert.equal(git(work, "symbolic-ref", "refs/remotes/origin/HEAD"), `refs/remotes/origin/${DEFAULT_BRANCH}`);
assertPasses(prePush({ local: clean }), "new clean branch, recorded HEAD");
assertRefusedFrom(prePush({ local: dirty }), base, "new branch with a whitespace error, recorded HEAD");

// The two checks that read the working tree run, off the network, and refuse the push by name.
assert.equal(fs.readFileSync(doctorRan, "utf8").trim(), "1", "doctor runs with the Node release lookup off");
const doctorFailed = prePush({ local: clean, extraEnv: { STUB_DOCTOR_EXIT: "1" } });
assert.equal(doctorFailed.status, 1, "a failing doctor refuses the push");
assert.match(doctorFailed.stderr, /Failed:\n\s+bash scripts\/doctor\.sh --quiet/);
const docsFailed = prePush({ local: clean, extraEnv: { STUB_DOCS_EXIT: "1" } });
assert.equal(docsFailed.status, 1, "a failing docs check refuses the push");
assert.match(docsFailed.stderr, /Failed:\n\s+node scripts\/test\/docs-reference-check\.mjs/);

// A deleted branch pushes no commits, so there is nothing to diff.
assertPasses(prePush({ local: ZERO, remoteSha: dirty }), "branch deletion");

// New branch, no recorded HEAD: the remote says which branch is its default. Git can record the HEAD
// on a fetch, so it is removed explicitly and that is checked.
git(work, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
const recorded = spawnSync("git", ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], { cwd: work, env });
assert.notEqual(recorded.status, 0, "precondition: refs/remotes/origin/HEAD is not recorded");
assert.equal(spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"], { cwd: work, env }).status, 1, "precondition: the remote has no main");
assertPasses(prePush({ local: clean }), "new clean branch, default from ls-remote");
assertRefusedFrom(prePush({ local: dirty }), base, "new branch with a whitespace error, default from ls-remote");

// A remote tip this clone lacks (someone else pushed to the branch): diff from the merge base.
assertPasses(prePush({ local: clean, remoteSha: UNKNOWN }), "clean branch, remote tip unknown here");
assertRefusedFrom(prePush({ local: dirty, remoteSha: UNKNOWN }), base, "whitespace error, remote tip unknown here");

// A known remote tip: only the new commits count, so an error already pushed does not refuse.
assertPasses(prePush({ local: dirty, remoteSha: dirty }), "known remote tip, nothing new");
git(work, "switch", "-q", "dirty");
const onTopOfDirty = commit("fixed-forward.txt", "clean\n");
assertPasses(prePush({ local: onTopOfDirty, remoteSha: dirty }), "known remote tip, clean new commit over an old error");
const dirtyAgain = commit("dirty-again.txt", "trailing space \n");
assertRefusedFrom(prePush({ local: dirtyAgain, remoteSha: onTopOfDirty }), onTopOfDirty, "known remote tip, whitespace error in the new commit");

// No recorded HEAD and a remote that cannot be reached: warn, and leave the check to CI.
const unreachable = prePush({ local: dirty, url: path.join(tmp, "no-such-remote.git") });
assert.equal(unreachable.status, 0, `unreachable remote does not refuse: ${unreachable.stderr}`);
assert.ok(unreachable.stderr.includes(`${SKIPPED} for refs/heads/topic`), `unreachable remote warns: ${unreachable.stderr}`);

// Git pages a diff to a terminal, and a LESS without -F holds the push at an empty pager until
// someone presses q. Git only pages when stdout is a terminal, so this needs a pseudo-terminal, and
// the pager is a stub that records being opened rather than a real less that would hang the test.
const pagerRan = path.join(tmp, "pager-ran");
const pager = path.join(tmp, "pager.sh");
fs.writeFileSync(pager, `#!/bin/sh\necho opened >> "${pagerRan}"\ncat >/dev/null\n`, { mode: 0o755 });
const pagerEnv = { ...env, LESS: "-R", PAGER: pager };

function underTerminal(command) {
  const args = process.platform === "darwin" ? ["-q", "/dev/null", "bash", "-c", command] : ["-qec", `bash -c '${command}'`, "/dev/null"];
  return spawnSync("script", args, { cwd: work, env: pagerEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
}

if (spawnSync("script", ["-q", "/dev/null", "true"], { stdio: "ignore" }).error) {
  console.log("skip: no script command, so the pager case did not run");
} else {
  // The control: under this terminal, a plain git diff does open the pager.
  const control = underTerminal(`git diff --check ${base} ${dirty}`);
  assert.notEqual(control.signal, "SIGTERM", "the terminal control finished");
  assert.ok(fs.existsSync(pagerRan), `a plain git diff opens the pager under the terminal: ${control.stdout}${control.stderr}`);
  fs.rmSync(pagerRan);

  const refs = path.join(tmp, "refs.txt");
  fs.writeFileSync(refs, `refs/heads/topic ${dirty} refs/heads/topic ${ZERO}\n`);
  const check = underTerminal(`bash scripts/test/pre-push-check.sh origin ${remote} < ${refs}`);
  assert.notEqual(check.signal, "SIGTERM", "the check finished under a terminal");
  assert.match(check.stdout, /push refused/, `the check reached its diff under the terminal: ${check.stdout}${check.stderr}`);
  assert.ok(!fs.existsSync(pagerRan), "the check does not open a pager");
}

console.log("ok: pre-push check resolves its diff base, refuses bad pushes, and never pages");
