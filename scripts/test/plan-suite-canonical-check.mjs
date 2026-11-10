#!/usr/bin/env node
// Plans scans the repositories RoboRepo knows about: each visible repository is read from its one plans
// worktree and returned with explicit per-repository scan state, whichever checkout the registry
// recorded. Plans settings and ROBOREPO_PLAN_ROOTS do not affect anything.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildPlanSnapshot, planSnapshotFingerprint } from "../../modules/plan-suite/index.mjs";
import { hideRepository, loadRegistry, updateRegistry } from "../../modules/repositories/index.mjs";
import { recordRepositoryDiscovery } from "../cli/repositories.mjs";
import { addRepositorySource } from "../cli/repository-sources.mjs";
import { createPlanFixture } from "./lib/plan-git-fixture.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fx = createPlanFixture("roborepo-plans-canonical-");
const tempRoot = fx.tmp;
const REPOSITORY_ID = "git:github.com/example/planned";

function plan(id, title, worktree = "") {
  return `---\nid: ${id}\nnext_action: Do it\nworktree: ${worktree}\n---\n\n# ${title}\n`;
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function snapshotFor(stateRoot) {
  return buildPlanSnapshot({ stateRoot });
}

try {
  const main = fx.repository("planned", {
    "plans/backlog/same.md": plan("same111", "Same"),
    "plans/backlog/differs.md": plan("diff222", "Differs", "feature-x"),
    "plans/backlog/main-only.md": plan("main333", "Main only"),
    "plans/active/new.md": plan("new444", "Plan in the store"),
  });
  const store = fx.storePath(main);
  const worktree = fx.worktree(main, "feature-x").path;
  fx.worktree(main, "behind");

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
  const fingerprintFile = path.join(store, "plans/active/new.md");
  fs.appendFileSync(fingerprintFile, "\n");
  const afterEdit = planSnapshotFingerprint({ stateRoot });
  assert.notEqual(afterEdit, fingerprint, "editing a plan in the store changes the fingerprint");
  const extra = fx.worktree(main, "extra").path;
  assert.notEqual(planSnapshotFingerprint({ stateRoot }), afterEdit, "adding a worktree changes the fingerprint");
  fx.git(main, "worktree", "remove", "--force", extra);
  fs.writeFileSync(fingerprintFile, plan("new444", "Plan in the store"));

  const snapshot = snapshotFor(stateRoot);
  assert.deepEqual(snapshot.repositoryScans, [{ repositoryId: REPOSITORY_ID, state: "scanned", planCount: 4, checkoutCount: 3, worktrees: ["behind", "feature-x"], pendingCommits: 0 }],
    "a scan lists every linked worktree Git knows, by administrative name");
  const byId = Object.fromEntries(snapshot.plans.map((record) => [record.plan.id, record]));
  assert.deepEqual(Object.keys(byId).sort(), ["diff222", "main333", "new444", "same111"], "identical copies collapse to one record");
  assert.equal(snapshot.plans.length, 4);

  assert.equal(byId.same111.absolutePath, path.join(store, "plans/backlog/same.md"), "a plan is read from the plans worktree");
  assert.equal(byId.diff222.plan.title, "Differs", "a plan is read from the store whichever checkout is registered");
  assert.equal(byId.new444.repository.id, byId.same111.repository.id, "every plan belongs to one repository");

  // ---- Plans settings and ROBOREPO_PLAN_ROOTS no longer affect Plans ----
  const decoy = path.join(tempRoot, "decoy");
  write(path.join(decoy, "plans/backlog/decoy.md"), plan("decoy555", "Decoy"));
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
    env: { ...process.env, ROBOREPO_STATE_ROOT: stateRoot, PLAN_FILE: path.join(store, "plans/backlog/same.md") },
    encoding: "utf8",
  });
  assert.equal(cached.status, 0, cached.stderr);
  assert.deepEqual(JSON.parse(cached.stdout), ["Same", "Same, renamed"], "the cached snapshot is built on first use and rebuilt after a plan edit");

  // ---- Explicit scan state: unavailable checkouts and hidden repositories ----
  const vanishedState = path.join(tempRoot, "state-vanished");
  const vanished = fx.repository("vanished", { "plans/backlog/a.md": plan("van666", "Vanished") });
  addRepositorySource({ path: vanished, stateRoot: vanishedState, homeDir: tempRoot });
  fs.rmSync(vanished, { recursive: true });
  const vanishedScan = snapshotFor(vanishedState).repositoryScans[0];
  assert.equal(vanishedScan.state, "unavailable", "a repository with no readable checkout is not reported as scanned");

  const id = Object.keys(loadRegistry({ stateRoot }).repositories)[0];
  updateRegistry({ stateRoot, mutate: (registry) => hideRepository(registry, id, { hidden: true }) });
  assert.deepEqual(snapshotFor(stateRoot).plans, [], "an ignored repository is left out of normal Plans entries");

  console.log("plan-suite canonical scan: ok");
} finally {
  fx.cleanup();
}
