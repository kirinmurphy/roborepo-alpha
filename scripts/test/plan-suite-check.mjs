#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildPlanSnapshot,
  buildPrompt,
  parseFrontmatter,
  readPlanDocument,
  updatePlanPriority,
  writeFrontmatterField,
} from "../../modules/plan-suite/index.mjs";
import { walkRepositoryRoots } from "../../modules/repositories/index.mjs";
import { addRepositorySource } from "../cli/repository-sources.mjs";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-plan-suite-"));
try {
  const stateRoot = path.join(tempRoot, "state");
  const projects = path.join(tempRoot, "projects");
  const repo = path.join(projects, "sample");
  fs.mkdirSync(path.join(repo, "docs", "plans", "backlog"), { recursive: true });
  fs.mkdirSync(path.join(repo, "docs", "plans", "active"), { recursive: true });
  fs.mkdirSync(path.join(repo, "docs", "plans", "completed"), { recursive: true });
  fs.mkdirSync(path.join(repo, "docs", "plans", "archived"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git"), "gitdir: nowhere\n");
  fs.writeFileSync(path.join(repo, "docs", "plans", "backlog", "ready.md"), `---
id: ready-plan
priority: high
next_action: Add the portal view
blocked_by: []
depends_on: []
related: []
reviewed_commit:
worktree: ready-plan-tree
---
# Ready Plan

## Summary

Build the thing.

## Context

Current implementation exists.

## Goals

Make plans visible.

## Proposed design

Use Markdown as source of truth.

| Surface | Renderer |
| --- | --- |
| Drawer | shared |

\`\`\`mermaid
flowchart LR
  A --> B
\`\`\`

## Implementation plan

- [ ] Add page
- [x] Add schema

## Validation

Run targeted checks.
`);
  // A fully-ready plan: every task checked and a Verification section, so the scanner reports no
  // lifecycle findings for it. Lifecycle moves are covered by plan-lifecycle-transitions-check.mjs.
  fs.writeFileSync(path.join(repo, "docs", "plans", "backlog", "movable.md"), `---
id: movable-plan
priority: medium
next_action: Move this plan around in tests.
blocked_by: []
depends_on: []
related: []
reviewed_commit:
worktree:
---
# Movable Plan

## Summary

Exercises lifecycle movement.

## Context

Used only by plan-suite-check.mjs.

## Goals

Give the scanner a plan with no open work.

## Proposed design

N/A.

## Implementation plan

- [x] Nothing left to do

## Verification

Verified manually by the test itself.

## Validation

N/A.
`);
  fs.writeFileSync(path.join(repo, "docs", "plans", "root.md"), "# Root Plan\n");
  fs.writeFileSync(path.join(repo, "docs", "plans", "backlog", "no-priority.md"), `---
id: no-priority-plan
next_action: Add the portal view
blocked_by: []
depends_on: []
related: []
reviewed_commit:
---
# No Priority Plan

## Summary

Plan with no priority frontmatter key at all (not just an empty value) — renders as "none" in
the UI via buildPlanRecord's fallback, and must still be settable through the priority endpoint.

## Context

Current implementation exists.

## Goals

Make plans visible.

## Proposed design

Use Markdown as source of truth.

## Implementation plan

- [ ] Add page

## Validation

Run targeted checks.
`);
  addRepositorySource({ path: projects, stateRoot });

  const snapshot = buildPlanSnapshot({ stateRoot, packageState: { available: true, enabled: false, status: "disabled" } });
  assert.equal(snapshot.repositories.length, 1);
  assert.equal(snapshot.plans.length, 4);
  const ready = snapshot.plans.find((item) => item.plan.id === "ready-plan");
  assert.ok(ready);
  assert.equal(ready.plan.lifecycle, "backlog");
  assert.equal(ready.plan.readiness, "ready");
  assert.equal(ready.plan.taskCounts.remaining, 1);
  // `worktree` is optional: populated, empty, and absent all parse, and only a value associates.
  assert.equal(ready.plan.worktree, "ready-plan-tree");
  assert.equal(snapshot.plans.find((item) => item.plan.id === "movable-plan").plan.worktree, "");
  assert.equal(snapshot.plans.find((item) => item.plan.id === "no-priority-plan").plan.worktree, "");
  assert.equal(ready.plan.validation.findings.some((item) => /frontmatter/i.test(item.code)), false);
  const root = snapshot.plans.find((item) => item.plan.relativePath.endsWith("root.md"));
  assert.equal(root.plan.lifecycle, "unclassified");
  assert.match(root.plan.validation.warnings.join("\n"), /unclassified/);

  const doc = readPlanDocument(snapshot, ready.key);
  assert.match(doc.html, /Ready Plan/);
  // The drawer renders through the shared markdown renderer (scripts/cli/markdown-render.mjs), not
  // the private mini-renderer it used to carry — so tables, mermaid diagrams, and task checkboxes
  // all render here the same way they do in the Config and Telemetry popups.
  assert.match(doc.html, /<div class="md-table-wrap"><table>/);
  assert.match(doc.html, /<th>Surface<\/th><th>Renderer<\/th>/);
  assert.match(doc.html, /<pre class="mermaid" data-mermaid-source="/);
  assert.match(doc.html, /<li class="md-task"><input type="checkbox" disabled> Add page<\/li>/);
  assert.match(doc.html, /<li class="md-task"><input type="checkbox" disabled checked> Add schema<\/li>/);
  // Frontmatter is plan metadata rendered as structured drawer fields; it must not leak into the
  // rendered body as prose.
  assert.doesNotMatch(doc.html, /reviewed_commit/);
  assert.doesNotMatch(JSON.stringify(doc.plan), new RegExp(tempRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(JSON.stringify(doc.parsed), new RegExp(tempRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  // A prompt opens with one atomic suite command and never a mode argument; anything that is not a
  // suite command yields a context-only prompt rather than a slash line the agent cannot run.
  const prompt = buildPrompt("plan-execute", [ready], { mode: "repository-aware" });
  assert.match(prompt, /^\/plan-execute\n/);
  assert.match(prompt, /docs\/plans\/backlog\/ready.md/);
  const portablePrompt = buildPrompt(null, [ready], { mode: "portable" });
  assert.match(portablePrompt, /^Use this bounded portable plan context/);
  assert.doesNotMatch(buildPrompt("start", [ready]), /^\//m, "a retired mode name produces no slash command");
  assert.doesNotMatch(buildPrompt("plan-start", [ready]), /^\//m, "the retired /plan-start command produces no slash command");

  // Both YAML list forms are accepted. Inline arrays used to be detected, reported, and discarded,
  // which silently emptied the field — so a valid reference written in valid YAML vanished from the
  // relationship graph instead of being resolved.
  const inlineParsed = parseFrontmatter("---\nid: bad\nblocked_by: [x, y]\nrelated: [solo]\n---\n# T\n");
  assert.deepEqual(inlineParsed.frontmatter.blocked_by, ["x", "y"]);
  assert.deepEqual(inlineParsed.frontmatter.related, ["solo"]);
  assert.equal(inlineParsed.findings.filter((item) => item.code === "UNSUPPORTED_INLINE_ARRAY").length, 0,
    "a well-formed inline array is not a problem to report");

  const blockParsed = parseFrontmatter("---\nid: bad\nblocked_by:\n  - x\n  - y\n---\n# T\n");
  assert.deepEqual(blockParsed.frontmatter.blocked_by, inlineParsed.frontmatter.blocked_by,
    "both list syntaxes must produce the same value");

  // A quoted entry may contain a comma — an external blocker reads as prose, so splitting on every
  // comma would tear one blocker into several.
  const quotedParsed = parseFrontmatter(
    "---\nid: bad\nblocked_by: [\"upstream: no hook, and no ETA\", real-plan]\n---\n# T\n");
  assert.deepEqual(quotedParsed.frontmatter.blocked_by, ["upstream: no hook, and no ETA", "real-plan"]);

  assert.deepEqual(parseFrontmatter("---\nid: bad\nrelated: []\n---\n# T\n").frontmatter.related, []);

  // --- writeFrontmatterField: patches one scalar key, preserves everything else -----------------
  const rewritten = writeFrontmatterField(
    "---\nid: foo\npriority: low\nnext_action: do it\n---\n# Body\n\ntext\n",
    "priority",
    "high",
  );
  assert.match(rewritten, /priority: high/);
  assert.doesNotMatch(rewritten, /priority: low/);
  assert.match(rewritten, /id: foo/);
  assert.match(rewritten, /next_action: do it/);
  assert.match(rewritten, /# Body\n\ntext\n$/);
  assert.throws(() => writeFrontmatterField("no frontmatter", "priority", "high"), /missing frontmatter/);

  // Missing key entirely (not just an empty value) must be appended, not throw — a plan with no
  // `priority:` line renders the same "none" fallback as an empty one (buildPlanRecord's
  // `parsed.frontmatter.priority || "none"`), so the writer must be able to turn either into a
  // real on-disk value or the UI's "none" option would be unusable.
  const appended = writeFrontmatterField("---\nid: foo\n---\nbody", "priority", "high");
  assert.match(appended, /id: foo\npriority: high/);
  assert.match(appended, /---\nbody$/);

  // --- updatePlanPriority: mtime-checked read-modify-write against a real plan file --------------
  const readySnapshot = buildPlanSnapshot({ stateRoot, packageState: { available: true, enabled: false, status: "disabled" } });
  const readyRecord = readySnapshot.plans.find((item) => item.plan.id === "ready-plan");
  assert.equal(readyRecord.plan.priority, "high");
  assert.ok(Number.isFinite(readyRecord.mtimeMs), "expected mtimeMs on the public plan record");

  const priorityResult = updatePlanPriority(readySnapshot, {
    id: readyRecord.plan.id,
    key: readyRecord.key,
    priority: "low",
    expectedPriority: readyRecord.plan.priority,
    mtimeMs: readyRecord.mtimeMs,
  });
  assert.equal(priorityResult.change.property, "priority");
  assert.equal(priorityResult.change.previousValue, "high");
  assert.equal(priorityResult.change.newValue, "low");
  assert.equal(priorityResult.record.plan.priority, "low", "priority returns a complete rebuilt record, not just {priority, mtimeMs}");
  assert.equal(priorityResult.record.plan.id, "ready-plan");
  assert.ok(Number.isFinite(priorityResult.record.mtimeMs));
  const onDisk = fs.readFileSync(path.join(repo, "docs", "plans", "backlog", "ready.md"), "utf8");
  assert.match(onDisk, /priority: low/);
  assert.match(onDisk, /## Implementation plan/); // body untouched

  assert.throws(
    () => updatePlanPriority(readySnapshot, { id: readyRecord.plan.id, key: readyRecord.key, priority: "not-a-priority", expectedPriority: "low", mtimeMs: priorityResult.record.mtimeMs }),
    /invalid priority/,
  );

  // Stale conflict: mtime (as if another process/editor touched the file since it was loaded).
  assert.throws(() => {
    try {
      updatePlanPriority(readySnapshot, {
        id: readyRecord.plan.id,
        key: readyRecord.key,
        priority: "high",
        expectedPriority: "low",
        mtimeMs: readyRecord.mtimeMs, // stale, already advanced above
      });
    } catch (err) {
      assert.equal(err.code, "STALE_PLAN");
      assert.equal(err.status, 409);
      throw err;
    }
  }, /changed outside the portal/);

  // Stale conflict: expectedPriority mismatch alone (mtime happens to still match current disk
  // state — e.g. a concurrent request raced and won, then this one arrives with a now-wrong
  // expectation but a fresh mtime it never actually read).
  assert.throws(() => {
    try {
      updatePlanPriority(readySnapshot, {
        id: readyRecord.plan.id,
        key: readyRecord.key,
        priority: "high",
        expectedPriority: "medium", // wrong: current on-disk priority is "low"
        mtimeMs: priorityResult.record.mtimeMs,
      });
    } catch (err) {
      assert.equal(err.code, "STALE_PLAN");
      throw err;
    }
  }, /changed outside the portal/);

  // Regression: a plan with no `priority:` frontmatter key at all (displays as "none" via
  // buildPlanRecord's `|| "none"` fallback) must still be settable, not throw "key not found".
  const noPriorityRecord = readySnapshot.plans.find((item) => item.plan.id === "no-priority-plan");
  assert.equal(noPriorityRecord.plan.priority, "none");
  const noPriorityResult = updatePlanPriority(readySnapshot, {
    id: noPriorityRecord.plan.id,
    key: noPriorityRecord.key,
    priority: "high",
    expectedPriority: noPriorityRecord.plan.priority,
    mtimeMs: noPriorityRecord.mtimeMs,
  });
  assert.equal(noPriorityResult.record.plan.priority, "high");
  const noPriorityOnDisk = fs.readFileSync(path.join(repo, "docs", "plans", "backlog", "no-priority.md"), "utf8");
  assert.match(noPriorityOnDisk, /priority: high/);

  const portalFacing = spawnSync(process.execPath, [
    "-e",
    "import('./scripts/cli/plans.mjs').then((m) => { const snap = m.loadPlansSnapshot(); process.stdout.write(JSON.stringify(snap)); })",
  ], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."),
    env: {
      ...process.env,
      ROBOREPO_STATE_ROOT: stateRoot,
    },
    encoding: "utf8",
  });
  assert.equal(portalFacing.status, 0, portalFacing.stderr);
  const portalSnapshot = JSON.parse(portalFacing.stdout);
  assert.equal(portalSnapshot.repositories[0].root, undefined);
  assert.equal(portalSnapshot.plans[0].absolutePath, undefined);
  assert.equal(portalSnapshot.plans[0].repository.root, undefined);

  // CLI-boundary check: updatePlanPriority via scripts/cli/plans.mjs (not the domain module
  // directly) must strip absolutePath/repository.root from the returned record, exactly like a full
  // snapshot does — the doc's "public responses do not expose absolute paths" requirement applies at
  // this boundary, not just to buildPlanSnapshot's output.
  const noPriorityCliRecord = portalSnapshot.plans.find((item) => item.plan.id === "no-priority-plan");
  const priorityCliCheck = spawnSync(process.execPath, [
    "-e",
    `import('./scripts/cli/plans.mjs').then(async (m) => {
      const result = m.updatePlanPriority({
        id: ${JSON.stringify(noPriorityCliRecord.plan.id)},
        key: ${JSON.stringify(noPriorityCliRecord.key)},
        priority: "low",
        expectedPriority: ${JSON.stringify(noPriorityCliRecord.plan.priority)},
        mtimeMs: ${noPriorityCliRecord.mtimeMs},
      });
      process.stdout.write(JSON.stringify(result));
    })`,
  ], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."),
    env: { ...process.env, ROBOREPO_STATE_ROOT: stateRoot },
    encoding: "utf8",
  });
  assert.equal(priorityCliCheck.status, 0, priorityCliCheck.stderr);
  const priorityCliResult = JSON.parse(priorityCliCheck.stdout);
  assert.equal(priorityCliResult.change.newValue, "low");
  assert.equal(priorityCliResult.record.plan.priority, "low");
  assert.equal(priorityCliResult.record.absolutePath, undefined, "CLI-layer priority result must not expose absolutePath");
  assert.equal(priorityCliResult.record.repository.root, undefined, "CLI-layer priority result must not expose repository.root");

  // Regression: planWritePackage.enabled must track the package's real live-enabled state
  // (buildPackageLiveState, same source config.mjs's readConfigSnapshot uses), not the raw
  // catalog entry — the catalog entry never carries a `.status`/`.catalogStatus` field at all, so
  // reading those directly off it (the previous implementation) always evaluated to `enabled:
  // false` regardless of whether the package was actually enabled.
  {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-plan-suite-home-"));
    const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "cli", "main.mjs");
    fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(homeDir, ".claude", "settings.json"), "{}");
    fs.writeFileSync(path.join(homeDir, ".codex", "config.toml"), "");
    const env = {
      ...process.env,
      HOME: homeDir,
      ROBOREPO_STATE_DIR: path.join(homeDir, ".roborepo"),
      ROBOREPO_STATE_ROOT: path.join(homeDir, ".roborepo"),
      SKIP_MCP: "1",
    };
    const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

    const readSnapshotEnabled = () => {
      const result = spawnSync(process.execPath, [
        "-e",
        "import('./scripts/cli/plans.mjs').then((m) => { process.stdout.write(JSON.stringify(m.loadPlansSnapshot().planWritePackage)); })",
      ], { cwd, env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };

    const beforeEnable = readSnapshotEnabled();
    assert.equal(beforeEnable.enabled, false, "plan-write starts disabled in a fresh HOME");

    spawnSync(process.execPath, [cliPath, "package", "enable", "plan-write"], { env, stdio: "ignore" });
    const afterEnable = readSnapshotEnabled();
    assert.equal(afterEnable.enabled, true, "planWritePackage.enabled reflects the real live-enabled state after `roborepo package enable plan-write`");

    spawnSync(process.execPath, [cliPath, "package", "disable", "plan-write"], { env, stdio: "ignore" });
    const afterDisable = readSnapshotEnabled();
    assert.equal(afterDisable.enabled, false, "planWritePackage.enabled reflects disabled state after `roborepo package disable plan-write`");

    fs.rmSync(homeDir, { recursive: true, force: true });
  }

  // --- repository discovery traversal (recursive walk rewrite) ---------------------------------
  const traversalRoot = path.join(tempRoot, "traversal");

  // Nested repo discovery: a repo 2+ levels deep under the discovery root must be found.
  const nested = path.join(traversalRoot, "group-a", "group-b", "nested-repo");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, ".git"), "gitdir: nowhere\n");

  // Stop-at-first-.git: a subfolder of a repo must NOT be double-counted as its own repo root,
  // even though it satisfies candidateRepository's docs/plans check.
  fs.mkdirSync(path.join(nested, "docs", "plans"), { recursive: true });
  fs.mkdirSync(path.join(nested, "vendor", "docs", "plans"), { recursive: true }); // also blacklist-covered

  // Blacklist bail-out: a repo living inside an ignored directory name must not be discovered.
  const blacklisted = path.join(traversalRoot, "node_modules", "should-not-be-found");
  fs.mkdirSync(blacklisted, { recursive: true });
  fs.writeFileSync(path.join(blacklisted, ".git"), "gitdir: nowhere\n");
  const cacheBlacklisted = path.join(traversalRoot, ".cache", "also-should-not-be-found");
  fs.mkdirSync(cacheBlacklisted, { recursive: true });
  fs.writeFileSync(path.join(cacheBlacklisted, ".git"), "gitdir: nowhere\n");

  const discovery = walkRepositoryRoots([traversalRoot]);
  assert.equal(discovery.repositories.length, 1, "expected exactly one discovered repo (nested-repo), got: " + JSON.stringify(discovery.repositories));
  assert.equal(path.basename(discovery.repositories[0]), "nested-repo");
  assert.equal(discovery.truncated, false);

  // Linked worktree discovery: a worktree nested under a configured parent must not show as a
  // duplicate repo/plan source. The primary worktree remains visible.
  const worktreeParent = path.join(tempRoot, "worktree-parent");
  const primaryWorktree = path.join(worktreeParent, "primary");
  const linkedWorktree = path.join(worktreeParent, "feature");
  fs.mkdirSync(path.join(primaryWorktree, "docs", "plans", "backlog"), { recursive: true });
  fs.writeFileSync(path.join(primaryWorktree, "docs", "plans", "backlog", "root.md"), "# Root plan\n");
  const gitInit = spawnSync("git", ["init", "-b", "main"], { cwd: primaryWorktree, encoding: "utf8" });
  if (gitInit.status === 0) {
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: primaryWorktree, stdio: "ignore" });
    spawnSync("git", ["config", "user.name", "RoboRepo Test"], { cwd: primaryWorktree, stdio: "ignore" });
    const commit = spawnSync("git", ["add", "."], { cwd: primaryWorktree, encoding: "utf8" });
    const committed = commit.status === 0 && spawnSync("git", ["commit", "-m", "seed"], { cwd: primaryWorktree, encoding: "utf8" }).status === 0;
    const added = committed && spawnSync("git", ["worktree", "add", "-b", "feature", linkedWorktree], { cwd: primaryWorktree, encoding: "utf8" }).status === 0;
    if (added) {
      const worktreeDiscovery = walkRepositoryRoots([worktreeParent], { ignored: [] });
      assert.deepEqual(worktreeDiscovery.repositories, [fs.realpathSync(primaryWorktree)]);
    }
  }

  // Depth cap: a repo deeper than DISCOVERY_MAX_DEPTH (6) below the root must not be found.
  const deepRoot = path.join(tempRoot, "deep");
  const tooDeepSegments = Array.from({ length: 8 }, (_, i) => `d${i}`);
  const tooDeepRepo = path.join(deepRoot, ...tooDeepSegments);
  fs.mkdirSync(tooDeepRepo, { recursive: true });
  fs.writeFileSync(path.join(tooDeepRepo, ".git"), "gitdir: nowhere\n");
  const deepDiscovery = walkRepositoryRoots([deepRoot]);
  assert.equal(deepDiscovery.repositories.length, 0, "repo beyond the depth cap should not be found");

  // Time-budget truncation: force the budget to ~0ms via env override so the walk's first
  // deadline check trips immediately, without needing a real slow scan or a huge synthetic tree.
  const budgetCheck = spawnSync(process.execPath, [
    "-e",
    "import('./modules/repositories/index.mjs').then((m) => { const d = m.walkRepositoryRoots([process.env.TRAVERSAL_ROOT]); process.stdout.write(JSON.stringify(d)); })",
  ], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."),
    env: { ...process.env, DISCOVERY_TIME_BUDGET_MS: "0", TRAVERSAL_ROOT: traversalRoot },
    encoding: "utf8",
  });
  assert.equal(budgetCheck.status, 0, budgetCheck.stderr);
  const budgetResult = JSON.parse(budgetCheck.stdout);
  assert.equal(budgetResult.truncated, true, "expected truncation with a ~0ms time budget");

  // Referential integrity across every id-bearing field. This is the check that actually catches a
  // wrong id: the INVALID_ID format rule only rejects a malformed one, so a transposed character in
  // an otherwise well-formed id passes it and resolves to nothing. `related` and `blocked_by` went
  // unvalidated for a long time, which is how ten dangling references accumulated in this repo.
  const refsRepo = path.join(projects, "refs");
  fs.mkdirSync(path.join(refsRepo, "docs", "plans", "backlog"), { recursive: true });
  fs.writeFileSync(path.join(refsRepo, ".git"), "gitdir: nowhere\n");
  const refsPlan = (id, extra) => `---
id: ${id}
priority: high
next_action: Do the thing
${extra}
reviewed_commit:
---
# ${id}

## Summary

Body.

## Context

Body.

## Implementation plan

- [ ] Task

## Validation

- [ ] Check
`;
  fs.writeFileSync(path.join(refsRepo, "docs", "plans", "backlog", "target.md"),
    refsPlan("real-target", "blocked_by: []\ndepends_on: []\nrelated: []"));
  fs.writeFileSync(path.join(refsRepo, "docs", "plans", "backlog", "source.md"),
    refsPlan("ref-source", [
      "blocked_by:",
      "  - real-target",
      "  - ghost-blocker",
      "depends_on:",
      "  - real-target",
      "  - ghost-dep",
      "related:",
      "  - real-target",
      "  - ghost-related",
    ].join("\n")));

  const refsStateRoot = path.join(tempRoot, "refs-state");
  addRepositorySource({ path: refsRepo, stateRoot: refsStateRoot });
  const refsSnapshot = buildPlanSnapshot({ stateRoot: refsStateRoot });
  const sourceRecord = refsSnapshot.plans.find((item) => item.plan.id === "ref-source");
  assert.ok(sourceRecord, "expected the referencing plan in the snapshot");
  const refCodes = sourceRecord.plan.validation.findings
    .filter((item) => item.code.endsWith("_NOT_FOUND"))
    .map((item) => item.code)
    .sort();
  assert.deepEqual(refCodes, ["BLOCKER_NOT_FOUND", "DEPENDENCY_NOT_FOUND", "RELATED_NOT_FOUND"],
    "every id-bearing field must report an unresolvable reference");
  const ghostNames = sourceRecord.plan.validation.findings
    .filter((item) => item.code.endsWith("_NOT_FOUND"))
    .map((item) => item.message);
  assert.ok(ghostNames.every((message) => message.includes("ghost-")),
    "findings must name the unresolvable id, not the valid sibling in the same field");
  const targetRecord = refsSnapshot.plans.find((item) => item.plan.id === "real-target");
  assert.equal(targetRecord.plan.validation.findings.filter((item) => item.code.endsWith("_NOT_FOUND")).length, 0,
    "a plan whose references all resolve must report no dangling-reference findings");

  // A blocker with an external prefix names something that has no plan document, so there is
  // nothing to resolve it against. Only blocked_by may carry one.
  fs.writeFileSync(path.join(refsRepo, "docs", "plans", "backlog", "external.md"),
    refsPlan("ext-source", [
      "blocked_by:",
      "  - \"upstream: Codex has no footer-command hook\"",
      "  - external: vendor has not shipped the API",
      "  - ghost-plan",
      "depends_on: []",
      "related: []",
    ].join("\n")));
  const extSnapshot = buildPlanSnapshot({ stateRoot: refsStateRoot });
  const extRecord = extSnapshot.plans.find((item) => item.plan.id === "ext-source");
  const extBlockerFindings = extRecord.plan.validation.findings.filter((item) => item.code === "BLOCKER_NOT_FOUND");
  assert.equal(extBlockerFindings.length, 1, "only the plan-id blocker should fail to resolve");
  assert.match(extBlockerFindings[0].message, /ghost-plan/,
    "prefixed external blockers must be skipped, not reported as missing plans");

} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log("ok: plan docs behavior");
