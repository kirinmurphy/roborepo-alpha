#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "../../modules/plan-suite/index.mjs";
import { classifyPlanId } from "../../modules/plan-suite/plan-id.mjs";
import {
  findPlansMissingFrontmatter,
  hasNoFrontmatter,
  repairPlansMissingFrontmatter,
  scaffoldFrontmatter,
  slugFromFilename,
} from "../../modules/plan-suite/repair.mjs";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-plan-repair-"));
try {
  const repo = path.join(tempRoot, "sample-repo");
  fs.mkdirSync(path.join(repo, "docs", "plans", "backlog"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git"), "gitdir: nowhere\n");

  const noFrontmatterBody = "# No Frontmatter Plan\n\nJust a body, no leading frontmatter block at all.\n";
  fs.writeFileSync(path.join(repo, "docs", "plans", "backlog", "no-frontmatter.md"), noFrontmatterBody);

  fs.writeFileSync(path.join(repo, "docs", "plans", "backlog", "has-frontmatter.md"), `---
id: has-frontmatter
priority: high
next_action: Already fine
blocked_by: []
depends_on: []
related: []
reviewed_commit:
---
# Has Frontmatter Plan
`);

  // Unclosed frontmatter (opens with "---\n" but never closes) is a different failure mode and
  // must be left untouched by the repair tool.
  fs.writeFileSync(path.join(repo, "docs", "plans", "backlog", "unclosed.md"), "---\nid: unclosed\n# Unclosed Plan\n");

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
  assert.match(scaffold, /priority: none/);
  assert.match(scaffold, /next_action: .+/);
  assert.match(scaffold, /blocked_by: \[\]/);
  assert.match(scaffold, /depends_on: \[\]/);
  assert.match(scaffold, /related: \[\]/);
  // New and repaired plans start unassociated; plan-start fills `worktree` when work begins.
  assert.match(scaffold, /reviewed_commit:\nworktree:\n---/);
  const scaffoldParsed = parseFrontmatter(scaffold + "# Title\n");
  assert.equal(scaffoldParsed.warnings.length, 0, "scaffolded frontmatter must itself parse cleanly");

  // --- findPlansMissingFrontmatter: only the zero-frontmatter file is flagged ---------------------
  const found = findPlansMissingFrontmatter(tempRoot);
  assert.equal(found.affected.length, 1);
  assert.equal(found.affected[0].relativePath, "docs/plans/backlog/no-frontmatter.md");
  assert.equal(found.affected[0].repository, "sample-repo");

  // --- dry-run: reports the file but does not touch disk ------------------------------------------
  const dryRunResult = repairPlansMissingFrontmatter(tempRoot, { dryRun: true });
  assert.equal(dryRunResult.repaired.length, 1);
  assert.equal(fs.readFileSync(path.join(repo, "docs", "plans", "backlog", "no-frontmatter.md"), "utf8"), noFrontmatterBody);

  // --- real repair: scaffolds frontmatter, preserves body byte-for-byte, leaves others alone -------
  const repairResult = repairPlansMissingFrontmatter(tempRoot);
  assert.equal(repairResult.repaired.length, 1);
  const repairedContent = fs.readFileSync(path.join(repo, "docs", "plans", "backlog", "no-frontmatter.md"), "utf8");
  assert.match(repairedContent, /^---\n/);
  assert.match(repairedContent, /id: [0-9a-z]{6,8}\n/);
  assert.match(repairedContent, /# No Frontmatter Plan\n\nJust a body, no leading frontmatter block at all\.\n$/);
  assert.equal(hasNoFrontmatter(repairedContent), false);

  const hasFrontmatterUnchanged = fs.readFileSync(path.join(repo, "docs", "plans", "backlog", "has-frontmatter.md"), "utf8");
  assert.match(hasFrontmatterUnchanged, /id: has-frontmatter/, "a file that already has frontmatter keeps its id untouched");

  const unclosedUnchanged = fs.readFileSync(path.join(repo, "docs", "plans", "backlog", "unclosed.md"), "utf8");
  assert.equal(unclosedUnchanged, "---\nid: unclosed\n# Unclosed Plan\n", "unclosed-frontmatter file must be left untouched");

  // Re-running finds nothing left to repair.
  const rerun = findPlansMissingFrontmatter(tempRoot);
  assert.equal(rerun.affected.length, 0);

  // --- CLI wiring: `roborepo plans repair <root> [--dry-run]` ------------------------------------
  const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "cli", "main.mjs");
  const cliRoot = path.join(tempRoot, "cli-repo");
  fs.mkdirSync(path.join(cliRoot, "docs", "plans", "backlog"), { recursive: true });
  fs.writeFileSync(path.join(cliRoot, ".git"), "gitdir: nowhere\n");
  fs.writeFileSync(path.join(cliRoot, "docs", "plans", "backlog", "bare.md"), "# Bare Plan\n\nNo frontmatter.\n");

  const cliDryRun = spawnSync(process.execPath, [cliPath, "plans", "repair", tempRoot, "--dry-run"], { encoding: "utf8" });
  assert.equal(cliDryRun.status, 0, cliDryRun.stderr);
  assert.match(cliDryRun.stdout, /would scaffold frontmatter for/);
  assert.match(cliDryRun.stdout, /cli-repo: docs\/plans\/backlog\/bare\.md/);
  assert.equal(fs.readFileSync(path.join(cliRoot, "docs", "plans", "backlog", "bare.md"), "utf8"), "# Bare Plan\n\nNo frontmatter.\n");

  const cliApply = spawnSync(process.execPath, [cliPath, "plans", "repair", tempRoot], { encoding: "utf8" });
  assert.equal(cliApply.status, 0, cliApply.stderr);
  assert.match(cliApply.stdout, /scaffolded frontmatter for/);
  const cliRepaired = fs.readFileSync(path.join(cliRoot, "docs", "plans", "backlog", "bare.md"), "utf8");
  assert.match(cliRepaired, /^---\n/);
  assert.match(cliRepaired, /id: [0-9a-z]{6,8}\n/);

  const cliUnknownSub = spawnSync(process.execPath, [cliPath, "plans", "bogus"], { encoding: "utf8" });
  assert.notEqual(cliUnknownSub.status, 0);

  const cliMissingRoot = spawnSync(process.execPath, [cliPath, "plans", "repair"], { encoding: "utf8" });
  assert.notEqual(cliMissingRoot.status, 0);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log("ok: plan docs frontmatter repair");
