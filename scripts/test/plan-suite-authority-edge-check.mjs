#!/usr/bin/env node
// Edge cases around which copy of an active plan the Plans snapshot returns: how the repository
// was registered, a second clone that is not a worktree, an unreadable or duplicated copy in the
// assigned worktree, how refs are stored, and reftable repositories. Each case builds its own small
// repository with a primary checkout and one linked worktree named `wt`.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildPlanSnapshot, planSnapshotFingerprint } from "../../modules/plan-suite/index.mjs";
import { recordRepositoryDiscovery } from "../cli/repositories.mjs";

const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-plan-authority-edge-")));
const PLAN = "docs/plans/active/a.md";

function git(cwd, ...args) {
  const result = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=Test", ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function plan(id, { title = id, worktree = "" } = {}) {
  return `---\nid: ${id}\npriority: high\nnext_action: Do it\nworktree: ${worktree}\n---\n\n# ${title}\n`;
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// A primary checkout whose active plan `aaa111` is assigned to the linked worktree `wt`.
function repository(name, { refFormat } = {}) {
  const dir = path.join(tempRoot, name);
  const main = path.join(dir, "main");
  write(path.join(main, PLAN), plan("aaa111", { worktree: "wt" }));
  git(dir, "init", "-q", "-b", "main", ...(refFormat ? [`--ref-format=${refFormat}`] : []), main);
  git(main, "remote", "add", "origin", `https://github.com/example/${name}.git`);
  git(main, "add", ".");
  git(main, "commit", "-qm", "start");
  const wt = path.join(dir, "wt");
  git(main, "worktree", "add", "-q", "-b", "wt", wt);
  return { name, main, wt };
}

// Registers `roots` in order, so a test controls which checkout the registry knew first.
function register({ name }, roots) {
  const stateRoot = path.join(tempRoot, `state-${name}-${roots.length}-${Math.random().toString(36).slice(2)}`);
  roots.forEach((root, index) => recordRepositoryDiscovery({
    repositoryId: `git:github.com/example/${name}`, kind: "git", displayName: name, source: "developer-runtime",
    evidence: "git-remote", confidence: "high", localRoot: `root-${index}`, localRootKind: "clone", localRootPath: root, stateRoot,
  }));
  return stateRoot;
}

function scan(stateRoot) {
  const snapshot = buildPlanSnapshot({ stateRoot });
  return { snapshot, records: (id) => snapshot.plans.filter((record) => record.plan.id === id) };
}

const codes = (record) => record.plan.validation.findings.map((item) => item.code).filter((code) => /WORKTREE|AUTHORITY|DUPLICATE/.test(code));
const findingOf = (record, code) => record.plan.validation.findings.find((item) => item.code === code);

try {
  // ---- The primary checkout is found from Git, whichever root the registry knew first ----
  {
    const repo = repository("registered-worktree");
    write(path.join(repo.wt, PLAN), plan("aaa111", { title: "Progress in wt", worktree: "wt" }));
    for (const roots of [[repo.wt], [repo.wt, repo.main]]) {
      const [record, ...rest] = scan(register(repo, roots)).records("aaa111");
      assert.equal(rest.length, 0, `one record when the registry knows ${roots.length} root(s), worktree first`);
      assert.equal(record.plan.title, "Progress in wt", "the assigned worktree's copy wins even when the worktree was registered first");
      assert.deepEqual(record.plan.authority, { source: "worktree", worktree: "wt" });
      assert.deepEqual(codes(record), []);
    }
  }

  // ---- A second clone is never an assigned worktree, even under the worktree's name ----
  {
    const repo = repository("second-clone");
    const clone = path.join(tempRoot, "second-clone", "clones", "wt");
    git(tempRoot, "clone", "-q", repo.main, clone);
    write(path.join(clone, PLAN), plan("aaa111", { title: "Edited in the clone", worktree: "wt" }));
    write(path.join(clone, "docs/plans/backlog/c.md"), plan("ccc333", { title: "Only in the clone" }));
    git(repo.main, "worktree", "remove", "--force", repo.wt);
    const { records } = scan(register(repo, [repo.main, clone]));
    const [record] = records("aaa111");
    assert.equal(records("aaa111").length, 1);
    assert.equal(record.plan.title, "aaa111", "the clone's copy is not read in place of the missing worktree");
    assert.deepEqual(record.plan.authority, { source: "primary" });
    assert.equal(findingOf(record, "PLAN_WORKTREE_COPY_UNAVAILABLE")?.meta.reason, "worktree-missing");
    const [cloneOnly] = records("ccc333");
    assert.equal(cloneOnly.plan.checkout, "wt", "a plan found only in a second clone is labeled with the clone's directory");
    assert.equal(cloneOnly.plan.authority, null);
  }

  // ---- An unreadable copy in the assigned worktree falls back without failing the scan ----
  // Root reads a mode-000 file anyway, so the case cannot be staged there.
  if (process.getuid?.() !== 0) {
    const repo = repository("unreadable");
    const stateRoot = register(repo, [repo.main]);
    fs.chmodSync(path.join(repo.wt, PLAN), 0o000);
    try {
      const { snapshot, records } = scan(stateRoot);
      assert.equal(snapshot.repositoryScans[0].state, "scanned", "one unreadable plan file does not fail the repository's scan");
      const [record, ...rest] = records("aaa111");
      assert.equal(rest.length, 0, "the unreadable copy is not shown as a plan of its own");
      assert.deepEqual(record.plan.authority, { source: "primary" });
      assert.equal(record.plan.checkout, null);
      assert.equal(findingOf(record, "PLAN_WORKTREE_COPY_UNAVAILABLE")?.meta.reason, "copy-missing", "the fallback says the worktree has no readable copy");
      assert.deepEqual(snapshot.errors, [{ repository: "unreadable", checkout: "wt", path: PLAN, error: "could not be read" }], "the unreadable file is reported by its repository-relative path");
    } finally {
      fs.chmodSync(path.join(repo.wt, PLAN), 0o644);
    }
  }

  // ---- A duplicate id in the assigned worktree is reported, not resolved by file order ----
  {
    const repo = repository("duplicate");
    write(path.join(repo.wt, PLAN), plan("aaa111", { title: "Real progress", worktree: "wt" }));
    write(path.join(repo.wt, "docs/plans/active/0-stray.md"), plan("aaa111", { title: "Stray copy", worktree: "wt" }));
    const found = scan(register(repo, [repo.main])).records("aaa111");
    assert.deepEqual(found.map((record) => record.plan.title).sort(), ["Real progress", "Stray copy"], "both worktree copies are shown");
    for (const record of found) {
      assert.deepEqual(record.plan.authority, { source: "worktree", worktree: "wt" });
      assert.ok(codes(record).includes("DUPLICATE_PLAN_ID"), `${record.plan.title} carries DUPLICATE_PLAN_ID`);
    }
  }

  // ---- The fingerprint follows branch refs whether they are loose or packed ----
  {
    const repo = repository("packed");
    const stateRoot = register(repo, [repo.main]);
    write(path.join(repo.main, "README.md"), "readme\n");
    git(repo.main, "add", "README.md");
    git(repo.main, "commit", "-qm", "readme");
    git(repo.main, "pack-refs", "--all");
    assert.ok(!fs.existsSync(path.join(repo.main, ".git/refs/heads/wt")), "the worktree branch is packed");
    const packed = planSnapshotFingerprint({ stateRoot });
    git(repo.wt, "merge", "-q", "--no-edit", "main");
    const merged = planSnapshotFingerprint({ stateRoot });
    assert.notEqual(merged, packed, "merging main into a worktree whose branch was packed changes the fingerprint");
    git(repo.main, "pack-refs", "--all");
    assert.notEqual(planSnapshotFingerprint({ stateRoot }), merged, "packing the moved ref changes it too");
  }

  // ---- Reftable repositories: Git keeps HEAD and refs out of the plain files ----
  const reftable = spawnSync("git", ["init", "-q", "--ref-format=reftable", path.join(tempRoot, "probe-reftable")], { encoding: "utf8" });
  if (reftable.status === 0) {
    const repo = repository("reftable", { refFormat: "reftable" });
    const stateRoot = register(repo, [repo.main]);
    write(path.join(repo.wt, PLAN), plan("aaa111", { title: "Progress in wt", worktree: "wt" }));
    git(repo.wt, "commit", "-qam", "progress");
    let [record] = scan(stateRoot).records("aaa111");
    assert.equal(record.plan.title, "Progress in wt");
    assert.deepEqual(codes(record), [], "committed worktree progress is not an outside edit");

    write(path.join(repo.main, PLAN), plan("aaa111", { title: "Edited on main", worktree: "wt" }));
    [record] = scan(stateRoot).records("aaa111");
    assert.deepEqual(findingOf(record, "PLAN_EDITED_OUTSIDE_WORKTREE")?.meta, { worktree: "wt", committed: false }, "an outside edit is reported, not left unchecked");
    git(repo.main, "commit", "-qam", "edit on main");

    const beforeMerge = planSnapshotFingerprint({ stateRoot });
    write(path.join(repo.wt, "notes.txt"), "notes\n");
    git(repo.wt, "add", "notes.txt");
    git(repo.wt, "commit", "-qm", "notes");
    assert.notEqual(planSnapshotFingerprint({ stateRoot }), beforeMerge, "a commit in a reftable worktree changes the fingerprint");
    const beforeMainMerge = planSnapshotFingerprint({ stateRoot });
    git(repo.wt, "merge", "-q", "-X", "theirs", "--no-edit", "main");
    assert.notEqual(planSnapshotFingerprint({ stateRoot }), beforeMainMerge, "so does merging main into it");
    [record] = scan(stateRoot).records("aaa111");
    assert.deepEqual(codes(record), [], "merging main into the worktree clears the outside edit");
  } else {
    console.log("skip: reftable cases (this Git cannot create reftable repositories)");
  }

  console.log("plan-suite authority edges: ok");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
