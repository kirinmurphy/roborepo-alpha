#!/usr/bin/env node
// Proves the repo-write-scope PreToolUse hook decides the write boundary correctly.
//
// The boundary is "the repository the session is working in", which cannot be expressed as a
// permission rule — Claude's rule paths are literal and no anchor resolves to the current
// repository — so it lives in a hook and is only checkable by running it.
//
// The case that motivates the whole thing is "sibling repository": two checkouts under one parent
// are indistinguishable to a path glob, so the old `~/projects/**` scope let an agent working in
// one write into the other without prompting. That case is the reason this file exists; the rest
// guard the edges around it.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hook = path.join(repoRoot, "globals/harnesses/claude/hooks/repo-write-scope.mjs");

// Real checkouts on disk: the hook finds a root by looking for `.git`, so a fixture needs one.
// `.git` is a directory in a normal checkout and a FILE in a linked worktree, and both must
// resolve to their own root — a worktree writing into its primary checkout is an outside-repo
// write, not an inside one.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-write-scope-"));
const repoA = path.join(tmp, "repo-a");
const repoB = path.join(tmp, "repo-b");
const worktree = path.join(tmp, "worktree-a");
fs.mkdirSync(path.join(repoA, "src"), { recursive: true });
fs.mkdirSync(repoB, { recursive: true });
fs.mkdirSync(worktree, { recursive: true });
fs.mkdirSync(path.join(repoA, ".git"), { recursive: true });
fs.mkdirSync(path.join(repoB, ".git"), { recursive: true });
fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${path.join(repoA, ".git/worktrees/wt")}\n`);

function decide(cwd, filePath, env = {}, toolName = "Write") {
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ cwd, tool_name: toolName, tool_input: { file_path: filePath } }),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  assert.equal(result.status, 0, `hook exited ${result.status}: ${result.stderr}`);
  if (!result.stdout.trim()) return "defer";
  return JSON.parse(result.stdout).hookSpecificOutput.permissionDecision;
}

// A REAL git repository with a REAL linked worktree, built with git itself. The family resolution
// reads `.git`, `commondir`, and `.git/worktrees/*/gitdir` directly rather than spawning git, so
// the fixture has to be genuine — hand-written pointer files would test the parser against this
// test's own assumptions about the format instead of against git's actual output.
const git = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
};

const realRepo = path.join(tmp, "real-repo");
fs.mkdirSync(realRepo, { recursive: true });
git(realRepo, "init", "-q", "-b", "main");
git(realRepo, "config", "user.email", "test@example.com");
git(realRepo, "config", "user.name", "Test");
fs.writeFileSync(path.join(realRepo, "README.md"), "x\n");
git(realRepo, "add", "README.md");
git(realRepo, "commit", "-qm", "init");

const realWorktree = path.join(tmp, "real-worktree");
git(realRepo, "worktree", "add", "-q", "-b", "feature", realWorktree);

const secondWorktree = path.join(tmp, "second-worktree");
git(realRepo, "worktree", "add", "-q", "-b", "other", secondWorktree);

const cases = [
  // [name, cwd, target, expected]
  ["file inside the repository", repoA, path.join(repoA, "index.js"), "allow"],
  ["nested file inside the repository", repoA, path.join(repoA, "src/deep/x.js"), "allow"],
  ["cwd in a subdirectory of the repository", path.join(repoA, "src"), path.join(repoA, "README.md"), "allow"],
  ["sibling repository under the same parent", repoA, path.join(repoB, "index.js"), "ask"],
  ["worktree writing inside itself", worktree, path.join(worktree, "a.md"), "allow"],
  ["worktree writing into its primary checkout", worktree, path.join(repoA, "a.md"), "ask"],
  // A repository under a scratch path is still a repository: cloning into /tmp to test something
  // is normal, and the boundary has to hold there too. This is why the hook resolves the
  // repository before consulting the scratch allowlist — the reverse order would return "allowed"
  // for every path in such a clone, including a write into the sibling clone beside it.
  ["repository living under a scratch path", repoA, path.join(repoA, "index.js"), "allow"],
  ["sibling clone under a scratch path", repoA, path.join(repoB, "x.js"), "ask"],
  // True scratch space, outside any checkout: correct to write whichever repository is in use, and
  // the static rules already allow it, so the hook defers instead of prompting on top of an allow.
  ["scratch file outside any repository", repoA, path.join(os.tmpdir(), "roborepo-scratch-probe.log"), "defer"],
  // No repository to be inside of: the hook has no basis for an opinion and must not invent one.
  ["session not in any repository", os.homedir(), path.join(os.homedir(), "notes.md"), "defer"],
];

// Reads span the repository FAMILY; writes stay bounded to the checkout in use. This asymmetry is
// the point of the feature: reading main from a worktree to compare against a branch is routine,
// while writing into main from a worktree is how one session clobbers another's in-flight work.
const familyCases = [
  // [name, cwd, target, tool, expected]
  ["read: worktree reading its primary checkout", realWorktree, path.join(realRepo, "README.md"), "Read", "allow"],
  ["read: worktree reading a sibling worktree", realWorktree, path.join(secondWorktree, "README.md"), "Read", "allow"],
  ["read: primary reading one of its worktrees", realRepo, path.join(realWorktree, "README.md"), "Read", "allow"],
  ["read: inside the worktree itself", realWorktree, path.join(realWorktree, "a.md"), "Read", "allow"],
  // The family is one project, not "any repository": an unrelated checkout is still outside.
  ["read: unrelated repository", realWorktree, path.join(repoB, "index.js"), "Read", "ask"],
  // Writes are unchanged by the family logic.
  ["write: worktree writing its primary checkout", realWorktree, path.join(realRepo, "README.md"), "Write", "ask"],
  ["write: worktree writing a sibling worktree", realWorktree, path.join(secondWorktree, "x.md"), "Write", "ask"],
  ["write: inside the worktree itself", realWorktree, path.join(realWorktree, "a.md"), "Write", "allow"],
  ["edit: worktree editing its primary checkout", realWorktree, path.join(realRepo, "README.md"), "Edit", "ask"],
];

try {
  for (const [name, cwd, target, expected] of cases) {
    const actual = decide(cwd, target);
    assert.equal(actual, expected, `${name}: expected ${expected}, got ${actual}`);
  }

  for (const [name, cwd, target, tool, expected] of familyCases) {
    const actual = decide(cwd, target, {}, tool);
    assert.equal(actual, expected, `${name}: expected ${expected}, got ${actual}`);
  }

  // An absent tool_name must fall back to the narrower WRITE zone. Widening on missing input would
  // hand out family-scoped access on exactly the malformed payloads the hook cannot interpret.
  const noToolName = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ cwd: realWorktree, tool_input: { file_path: path.join(realRepo, "README.md") } }),
    encoding: "utf8",
  });
  assert.equal(
    JSON.parse(noToolName.stdout).hookSpecificOutput.permissionDecision,
    "ask",
    "missing tool_name must use the write boundary, not the wider read family",
  );

  // The platform/provider seam: the outside-the-repo decision belongs to the manifest behavior
  // `repo-write-boundary`, layered with personal overrides, and this hook only enforces whatever it
  // is handed. A hook that hardcoded its own bucket would make the portal's control a lie.
  //
  // The target has to be outside the repository AND outside scratch space to reach this path, so
  // it uses a home-relative path that is never written — only classified.
  const outsideEverything = path.join(os.homedir(), "roborepo-write-scope-probe.txt");
  const stateDir = path.join(tmp, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const setOverride = (bucket) =>
    fs.writeFileSync(
      path.join(stateDir, "command-overrides.json"),
      JSON.stringify({ behaviors: { "repo-write-boundary": bucket }, commands: {} }),
    );

  assert.equal(
    decide(repoA, outsideEverything),
    "ask",
    "outside-repo write should use the manifest's default bucket for repo-write-boundary",
  );

  setOverride("deny");
  assert.equal(
    decide(repoA, outsideEverything, { ROBOREPO_STATE_DIR: stateDir }),
    "deny",
    "a personal override on repo-write-boundary should change the outside-repo decision",
  );

  // "allow" means the boundary is switched off. The hook must then say nothing rather than emit an
  // allow, which would out-rank the static rules it is meant to defer to.
  setOverride("allow");
  assert.equal(
    decide(repoA, outsideEverything, { ROBOREPO_STATE_DIR: stateDir }),
    "defer",
    "setting repo-write-boundary to allow should disable the hook's decision entirely",
  );

  // Malformed input must never block a write. A hook that cannot parse its input has no basis for
  // a decision, and failing closed here would break writing on an unanticipated payload shape.
  for (const payload of ["not json", "", "{}", '{"tool_input":{}}']) {
    const result = spawnSync(process.execPath, [hook], { input: payload, encoding: "utf8" });
    assert.equal(result.status, 0, `hook exited ${result.status} on ${JSON.stringify(payload)}`);
    assert.equal(result.stdout.trim(), "", `hook decided on malformed input ${JSON.stringify(payload)}`);
  }

  // The hook runs on every Write and Edit, so its cost is paid constantly — and that cost is
  // dominated by Node process startup (~290ms measured bare), not by anything this hook computes.
  // Resolving the root by walking for `.git` in-process is ~0.09ms, against ~155ms to spawn
  // `git rev-parse`; the walk is why the hook's own share is negligible.
  //
  // The bound here is a regression guard on the hook's own work, not a latency budget for the
  // feature. It catches a change that starts spawning subprocesses or scanning a tree; it cannot
  // catch the startup cost, which is inherent to command hooks and shared with every other one.
  const started = Date.now();
  for (let i = 0; i < 20; i++) decide(repoA, path.join(repoA, "index.js"));
  const perCall = (Date.now() - started) / 20;
  assert.ok(
    perCall < 900,
    `hook averaged ${perCall.toFixed(0)}ms per call including node startup — investigate whether `
      + "the hook itself started doing expensive work",
  );

  console.log("repo-write-scope-check passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
