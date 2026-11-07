#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createPlanFixture } from "./lib/plan-git-fixture.mjs";
import { parseFrontmatter } from "../../modules/plan-suite/index.mjs";
import { classifyPlanId } from "../../modules/plan-suite/plan-id.mjs";
import {
  findPlansMissingFrontmatter,
  hasNoFrontmatter,
  repairPlansMissingFrontmatter,
  scaffoldFrontmatter,
  slugFromFilename,
} from "../../modules/plan-suite/repair.mjs";

const fx = createPlanFixture("roborepo-plan-repair-");
const { tmp: tempRoot } = fx;
try {
  const noFrontmatterBody = "# No Frontmatter Plan\n\nJust a body, no leading frontmatter block at all.\n";
  const hasFrontmatterBody = `---
id: has-frontmatter
next_action: Already fine
blocked_by: []
depends_on: []
related: []
reviewed_commit:
---
# Has Frontmatter Plan
`;
  // Unclosed frontmatter (opens with "---\n" but never closes) is a different failure mode and
  // must be left untouched by the repair tool.
  const unclosedBody = "---\nid: unclosed\n# Unclosed Plan\n";
  const repo = fx.repository("sample-repo", {
    "plans/backlog/no-frontmatter.md": noFrontmatterBody,
    "plans/backlog/has-frontmatter.md": hasFrontmatterBody,
    "plans/backlog/unclosed.md": unclosedBody,
  });
  const store = fx.storePath(repo);

  // --- unit-level checks on the detection/scaffold helpers ---------------------------------------
  assert.equal(hasNoFrontmatter(noFrontmatterBody), true);
  assert.equal(hasNoFrontmatter("---\nid: x\n---\nbody"), false);
  assert.equal(hasNoFrontmatter("---\nid: x\nbody-no-close"), false, "unclosed frontmatter is not \"missing\" frontmatter");
  assert.equal(slugFromFilename("/a/b/My Plan File.md"), "my-plan-file");

  const scaffold = scaffoldFrontmatter();
  assert.match(scaffold, /^---\n/);
  // A minted id is opaque and not derived from the filename: a derived id would be stale the first
  // time the file is renamed, and ids never change once written.
  assert.match(scaffold, /id: [0-9a-z]{6,8}\n/);
  assert.equal(classifyPlanId(/id: ([0-9a-z]+)/.exec(scaffold)[1]), "short");
  assert.notEqual(scaffoldFrontmatter(), scaffold, "each repair mints a distinct id");
  assert.doesNotMatch(scaffold, /priority/);
  assert.match(scaffold, /next_action: .+/);
  assert.match(scaffold, /blocked_by: \[\]/);
  assert.match(scaffold, /depends_on: \[\]/);
  assert.match(scaffold, /related: \[\]/);
  // New and repaired plans start unassociated; plan-execute fills `worktree` when work begins.
  assert.match(scaffold, /reviewed_commit:\nworktree:\n---/);
  const scaffoldParsed = parseFrontmatter(scaffold + "# Title\n");
  assert.equal(scaffoldParsed.warnings.length, 0, "scaffolded frontmatter must itself parse cleanly");

  // --- findPlansMissingFrontmatter: only the zero-frontmatter file is flagged ---------------------
  const found = findPlansMissingFrontmatter(tempRoot);
  assert.equal(found.affected.length, 1);
  assert.equal(found.affected[0].relativePath, "plans/backlog/no-frontmatter.md");
  assert.equal(found.affected[0].repository, "sample-repo");

  // --- dry-run: reports the file but does not touch disk ------------------------------------------
  const dryRunResult = await repairPlansMissingFrontmatter(tempRoot, { dryRun: true });
  assert.equal(dryRunResult.repaired.length, 1);
  assert.equal(fs.readFileSync(path.join(store, "plans", "backlog", "no-frontmatter.md"), "utf8"), noFrontmatterBody);

  // --- real repair: scaffolds frontmatter, preserves body byte-for-byte, leaves others alone -------
  const repairResult = await repairPlansMissingFrontmatter(tempRoot);
  assert.equal(repairResult.repaired.length, 1);
  const repairedContent = fs.readFileSync(path.join(store, "plans", "backlog", "no-frontmatter.md"), "utf8");
  assert.match(repairedContent, /^---\n/);
  assert.match(repairedContent, /id: [0-9a-z]{6,8}\n/);
  assert.match(repairedContent, /# No Frontmatter Plan\n\nJust a body, no leading frontmatter block at all\.\n$/);
  assert.equal(hasNoFrontmatter(repairedContent), false);

  const hasFrontmatterUnchanged = fs.readFileSync(path.join(store, "plans", "backlog", "has-frontmatter.md"), "utf8");
  assert.match(hasFrontmatterUnchanged, /id: has-frontmatter/, "a file that already has frontmatter keeps its id untouched");

  const unclosedUnchanged = fs.readFileSync(path.join(store, "plans", "backlog", "unclosed.md"), "utf8");
  assert.equal(unclosedUnchanged, unclosedBody, "unclosed-frontmatter file must be left untouched");

  // Re-running finds nothing left to repair.
  const rerun = findPlansMissingFrontmatter(tempRoot);
  assert.equal(rerun.affected.length, 0);

  // --- CLI wiring: `roborepo plans repair <root> [--dry-run]` ------------------------------------
  const cliRepo = fx.repository("cli-repo", { "plans/backlog/bare.md": "# Bare Plan\n\nNo frontmatter.\n" });
  const cliStore = fx.storePath(cliRepo);
  const cliBare = path.join(cliStore, "plans", "backlog", "bare.md");

  const cliDryRun = fx.roborepo(["plans", "repair", tempRoot, "--dry-run"], { cwd: tempRoot });
  assert.equal(cliDryRun.status, 0, cliDryRun.stderr);
  assert.match(cliDryRun.stdout, /would scaffold frontmatter for/);
  assert.match(cliDryRun.stdout, /cli-repo: plans\/backlog\/bare\.md/);
  assert.equal(fs.readFileSync(cliBare, "utf8"), "# Bare Plan\n\nNo frontmatter.\n");

  const cliApply = fx.roborepo(["plans", "repair", tempRoot], { cwd: tempRoot });
  assert.equal(cliApply.status, 0, cliApply.stderr);
  assert.match(cliApply.stdout, /scaffolded frontmatter for/);
  const cliRepaired = fs.readFileSync(cliBare, "utf8");
  assert.match(cliRepaired, /^---\n/);
  assert.match(cliRepaired, /id: [0-9a-z]{6,8}\n/);
  assert.equal(fx.git(cliStore, "status", "--porcelain"), "", "the repair is committed on the plans branch");

  const cliUnknownSub = fx.roborepo(["plans", "bogus"], { cwd: tempRoot });
  assert.notEqual(cliUnknownSub.status, 0);

  const cliMissingRoot = fx.roborepo(["plans", "repair"], { cwd: tempRoot });
  assert.notEqual(cliMissingRoot.status, 0);
} finally {
  fx.cleanup();
}

console.log("ok: plan docs frontmatter repair");
