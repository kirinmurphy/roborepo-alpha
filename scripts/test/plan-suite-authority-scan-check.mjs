#!/usr/bin/env node
// The Plans snapshot returns each active plan from its assigned worktree while that worktree holds
// a usable copy, falls back to the primary copy with a finding otherwise, reports an outside edit to
// the primary copy, and sends every portal write to the authoritative copy.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildPlanSnapshot, planSnapshotFingerprint, updatePlanPriority } from "../../modules/plan-suite/index.mjs";
import { recordRepositoryDiscovery } from "../cli/repositories.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-plan-authority-scan-")));
const REPOSITORY_ID = "git:github.com/example/authority";

function git(cwd, ...args) {
  const result = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=Test", ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

// The title sits well below the frontmatter so a title edit and a priority edit merge cleanly.
function plan(id, { title = id, priority = "high", worktree = "" } = {}) {
  return `---\nid: ${id}\npriority: ${priority}\nnext_action: Do it\nworktree: ${worktree}\n---\n\n## Notes\n\nKept apart.\n\n# ${title}\n`;
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function read(file) {
  return fs.readFileSync(file, "utf8");
}

const codes = (record) => record.plan.validation.findings.map((item) => item.code).filter((code) => /WORKTREE|AUTHORITY/.test(code));
const findingOf = (record, code) => record.plan.validation.findings.find((item) => item.code === code);

try {
  const main = path.join(tempRoot, "authority");
  const trees = path.join(tempRoot, "trees");
  const active = (name) => path.join(main, "docs/plans/active", name);

  // A plan whose worktree is created before its start transition is committed.
  write(path.join(main, "docs/plans/backlog/prestart.md"), plan("pre000"));
  git(main, "init", "-q", "-b", "main");
  git(main, "remote", "add", "origin", "https://github.com/example/authority.git");
  git(main, "add", ".");
  git(main, "commit", "-qm", "seed");
  git(main, "worktree", "add", "-q", "-b", "late", path.join(trees, "late"));

  // Start transitions, as /plan-start commits them in the primary checkout.
  fs.mkdirSync(path.join(main, "docs/plans/active"), { recursive: true });
  git(main, "mv", "docs/plans/backlog/prestart.md", "docs/plans/active/prestart.md");
  write(active("prestart.md"), plan("pre000", { worktree: "late" }));
  write(active("worked.md"), plan("act222", { title: "Worked", worktree: "feature-x" }));
  write(active("gone.md"), plan("gone666", { worktree: "vanished-tree" }));
  write(active("nocopy.md"), plan("nocopy777", { worktree: "feature-x" }));
  write(active("left.md"), plan("left888", { worktree: "feature-x" }));
  write(active("other.md"), plan("other999", { worktree: "feature-x" }));
  write(active("detached.md"), plan("det111", { worktree: "detached-tree" }));
  write(active("idle.md"), plan("idle555", { title: "Idle", worktree: "behind" }));
  write(path.join(main, "docs/plans/backlog/backlog.md"), plan("back333", { title: "Backlog" }));
  git(main, "add", ".");
  git(main, "commit", "-qm", "start");

  const featureX = path.join(trees, "feature-x");
  const behind = path.join(trees, "behind");
  const detached = path.join(trees, "detached-tree");
  git(main, "worktree", "add", "-q", "-b", "feature-x", featureX);
  git(main, "worktree", "add", "-q", "-b", "behind", behind);
  git(main, "worktree", "add", "-q", "--detach", detached);
  const inFeature = (name) => path.join(featureX, "docs/plans/active", name);

  // Normal progress in the assigned worktree, and every way its copy can stop being usable.
  write(inFeature("worked.md"), plan("act222", { title: "Worked in the worktree", worktree: "feature-x" }));
  fs.rmSync(inFeature("nocopy.md"));
  write(path.join(featureX, "docs/plans/completed/left.md"), read(inFeature("left.md")));
  fs.rmSync(inFeature("left.md"));
  write(inFeature("other.md"), plan("other999", { worktree: "another-tree" }));
  write(inFeature("new.md"), plan("new444", { title: "Worktree only" }));
  write(path.join(detached, "docs/plans/active/detached.md"), plan("det111", { title: "Detached progress", worktree: "detached-tree" }));
  // An unassigned worktree's copy is never read, however it differs.
  write(path.join(behind, "docs/plans/active/worked.md"), plan("act222", { title: "An unrelated copy", worktree: "feature-x" }));
  git(featureX, "add", ".");
  git(featureX, "commit", "-qm", "progress");

  const stateRoot = path.join(tempRoot, "state");
  recordRepositoryDiscovery({
    repositoryId: REPOSITORY_ID, kind: "git", displayName: "authority", source: "developer-runtime",
    evidence: "git-remote", confidence: "high", localRoot: "main-root", localRootKind: "clone", localRootPath: main, stateRoot,
  });
  const scan = () => {
    const snapshot = buildPlanSnapshot({ stateRoot });
    return { snapshot, byId: Object.fromEntries(snapshot.plans.map((record) => [record.plan.id, record])) };
  };

  let { snapshot, byId } = scan();
  assert.equal(byId.act222.plan.title, "Worked in the worktree", "an active plan is read from its assigned worktree");
  assert.deepEqual(byId.act222.plan.authority, { source: "worktree", worktree: "feature-x" });
  assert.equal(byId.act222.plan.checkout, "feature-x");
  assert.equal(byId.act222.plan.lifecycle, "active");
  assert.deepEqual(codes(byId.act222), [], "normal worktree progress is quiet");
  assert.deepEqual(byId.back333.plan.authority, { source: "primary" });
  assert.deepEqual(codes(byId.back333), [], "a worktree that is behind or never touched a plan changes nothing");

  const fallbacks = { gone666: "worktree-missing", nocopy777: "copy-missing", left888: "copy-not-active", other999: "copy-other-worktree", pre000: "copy-not-active" };
  for (const [id, reason] of Object.entries(fallbacks)) {
    assert.deepEqual(byId[id].plan.authority, { source: "primary" }, `${id} falls back to the primary copy`);
    assert.equal(byId[id].plan.checkout, null);
    assert.equal(findingOf(byId[id], "PLAN_WORKTREE_COPY_UNAVAILABLE")?.meta.reason, reason, `${id}: ${reason}`);
  }

  assert.equal(byId.det111.plan.title, "Detached progress", "a detached worktree's copy is still authoritative");
  assert.deepEqual(codes(byId.det111), ["PLAN_AUTHORITY_UNCHECKED"], "but outside edits cannot be checked against it");

  assert.equal(byId.new444.plan.checkout, "feature-x", "a worktree-only plan is still shown, labeled with its worktree");
  assert.equal(byId.new444.plan.authority, null);
  assert.equal(snapshot.plans.length, 10, "each plan is returned once");

  // An assigned worktree that falls behind main and never touches its plan changes nothing.
  write(path.join(main, "docs/plans/backlog/later.md"), plan("later999"));
  git(main, "add", ".");
  git(main, "commit", "-qm", "main moves on");
  ({ byId } = scan());
  assert.deepEqual(byId.idle555.plan.authority, { source: "worktree", worktree: "behind" }, "a worktree behind main still holds the authoritative copy");
  assert.deepEqual(codes(byId.idle555), []);

  // ---- Outside edits to the primary copy ----
  const primaryWorked = active("worked.md");
  write(primaryWorked, read(primaryWorked).replace("priority: high", "priority: low"));
  ({ byId } = scan());
  assert.equal(byId.act222.plan.title, "Worked in the worktree", "the portal keeps showing the worktree copy");
  assert.deepEqual(findingOf(byId.act222, "PLAN_EDITED_OUTSIDE_WORKTREE")?.meta, { worktree: "feature-x", committed: false }, "an uncommitted primary edit is reported");
  git(main, "commit", "-qam", "edit on main");
  ({ byId } = scan());
  assert.deepEqual(findingOf(byId.act222, "PLAN_EDITED_OUTSIDE_WORKTREE")?.meta, { worktree: "feature-x", committed: true }, "so is a committed one");
  git(featureX, "merge", "-q", "--no-edit", "main");
  ({ byId } = scan());
  assert.deepEqual(codes(byId.act222), [], "merging main into the worktree clears it");
  assert.match(read(inFeature("worked.md")), /priority: low[\s\S]*Worked in the worktree/);

  // ---- The fingerprint notices a merge that touches no plan file ----
  write(path.join(main, "README.md"), "readme\n");
  git(main, "add", "README.md");
  git(main, "commit", "-qm", "readme");
  const beforeMerge = planSnapshotFingerprint({ stateRoot });
  git(featureX, "merge", "-q", "--no-edit", "main");
  assert.notEqual(planSnapshotFingerprint({ stateRoot }), beforeMerge, "merging main into a worktree changes the fingerprint");

  // ---- Writes follow authority ----
  ({ snapshot, byId } = scan());
  const primaryBefore = read(primaryWorked);
  const changed = updatePlanPriority(snapshot, { id: "act222", key: byId.act222.key, priority: "medium", expectedPriority: "low", mtimeMs: byId.act222.mtimeMs });
  assert.match(read(inFeature("worked.md")), /priority: medium/, "an active plan's priority is written to the worktree copy");
  assert.equal(read(primaryWorked), primaryBefore, "the primary copy is byte-identical");
  assert.deepEqual(changed.record.plan.authority, { source: "worktree", worktree: "feature-x" }, "the returned record still says where it was read from");
  updatePlanPriority(snapshot, { id: "back333", key: byId.back333.key, priority: "low", expectedPriority: "high", mtimeMs: byId.back333.mtimeMs });
  assert.match(read(path.join(main, "docs/plans/backlog/backlog.md")), /priority: low/, "a backlog plan's priority is written to the primary copy");

  // ---- /api/plans carries the authority object and no absolute path ----
  const portal = spawnSync(process.execPath, ["-e", "import('./scripts/cli/plans.mjs').then((m) => process.stdout.write(JSON.stringify(m.loadPlansSnapshot())))"], {
    cwd: repoRoot,
    env: { ...process.env, ROBOREPO_STATE_ROOT: stateRoot },
    encoding: "utf8",
  });
  assert.equal(portal.status, 0, portal.stderr);
  const publicWorked = JSON.parse(portal.stdout).plans.find((record) => record.plan.id === "act222");
  assert.deepEqual(publicWorked.plan.authority, { source: "worktree", worktree: "feature-x" });
  assert.ok(!portal.stdout.includes(tempRoot), "/api/plans carries no absolute path");

  console.log("plan-suite authority scan: ok");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
