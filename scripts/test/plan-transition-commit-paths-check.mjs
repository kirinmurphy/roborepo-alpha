#!/usr/bin/env node
// The post-commit check that a lifecycle transition touched only the plan: a move that carries
// heavy edits still passes even when Git's rename detection reads it as a delete plus an add, and a
// move with an unrelated path riding along still fails.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { validateTransition } from "../../modules/plan-suite/transition-checks.mjs";
import { createPlanFixture, planDoc } from "./lib/plan-git-fixture.mjs";

const fx = createPlanFixture("roborepo-plan-commit-paths-");
const { git, roborepo, json, repository, storePath } = fx;
const onlyPlanCheck = (checks) => checks.find((check) => check.n === 4);

try {
  const root = repository("repo", {
    "plans/backlog/test-rewrite.md": planDoc({ id: "rewr0001" }),
    "plans/backlog/test-extra.md": planDoc({ id: "extr0001" }),
    "src/app.txt": "v1\n",
  });

  const store = storePath(root);

  // ── a move whose commit carries a rewrite large enough that Git no longer pairs it as a rename ──
  {
    const fromPath = "plans/backlog/test-rewrite.md";
    const toPath = "plans/ready/test-rewrite.md";
    const rewritten = Array.from({ length: 80 }, (_, i) => `- Rewritten requirement ${i}: the move replaced this plan's body.`).join("\n");
    fs.mkdirSync(path.join(store, "plans/ready"), { recursive: true });
    git(store, "mv", fromPath, toPath);
    fs.writeFileSync(path.join(store, toPath), planDoc({ id: "rewr0001", title: "Rewritten during the move", extra: `\n${rewritten}\n` }));
    git(store, "add", "--", toPath);
    git(store, "commit", "--quiet", "-m", "Move and rewrite the plan");
    assert.doesNotMatch(git(store, "show", "--name-status", "--format=", "HEAD"), /^R/m, "the fixture rewrite is below Git's rename threshold");

    const commit = git(store, "rev-parse", "HEAD");
    const check = onlyPlanCheck(validateTransition({ root: store, id: "rewr0001", fromPath, toPath, commit }));
    assert.equal(check.ok, true, "a heavily edited move counts as touching only the plan");
  }

  // ── a move that also commits an unrelated path still fails ───────────────────────────────────
  {
    const fromPath = "plans/backlog/test-extra.md";
    const toPath = "plans/ready/test-extra.md";
    fs.mkdirSync(path.join(store, "plans/ready"), { recursive: true });
    git(store, "mv", fromPath, toPath);
    fs.mkdirSync(path.join(store, "src"), { recursive: true });
    fs.writeFileSync(path.join(store, "src/app.txt"), "v2\n");
    git(store, "add", "--", "src/app.txt");
    git(store, "commit", "--quiet", "-m", "Move the plan with an unrelated edit");

    const commit = git(store, "rev-parse", "HEAD");
    const checks = validateTransition({ root: store, id: "extr0001", fromPath, toPath, commit });
    const check = onlyPlanCheck(checks);
    assert.equal(check.ok, false, "an unrelated path in the transition commit fails the check");
    assert.match(check.observed, /src\/app\.txt/, "the failure names the unrelated path");
  }

  console.log("plan transition commit paths: ok");
} finally {
  fx.cleanup();
}
