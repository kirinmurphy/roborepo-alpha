#!/usr/bin/env node
// The one-time plans migration, against a real bare origin: all six folders, config, order, worktree
// copies of active and review plans, refusals that change nothing, and code branches left alone.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPlanFixture, planDoc } from "./lib/plan-git-fixture.mjs";

const helper = fileURLToPath(new URL("../dev/migrate-plans-once.mjs", import.meta.url));
const fx = createPlanFixture("roborepo-migrate-once-");
const run = (cwd) => spawnSync(process.execPath, [helper], { cwd, env: fx.env, encoding: "utf8" });
const doc = (id, extra = "") => `${planDoc({ id })}${extra}`;
const bound = (id, worktree) => doc(id).replace(/^worktree:.*$/m, `worktree: ${worktree}`);

try {
  const FOLDERS = ["backlog", "ready", "completed", "archived"];
  const code = Object.fromEntries(FOLDERS.map((folder) => [`docs/plans/${folder}/test-${folder}.md`, doc(`${folder.slice(0, 6)}1`)]));
  code["docs/plans/active/test-active.md"] = bound("active01", "feature-a");
  code["docs/plans/review/test-review.md"] = bound("review01", "feature-b");
  code["docs/plans/plans-config.json"] = JSON.stringify({ schemaVersion: 1, namespaces: { test: "Fixture." } });
  code["docs/plans/plans-order.json"] = JSON.stringify({ schemaVersion: 1, namespaces: { test: ["backlo1"] } });
  const root = fx.repository("source", code);
  const store = fx.storePath(root);
  const remote = (file) => fx.git(root, "show", `origin/repo-plans:${file}`);
  const head = fx.git(root, "rev-parse", "HEAD");

  // A named worktree that does not exist stops everything.
  let result = run(root);
  assert.equal(result.status, 1, "a missing worktree stops the helper");
  assert.match(result.stderr, /test-active\.md names worktree feature-a, which does not exist/);
  assert.equal(fs.existsSync(path.join(store, "plans/backlog/test-backlog.md")), false, "a refusal imports nothing");

  const a = fx.worktree(root, "feature-a").path;
  const b = fx.worktree(root, "feature-b").path;
  // The worktree's copy holds the progress; review's copy still sits in active/, as it did before.
  fs.writeFileSync(path.join(a, "docs/plans/active/test-active.md"), `${bound("active01", "feature-a")}\nWorktree progress A.\n`);
  fs.mkdirSync(path.join(b, "docs/plans/active"), { recursive: true });
  fs.rmSync(path.join(b, "docs/plans/review/test-review.md"));
  fs.writeFileSync(path.join(b, "docs/plans/active/test-review.md"), `${bound("review01", "feature-b")}\nWorktree progress B.\n`);

  result = run(root);
  assert.equal(result.status, 0, result.stderr);
  for (const folder of FOLDERS) assert.ok(remote(`plans/${folder}/test-${folder}.md`), `${folder} reached the remote`);
  assert.match(remote("plans/active/test-active.md"), /Worktree progress A/, "an active plan takes the worktree's content");
  assert.match(remote("plans/review/test-review.md"), /Worktree progress B/, "lifecycle comes from the primary copy, content from the worktree");
  assert.equal(JSON.parse(remote("plans/plans-config.json")).namespaces.test, "Fixture.");
  assert.ok(JSON.parse(remote("plans/plans-config.json")).worktreeRoot, "the store's location keys survive an old config without them");
  assert.deepEqual(JSON.parse(remote("plans/plans-order.json")).namespaces.test, ["backlo1"]);

  assert.equal(fx.git(root, "rev-parse", "HEAD"), head, "the code branch did not move");
  assert.equal(fx.git(root, "status", "--porcelain"), "", "the code checkout is untouched");
  assert.ok(fs.existsSync(path.join(root, "docs/plans/backlog/test-backlog.md")), "source files stay");

  // A rerun changes nothing, and a refusal below leaves the store's lock free for the next command.
  const storeHead = fx.git(store, "rev-parse", "HEAD");
  result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fx.git(store, "rev-parse", "HEAD"), storeHead, "a rerun makes no commit");

  // A nonempty destination plan is never overwritten.
  fs.writeFileSync(path.join(a, "docs/plans/active/test-active.md"), `${bound("active01", "feature-a")}\nLater edit.\n`);
  result = run(root);
  assert.equal(result.status, 1, "a differing destination plan stops the helper");
  assert.match(result.stderr, /plans\/active\/test-active\.md already exists with different content/);
  assert.equal(fx.git(store, "rev-parse", "HEAD"), storeHead, "that refusal commits nothing");
  fs.writeFileSync(path.join(a, "docs/plans/active/test-active.md"), `${bound("active01", "feature-a")}\nWorktree progress A.\n`);
  assert.equal(run(root).status, 0, "the refusal released the store's lock");

  // An old config that disagrees with the worktree's location stops for correction.
  const moved = fx.repository("moved", {
    "docs/plans/plans-config.json": JSON.stringify({ schemaVersion: 1, namespaces: {}, worktreeRoot: "/somewhere/else", worktreeRepoName: "moved" }),
    "docs/plans/backlog/test-one.md": doc("movedon1"),
  });
  result = run(moved);
  assert.equal(result.status, 1, "a disagreeing config stops the helper");
  assert.match(result.stderr, /old config puts the plans worktree at/);

  console.log("migrate-plans-once-check: ok");
} finally {
  fx.cleanup();
}
