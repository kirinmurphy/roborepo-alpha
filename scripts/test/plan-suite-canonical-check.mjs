#!/usr/bin/env node
// Plans scans the repositories RoboRepo knows about (pljvmyh §9): every checkout of a visible
// repository, merged by plan id and returned from each plan's authoritative copy, with explicit per-repository
// scan state. Plans settings and ROBOREPO_PLAN_ROOTS no longer affect anything.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildPlanSnapshot, movePlanLifecycle, planSnapshotFingerprint, updatePlanPriority } from "../../modules/plan-suite/index.mjs";
import { hideRepository, loadRegistry, updateRegistry } from "../../modules/repositories/index.mjs";
import { recordRepositoryDiscovery } from "../cli/repositories.mjs";
import { addRepositorySource } from "../cli/repository-sources.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-plans-canonical-")));
const REPOSITORY_ID = "git:github.com/example/planned";

function git(cwd, ...args) {
  const result = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=Test", ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function plan(id, title, priority = "high", worktree = "") {
  return `---\nid: ${id}\npriority: ${priority}\nnext_action: Do it\nworktree: ${worktree}\n---\n\n# ${title}\n`;
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function snapshotFor(stateRoot) {
  return buildPlanSnapshot({ stateRoot });
}

try {
  const main = path.join(tempRoot, "planned");
  write(path.join(main, "docs/plans/backlog/same.md"), plan("same111", "Same"));
  write(path.join(main, "docs/plans/backlog/differs.md"), plan("diff222", "Differs", "high", "feature-x"));
  write(path.join(main, "docs/plans/backlog/main-only.md"), plan("main333", "Main only"));
  fs.mkdirSync(main, { recursive: true });
  git(main, "init", "-q", "-b", "main");
  git(main, "remote", "add", "origin", "https://github.com/example/planned.git");
  git(main, "add", ".");
  git(main, "commit", "-qm", "seed");
  const worktree = path.join(tempRoot, "trees", "feature-x");
  git(main, "worktree", "add", "-q", "-b", "feature-x", worktree);
  write(path.join(worktree, "docs/plans/backlog/differs.md"), plan("diff222", "Differs in the worktree", "high", "feature-x"));
  // A second worktree that is only behind main: it holds an older copy of a plan it never touched.
  const behind = path.join(tempRoot, "trees", "behind");
  git(main, "worktree", "add", "-q", "-b", "behind", behind);
  write(path.join(main, "docs/plans/backlog/main-only.md"), plan("main333", "Main only, edited since"));
  write(path.join(behind, "docs/plans/backlog/differs.md"), plan("diff222", "An older copy elsewhere", "high", "feature-x"));
  write(path.join(worktree, "docs/plans/active/new.md"), plan("new444", "Worktree only"));

  // ---- Runtime-discovered repository stays usable for Plans after its process goes offline. ----
  // Runtime registered only the worktree, first: the main checkout must still come from Git.
  const stateRoot = path.join(tempRoot, "state");
  recordRepositoryDiscovery({
    repositoryId: REPOSITORY_ID, kind: "git", displayName: "planned", source: "developer-runtime",
    evidence: "git-remote", confidence: "high", localRoot: "worktree-root", localRootKind: "clone", localRootPath: worktree, stateRoot,
  });
  assert.equal(loadRegistry({ stateRoot }).repositories[REPOSITORY_ID].localRoots[0].kind, "primary", "the registry's first root is the worktree");

  // The fingerprint gates Home's rebuilds: stable while nothing changes, moved by a plan edit or a
  // new worktree.
  const fingerprint = planSnapshotFingerprint({ stateRoot });
  assert.equal(planSnapshotFingerprint({ stateRoot }), fingerprint, "an unchanged tree fingerprints the same");
  const fingerprintFile = path.join(worktree, "docs/plans/active/new.md");
  fs.appendFileSync(fingerprintFile, "\n");
  const afterEdit = planSnapshotFingerprint({ stateRoot });
  assert.notEqual(afterEdit, fingerprint, "editing a plan in any checkout changes the fingerprint");
  const extra = path.join(tempRoot, "trees", "extra");
  git(main, "worktree", "add", "-q", "-b", "extra", extra);
  assert.notEqual(planSnapshotFingerprint({ stateRoot }), afterEdit, "adding a worktree changes the fingerprint");
  git(main, "worktree", "remove", "--force", extra);
  fs.writeFileSync(fingerprintFile, plan("new444", "Worktree only"));

  const snapshot = snapshotFor(stateRoot);
  assert.deepEqual(snapshot.repositoryScans, [{ repositoryId: REPOSITORY_ID, state: "scanned", planCount: 4, checkoutCount: 3, worktrees: ["behind", "feature-x"] }],
    "a scan lists every linked worktree Git knows, by administrative name");
  const byId = Object.fromEntries(snapshot.plans.map((record) => [record.plan.id, record]));
  assert.deepEqual(Object.keys(byId).sort(), ["diff222", "main333", "new444", "same111"], "identical copies collapse to one record");
  assert.equal(snapshot.plans.length, 4);

  assert.equal(byId.same111.plan.checkout, null);
  assert.deepEqual(byId.same111.plan.authority, { source: "primary" });
  assert.equal(byId.same111.absolutePath, path.join(fs.realpathSync(main), "docs/plans/backlog/same.md"), "a backlog plan is read from the main checkout");

  // Active-plan authority has its own fixture in plan-suite-authority-scan-check.mjs.
  const copyFindings = (record) => record.plan.validation.findings.filter((item) => /WORKTREE|AUTHORITY/.test(item.code));
  assert.equal(byId.diff222.plan.title, "Differs", "a backlog plan's worktree copy never wins, even in its named worktree");
  assert.deepEqual(copyFindings(byId.diff222), [], "a backlog plan's differing worktree copy is not a finding");
  assert.deepEqual(copyFindings(byId.main333), [], "a worktree that is only behind main marks nothing");

  assert.equal(byId.new444.plan.checkout, "feature-x", "a worktree-only plan is labeled with its worktree");
  assert.equal(byId.new444.plan.authority, null, "a worktree-only plan has no primary copy to resolve against");
  assert.equal(byId.new444.repository.id, byId.same111.repository.id, "every checkout's plans belong to one repository");

  // Edits: the backlog plan is written in the main checkout; the worktree-only plan in its worktree.
  updatePlanPriority(snapshot, { id: "diff222", key: byId.diff222.key, priority: "low", expectedPriority: "high", mtimeMs: byId.diff222.mtimeMs });
  assert.match(fs.readFileSync(path.join(main, "docs/plans/backlog/differs.md"), "utf8"), /priority: low/);
  assert.match(fs.readFileSync(path.join(worktree, "docs/plans/backlog/differs.md"), "utf8"), /priority: high/, "the worktree copy is untouched");
  movePlanLifecycle(snapshot, { id: "new444", key: byId.new444.key, lifecycle: "backlog", expectedLifecycle: "active", mtimeMs: byId.new444.mtimeMs, skipDestinationValidation: true });
  assert.ok(fs.existsSync(path.join(worktree, "docs/plans/backlog/new.md")), "a worktree-only plan is edited in its worktree");
  assert.ok(!fs.existsSync(path.join(main, "docs/plans/backlog/new.md")));

  // ---- Plans settings and ROBOREPO_PLAN_ROOTS no longer affect Plans ----
  const decoy = path.join(tempRoot, "decoy");
  write(path.join(decoy, "docs/plans/backlog/decoy.md"), plan("decoy555", "Decoy"));
  write(path.join(stateRoot, "plan-suite", "settings.json"), JSON.stringify({ schemaVersion: 1, discoveryRoots: [decoy] }));
  const portal = spawnSync(process.execPath, ["-e", "import('./scripts/cli/plans.mjs').then((m) => process.stdout.write(JSON.stringify(m.loadPlansSnapshot())))"], {
    cwd: repoRoot,
    env: { ...process.env, ROBOREPO_STATE_ROOT: stateRoot, ROBOREPO_PLAN_ROOTS: decoy },
    encoding: "utf8",
  });
  assert.equal(portal.status, 0, portal.stderr);
  const publicSnapshot = JSON.parse(portal.stdout);
  assert.ok(!publicSnapshot.plans.some((record) => record.plan.id === "decoy555"), "discoveryRoots and ROBOREPO_PLAN_ROOTS are ignored");
  assert.equal(publicSnapshot.settings, undefined, "/api/plans no longer returns Plans settings");
  assert.ok(!portal.stdout.includes(tempRoot), "/api/plans carries no absolute path");

  // ---- Home's cached loader rebuilds when a plan changes, without anyone loading /api/plans ----
  const cachedScript = `
    import fs from "node:fs";
    const plans = await import("./scripts/cli/plans.mjs");
    const title = () => plans.loadCachedPlansSnapshot().plans.find((record) => record.plan.id === "same111").plan.title;
    const before = title();
    fs.writeFileSync(process.env.PLAN_FILE, fs.readFileSync(process.env.PLAN_FILE, "utf8").replace("# Same", "# Same, renamed"));
    process.stdout.write(JSON.stringify([before, title()]));
  `;
  const cached = spawnSync(process.execPath, ["--input-type=module", "-e", cachedScript], {
    cwd: repoRoot,
    env: { ...process.env, ROBOREPO_STATE_ROOT: stateRoot, PLAN_FILE: path.join(main, "docs/plans/backlog/same.md") },
    encoding: "utf8",
  });
  assert.equal(cached.status, 0, cached.stderr);
  assert.deepEqual(JSON.parse(cached.stdout), ["Same", "Same, renamed"], "the cached snapshot is built on first use and rebuilt after a plan edit");

  // ---- Explicit scan state: unavailable checkouts and hidden repositories ----
  const vanishedState = path.join(tempRoot, "state-vanished");
  const vanished = path.join(tempRoot, "vanished");
  write(path.join(vanished, "docs/plans/backlog/a.md"), plan("van666", "Vanished"));
  addRepositorySource({ path: vanished, stateRoot: vanishedState, homeDir: tempRoot });
  fs.rmSync(vanished, { recursive: true });
  const vanishedScan = snapshotFor(vanishedState).repositoryScans[0];
  assert.equal(vanishedScan.state, "unavailable", "a repository with no readable checkout is not reported as scanned");

  const id = Object.keys(loadRegistry({ stateRoot }).repositories)[0];
  updateRegistry({ stateRoot, mutate: (registry) => hideRepository(registry, id, { hidden: true }) });
  assert.deepEqual(snapshotFor(stateRoot).plans, [], "an ignored repository is left out of normal Plans entries");

  console.log("plan-suite canonical scan: ok");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
