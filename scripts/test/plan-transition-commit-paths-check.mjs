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
const { git, roborepo, json, repository } = fx;
const onlyPlanCheck = (checks) => checks.find((check) => check.n === 4);

try {
  const root = repository("repo", {
    "docs/plans/backlog/test-rewrite.md": planDoc({ id: "rewr0001" }),
    "docs/plans/backlog/test-extra.md": planDoc({ id: "extr0001" }),
    "src/app.txt": "v1\n",
  });

  // ── promote: a rewrite large enough that Git no longer pairs the move as a rename ─────────────
  {
    const rewritten = Array.from({ length: 80 }, (_, i) => `- Rewritten requirement ${i}: the promotion replaced this plan's body.`).join("\n");
    fs.writeFileSync(path.join(root, "docs/plans/backlog/test-rewrite.md"), planDoc({ id: "rewr0001", title: "Rewritten during promotion", extra: `\n${rewritten}\n` }));

    const result = roborepo(["plans", "promote", "rewr0001", "--json"], { cwd: root });
    const body = json(result, "promote a rewritten plan");
    assert.doesNotMatch(git(root, "show", "--name-status", "--format=", "HEAD"), /^R/m, "the fixture rewrite is below Git's rename threshold");
    assert.equal(result.status, 0, `promote a rewritten plan approves\n${result.stdout}${result.stderr}`);
    assert.equal(body.verdict, "APPROVED");
    assert.equal(onlyPlanCheck(body.checks).ok, true, "a heavily edited move counts as touching only the plan");
  }

  // ── a move that also commits an unrelated path still fails ───────────────────────────────────
  {
    const fromPath = "docs/plans/backlog/test-extra.md";
    const toPath = "docs/plans/ready/test-extra.md";
    fs.mkdirSync(path.join(root, "docs/plans/ready"), { recursive: true });
    git(root, "mv", fromPath, toPath);
    fs.writeFileSync(path.join(root, "src/app.txt"), "v2\n");
    git(root, "add", "--", "src/app.txt");
    git(root, "commit", "--quiet", "-m", "Move the plan with an unrelated edit");

    const commit = git(root, "rev-parse", "HEAD");
    const checks = validateTransition({ cwd: root, primary: root, base: "main", id: "extr0001", fromPath, toPath, commit });
    const check = onlyPlanCheck(checks);
    assert.equal(check.ok, false, "an unrelated path in the transition commit fails the check");
    assert.match(check.observed, /src\/app\.txt/, "the failure names the unrelated path");
  }

  console.log("plan transition commit paths: ok");
} finally {
  fx.cleanup();
}
