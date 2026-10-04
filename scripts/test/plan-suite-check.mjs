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
  discoverRepositories,
  movePlanLifecycle,
  parseFrontmatter,
  readPlanDocument,
  updatePlanPriority,
  writeFrontmatterField,
  writePlanSettings,
} from "../../modules/plan-suite/index.mjs";

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
  // Fully-ready plan: satisfies backlog, active, completed, and archived destination
  // requirements at once (all tasks checked, has a Verification section, next_action can be
  // cleared before the archived-destination assertion) — used to exercise movePlanLifecycle
  // across every canonical source/destination pair without hand-writing 12 fixtures.
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

Prove movePlanLifecycle works for every canonical destination.

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
  writePlanSettings({ stateRoot, discoveryRoots: [projects] });

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
  const prompt = buildPrompt("plan-start", [ready], { mode: "repository-aware" });
  assert.match(prompt, /^\/plan-start\n/);
  assert.match(prompt, /docs\/plans\/backlog\/ready.md/);
  const portablePrompt = buildPrompt(null, [ready], { mode: "portable" });
  assert.match(portablePrompt, /^Use this bounded portable plan context/);
  assert.doesNotMatch(buildPrompt("start", [ready]), /^\//m, "a retired mode name produces no slash command");

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

  // --- movePlanLifecycle: file movement, validation, and stale-conflict handling -----------------
  const moveSnapshot = buildPlanSnapshot({ stateRoot, packageState: { available: true, enabled: false, status: "disabled" } });
  const movable = moveSnapshot.plans.find((item) => item.plan.id === "movable-plan");
  assert.equal(movable.plan.lifecycle, "backlog");

  // Unclassified is never a valid destination.
  assert.throws(() => movePlanLifecycle(moveSnapshot, {
    id: movable.plan.id, key: movable.key, lifecycle: "unclassified", expectedLifecycle: "backlog", mtimeMs: movable.mtimeMs,
  }), (err) => err.code === "INVALID_CHANGE");

  // Same-lifecycle move is rejected rather than treated as a silent no-op.
  assert.throws(() => movePlanLifecycle(moveSnapshot, {
    id: movable.plan.id, key: movable.key, lifecycle: "backlog", expectedLifecycle: "backlog", mtimeMs: movable.mtimeMs,
  }), (err) => err.code === "INVALID_CHANGE");

  // Full tour: backlog -> active -> completed -> archived -> backlog. Each move rebuilds the
  // snapshot from disk first, mirroring how the CLI layer re-resolves cachedSnapshot per request
  // (movePlanLifecycle never mutates the snapshot object it's given — the caller is expected to
  // treat it as a point-in-time read, exactly like a real portal request cycle).
  let current = movable;
  const tour = ["active", "completed", "archived", "backlog"];
  for (const destination of tour) {
    const before = current;
    // Completed forbids next_action; archived forbids it too. Backlog/active require it. Patch
    // the on-disk field immediately before each hop so the fixture satisfies whichever
    // destination is next, mirroring a real user editing the doc between lifecycle moves.
    const currentPath = path.join(repo, "docs", "plans", before.plan.lifecycle, "movable.md");
    const currentMarkdown = fs.readFileSync(currentPath, "utf8");
    const needsNextAction = destination === "active" || destination === "backlog";
    fs.writeFileSync(currentPath, writeFrontmatterField(currentMarkdown, "next_action", needsNextAction ? "Move this plan around in tests." : ""));
    const tourSnapshot = buildPlanSnapshot({ stateRoot, packageState: { available: true, enabled: false, status: "disabled" } });
    const refreshedBefore = tourSnapshot.plans.find((item) => item.plan.id === "movable-plan");
    const moveResult = movePlanLifecycle(tourSnapshot, {
      id: refreshedBefore.plan.id,
      key: refreshedBefore.key,
      lifecycle: destination,
      expectedLifecycle: refreshedBefore.plan.lifecycle,
      mtimeMs: refreshedBefore.mtimeMs,
      repositoryId: refreshedBefore.repository.id,
    });
    assert.equal(moveResult.change.property, "lifecycle");
    assert.equal(moveResult.change.previousValue, before.plan.lifecycle);
    assert.equal(moveResult.change.newValue, destination);
    assert.equal(moveResult.record.plan.lifecycle, destination);
    assert.equal(moveResult.record.plan.id, "movable-plan", "stable id unchanged after movement");
    assert.notEqual(moveResult.record.key, before.key, "key changed after movement");
    assert.match(moveResult.record.plan.relativePath, new RegExp(`^docs/plans/${destination}/movable\\.md$`));
    assert.ok(!fs.existsSync(path.join(repo, "docs", "plans", before.plan.lifecycle, "movable.md")), "source removed");
    assert.ok(fs.existsSync(path.join(repo, "docs", "plans", destination, "movable.md")), "destination created");
    const movedOnDisk = fs.readFileSync(path.join(repo, "docs", "plans", destination, "movable.md"), "utf8");
    assert.match(movedOnDisk, /id: movable-plan/, "frontmatter unchanged by lifecycle movement");
    // openTasks is the list snapshot's active-only payload, feeding the portal's All Open Tasks
    // dialog without a per-plan fetch. The tour crosses the active boundary in both directions,
    // which is what makes it the right place to pin the scoping: carrying task text for every
    // lifecycle would roughly triple the field's cost to serve a view that only reads active.
    // This fixture's only task is `- [x]`, so it also pins the completed-item filter: even on
    // active, a finished task must not appear. The open-task case is covered by
    // testActivePlanShipsItsOpenTaskText below, against a fixture that has one.
    const openTasks = moveResult.record.plan.openTasks;
    assert.ok(Array.isArray(openTasks), "every plan record must carry an openTasks array");
    assert.equal(openTasks.length, 0,
      destination === "active"
        ? "a completed task must be excluded from openTasks even on active"
        : `${destination} must not carry task text — the dialog is active-only`);
    current = moveResult.record;
  }

  // Unclassified source -> canonical destination.
  const rootPlanBefore = moveSnapshot.plans.find((item) => item.plan.relativePath.endsWith("root.md"));
  assert.equal(rootPlanBefore.plan.lifecycle, "unclassified");
  const rootMoveResult = movePlanLifecycle(moveSnapshot, {
    id: rootPlanBefore.plan.id || undefined,
    key: rootPlanBefore.key,
    lifecycle: "backlog",
    expectedLifecycle: "unclassified",
    mtimeMs: rootPlanBefore.mtimeMs,
    skipDestinationValidation: true, // root.md has no frontmatter/headings at all
  });
  assert.equal(rootMoveResult.record.plan.lifecycle, "backlog");
  assert.ok(fs.existsSync(path.join(repo, "docs", "plans", "backlog", "root.md")));

  // Destination collision: pre-occupy the target path, confirm neither file moves.
  fs.writeFileSync(path.join(repo, "docs", "plans", "backlog", "collide-active.md"), "# placeholder\n");
  fs.mkdirSync(path.join(repo, "docs", "plans", "active"), { recursive: true });
  fs.writeFileSync(path.join(repo, "docs", "plans", "active", "collide-active.md"), "# occupies destination\n");
  const collisionSnapshot = buildPlanSnapshot({ stateRoot, packageState: { available: true, enabled: false, status: "disabled" } });
  const collideSource = collisionSnapshot.plans.find((item) => item.plan.relativePath.endsWith("collide-active.md") && item.plan.lifecycle === "backlog");
  assert.throws(() => movePlanLifecycle(collisionSnapshot, {
    id: collideSource.plan.id || undefined,
    key: collideSource.key,
    lifecycle: "active",
    expectedLifecycle: "backlog",
    mtimeMs: collideSource.mtimeMs,
    skipDestinationValidation: true,
  }), (err) => err.code === "DESTINATION_EXISTS");
  assert.ok(fs.existsSync(path.join(repo, "docs", "plans", "backlog", "collide-active.md")), "source untouched after rejected collision");
  assert.match(fs.readFileSync(path.join(repo, "docs", "plans", "active", "collide-active.md"), "utf8"), /occupies destination/, "destination untouched after rejected collision");

  // Stale conflicts: mtime, lifecycle, and key/path (via a wrong id+key combo) all rejected.
  const staleSnapshot = buildPlanSnapshot({ stateRoot, packageState: { available: true, enabled: false, status: "disabled" } });
  const staleSource = staleSnapshot.plans.find((item) => item.plan.id === "ready-plan");
  assert.throws(() => movePlanLifecycle(staleSnapshot, {
    id: staleSource.plan.id, key: staleSource.key, lifecycle: "active", expectedLifecycle: "backlog", mtimeMs: staleSource.mtimeMs - 1,
  }), (err) => err.code === "STALE_PLAN");
  assert.throws(() => movePlanLifecycle(staleSnapshot, {
    id: staleSource.plan.id, key: staleSource.key, lifecycle: "active", expectedLifecycle: "active" /* wrong: it's backlog */, mtimeMs: staleSource.mtimeMs,
  }), (err) => err.code === "STALE_PLAN");

  // File moved externally (outside the portal) between snapshot build and the mutation request:
  // the mtime/path check must catch it and report STALE_PLAN, not a generic filesystem error.
  const externalSnapshot = buildPlanSnapshot({ stateRoot, packageState: { available: true, enabled: false, status: "disabled" } });
  const externalSource = externalSnapshot.plans.find((item) => item.plan.id === "ready-plan");
  fs.renameSync(
    path.join(repo, "docs", "plans", "backlog", "ready.md"),
    path.join(repo, "docs", "plans", "archived", "ready.md"),
  );
  assert.throws(() => movePlanLifecycle(externalSnapshot, {
    id: externalSource.plan.id, key: externalSource.key, lifecycle: "active", expectedLifecycle: "backlog", mtimeMs: externalSource.mtimeMs,
  }), (err) => err.code === "STALE_PLAN");
  // Restore for subsequent assertions to keep fixture state predictable.
  fs.renameSync(
    path.join(repo, "docs", "plans", "archived", "ready.md"),
    path.join(repo, "docs", "plans", "backlog", "ready.md"),
  );

  // Lifecycle requirement errors are returned together, not fail-fast on the first violation.
  const requirementsSnapshot = buildPlanSnapshot({ stateRoot, packageState: { available: true, enabled: false, status: "disabled" } });
  const requirementsSource = requirementsSnapshot.plans.find((item) => item.plan.id === "no-priority-plan");
  assert.throws(() => {
    try {
      movePlanLifecycle(requirementsSnapshot, {
        id: requirementsSource.plan.id,
        key: requirementsSource.key,
        lifecycle: "completed",
        expectedLifecycle: "backlog",
        mtimeMs: requirementsSource.mtimeMs,
      });
    } catch (err) {
      assert.equal(err.code, "LIFECYCLE_REQUIREMENTS");
      assert.equal(err.status, 422);
      assert.ok(err.details.length > 1, `expected multiple accumulated requirement failures, got: ${JSON.stringify(err.details)}`);

      // The full wire contract the portal depends on: display strings, structured findings, and
      // the server-generated repair prompt, all from this one response.
      assert.ok(Array.isArray(err.findings), "a readiness failure carries structured findings");
      assert.equal(err.findings.length, err.details.length, "every display string has a matching finding");
      assert.deepEqual(err.findings.map((item) => item.message), err.details,
        "details is exactly the message projection of findings — the two cannot describe different problems");
      for (const item of err.findings) {
        assert.ok(item.code, "every finding carries a stable code the UI and tests can branch on");
        assert.ok(item.resolution, "every finding explains how to fix it");
      }

      assert.ok(err.repair, "a readiness failure carries a repair descriptor");
      assert.equal(typeof err.repair.prompt, "string", "the repair prompt is a ready-to-copy string");
      assert.ok(err.repair.prompt.length > 0, "the repair prompt is not empty");
      assert.equal(err.repair.planKey, requirementsSource.key, "the descriptor identifies which plan it describes");
      assert.equal(err.repair.planId, requirementsSource.plan.id, "the descriptor carries the stable plan id");
      for (const item of err.findings) {
        assert.ok(err.repair.prompt.includes(item.message),
          `the prompt must describe every finding shown to the user; missing: ${item.code}`);
      }
      assert.ok(!err.repair.prompt.includes(tempRoot),
        "the repair prompt must not leak an absolute path — it gets pasted outside this machine");
      throw err;
    }
  }, /Couldn't move/);
  assert.ok(fs.existsSync(path.join(repo, "docs", "plans", "backlog", "no-priority.md")), "failed validation leaves source file unmoved");

  // Completed's Verification requirement checks for real content, not just a bare heading. A plan
  // that otherwise satisfies every Completed requirement (all tasks checked, no next_action, no
  // blockers) but whose "## Verification" section has nothing under it before the next heading
  // must still be rejected — heading presence alone used to be sufficient here.
  fs.writeFileSync(path.join(repo, "docs", "plans", "backlog", "empty-verification.md"), `---
id: empty-verification-plan
priority: medium
next_action:
blocked_by: []
depends_on: []
related: []
reviewed_commit:
---
# Empty Verification Plan

## Summary

Exercises the empty-Verification-body rejection.

## Context

Used only by plan-suite-check.mjs.

## Goals

Prove an empty Verification section fails Completed validation.

## Proposed design

N/A.

## Implementation plan

- [x] Nothing left to do

## Verification

## Validation

N/A.
`);
  const emptyVerificationSnapshot = buildPlanSnapshot({ stateRoot, packageState: { available: true, enabled: false, status: "disabled" } });
  const emptyVerificationSource = emptyVerificationSnapshot.plans.find((item) => item.plan.id === "empty-verification-plan");
  assert.throws(() => {
    try {
      movePlanLifecycle(emptyVerificationSnapshot, {
        id: emptyVerificationSource.plan.id,
        key: emptyVerificationSource.key,
        lifecycle: "completed",
        expectedLifecycle: "backlog",
        mtimeMs: emptyVerificationSource.mtimeMs,
      });
    } catch (err) {
      assert.equal(err.code, "LIFECYCLE_REQUIREMENTS");
      assert.ok(err.details.some((d) => /Verification/.test(d)), `expected a Verification requirement failure, got: ${JSON.stringify(err.details)}`);
      throw err;
    }
  }, /Couldn't move/);
  assert.ok(fs.existsSync(path.join(repo, "docs", "plans", "backlog", "empty-verification.md")), "failed validation leaves source file unmoved");

  // Filling in real content under the same heading is now sufficient to pass.
  fs.writeFileSync(
    path.join(repo, "docs", "plans", "backlog", "empty-verification.md"),
    fs.readFileSync(path.join(repo, "docs", "plans", "backlog", "empty-verification.md"), "utf8")
      .replace("## Verification\n\n## Validation", "## Verification\n\nVerified manually by the test itself.\n\n## Validation"),
  );
  const filledVerificationSnapshot = buildPlanSnapshot({ stateRoot, packageState: { available: true, enabled: false, status: "disabled" } });
  const filledVerificationSource = filledVerificationSnapshot.plans.find((item) => item.plan.id === "empty-verification-plan");
  const filledVerificationResult = movePlanLifecycle(filledVerificationSnapshot, {
    id: filledVerificationSource.plan.id,
    key: filledVerificationSource.key,
    lifecycle: "completed",
    expectedLifecycle: "backlog",
    mtimeMs: filledVerificationSource.mtimeMs,
  });
  assert.equal(filledVerificationResult.record.plan.lifecycle, "completed");

  // Readiness validation reads the file from disk, not the snapshot record. A document repaired
  // after the page loaded must move on the next attempt without a refresh — this is what makes
  // the repair-prompt workflow work: fix the doc, retry, done.
  fs.writeFileSync(path.join(repo, "docs", "plans", "backlog", "stale-then-repaired.md"), `---
id: stale-then-repaired-plan
priority: medium
next_action: Finish the work
blocked_by: []
depends_on: []
related: []
reviewed_commit:
---
# Stale Then Repaired Plan

## Summary

Exercises validation reading fresh disk content rather than the loaded snapshot.

## Context

Used only by plan-suite-check.mjs.

## Goals

Prove a repaired document moves without rebuilding the snapshot first.

## Proposed design

N/A.

## Implementation plan

- [ ] Unfinished on purpose

## Validation

N/A.
`);
  const freshDiskSnapshot = buildPlanSnapshot({ stateRoot, packageState: { available: true, enabled: false, status: "disabled" } });
  const freshDiskSource = freshDiskSnapshot.plans.find((item) => item.plan.id === "stale-then-repaired-plan");
  assert.throws(() => movePlanLifecycle(freshDiskSnapshot, {
    id: freshDiskSource.plan.id,
    key: freshDiskSource.key,
    lifecycle: "completed",
    expectedLifecycle: "backlog",
    mtimeMs: freshDiskSource.mtimeMs,
  }), (err) => err.code === "LIFECYCLE_REQUIREMENTS", "an unfinished plan is rejected for Completed");

  // Repair the document on disk while still holding the now-outdated snapshot above.
  const repairedPath = path.join(repo, "docs", "plans", "backlog", "stale-then-repaired.md");
  fs.writeFileSync(repairedPath, fs.readFileSync(repairedPath, "utf8")
    .replace("next_action: Finish the work\n", "next_action:\n")
    .replace("- [ ] Unfinished on purpose", "- [x] Now finished")
    .replace("## Validation", "## Verification\n\nVerified by the test.\n\n## Validation"));
  // Retry the way the portal does after an external edit: refresh, then move. The refreshed
  // snapshot still carries the pre-repair findings on its record — buildPlanSnapshot validated
  // against `backlog`, where unchecked tasks are not a problem — so a move that succeeds here
  // proves the gate re-read the file rather than trusting record.plan.validation.
  const repairedSnapshot = buildPlanSnapshot({ stateRoot, packageState: { available: true, enabled: false, status: "disabled" } });
  const repairedSource = repairedSnapshot.plans.find((item) => item.plan.id === "stale-then-repaired-plan");
  const repairedResult = movePlanLifecycle(repairedSnapshot, {
    id: repairedSource.plan.id,
    key: repairedSource.key,
    lifecycle: "completed",
    expectedLifecycle: "backlog",
    mtimeMs: repairedSource.mtimeMs,
  });
  assert.equal(repairedResult.record.plan.lifecycle, "completed",
    "a document repaired after the failed attempt moves on retry, with no bypass flag");

  // The unambiguous direction: build a snapshot from a document that validates, then break the
  // document on disk. The snapshot record still says it is fine, so a rejection here can only
  // come from re-reading the file.
  const brokenPath = path.join(repo, "docs", "plans", "backlog", "broken-after-scan.md");
  fs.writeFileSync(brokenPath, fs.readFileSync(repairedPath.replace("backlog", "completed"), "utf8")
    .replace("id: stale-then-repaired-plan", "id: broken-after-scan-plan"));
  const beforeBreakSnapshot = buildPlanSnapshot({ stateRoot, packageState: { available: true, enabled: false, status: "disabled" } });
  const beforeBreakSource = beforeBreakSnapshot.plans.find((item) => item.plan.id === "broken-after-scan-plan");
  assert.ok(beforeBreakSource, "the fixture is present in the snapshot before it is broken");
  // Rewrite in place, restoring mtime so the stale-state guard sees a current request and
  // readiness validation is what decides. Without this the stale check fires first (as it should
  // — that ordering is asserted below) and never exercises the fresh-disk read.
  const beforeBreakStat = fs.statSync(brokenPath);
  fs.writeFileSync(brokenPath, fs.readFileSync(brokenPath, "utf8")
    .replace("- [x] Now finished", "- [ ] Reopened after the scan"));
  fs.utimesSync(brokenPath, beforeBreakStat.atime, beforeBreakStat.mtime);
  assert.throws(() => {
    try {
      movePlanLifecycle(beforeBreakSnapshot, {
        id: beforeBreakSource.plan.id,
        key: beforeBreakSource.key,
        lifecycle: "completed",
        expectedLifecycle: "backlog",
        mtimeMs: beforeBreakSource.mtimeMs,
      });
    } catch (err) {
      assert.equal(err.code, "LIFECYCLE_REQUIREMENTS",
        "an edit made after the snapshot was built is caught, so findings always describe current disk content");
      assert.ok(err.details.some((detail) => /unchecked/.test(detail)), "the reopened task is what was reported");
      throw err;
    }
  }, /Couldn't move/);

  // Ordering: stale-state and collision checks run before readiness validation, so a request that
  // is stale or wrongly targeted gets that answer rather than repair guidance for a plan the user
  // is no longer looking at. Both must therefore arrive without a repair descriptor.
  fs.writeFileSync(path.join(repo, "docs", "plans", "backlog", "ordering.md"), `---
id: ordering-plan
priority: medium
next_action: Something
blocked_by: []
depends_on: []
related: []
reviewed_commit:
---
# Ordering Plan

## Implementation plan

- [ ] Deliberately unfinished
`);
  const orderingSnapshot = buildPlanSnapshot({ stateRoot, packageState: { available: true, enabled: false, status: "disabled" } });
  const orderingSource = orderingSnapshot.plans.find((item) => item.plan.id === "ordering-plan");
  assert.throws(() => {
    try {
      movePlanLifecycle(orderingSnapshot, {
        id: orderingSource.plan.id,
        key: orderingSource.key,
        lifecycle: "completed",
        expectedLifecycle: "backlog",
        mtimeMs: orderingSource.mtimeMs - 1000, // stale, and the document is also invalid
      });
    } catch (err) {
      assert.equal(err.code, "STALE_PLAN", "a stale request is rejected before readiness is evaluated");
      assert.equal(err.repair, undefined, "no repair prompt is offered for a plan the user may no longer be viewing");
      throw err;
    }
  }, /changed outside the portal/);

  fs.mkdirSync(path.join(repo, "docs", "plans", "completed"), { recursive: true });
  fs.writeFileSync(path.join(repo, "docs", "plans", "completed", "ordering.md"), "placeholder occupying the destination\n");
  assert.throws(() => {
    try {
      movePlanLifecycle(orderingSnapshot, {
        id: orderingSource.plan.id,
        key: orderingSource.key,
        lifecycle: "completed",
        expectedLifecycle: "backlog",
        mtimeMs: orderingSource.mtimeMs,
      });
    } catch (err) {
      assert.equal(err.code, "DESTINATION_EXISTS", "a collision is reported before readiness is evaluated");
      assert.equal(err.repair, undefined, "no repair prompt is offered when the move could not land regardless");
      throw err;
    }
  }, /already exists at the destination/);
  fs.rmSync(path.join(repo, "docs", "plans", "completed", "ordering.md"));

  const portalFacing = spawnSync(process.execPath, [
    "-e",
    "import('./scripts/cli/plans.mjs').then((m) => { const snap = m.loadPlansSnapshot(); process.stdout.write(JSON.stringify(snap)); })",
  ], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."),
    env: {
      ...process.env,
      ROBOREPO_STATE_ROOT: stateRoot,
      ROBOREPO_PLAN_ROOTS: projects,
    },
    encoding: "utf8",
  });
  assert.equal(portalFacing.status, 0, portalFacing.stderr);
  const portalSnapshot = JSON.parse(portalFacing.stdout);
  assert.equal(portalSnapshot.repositories[0].root, undefined);
  assert.equal(portalSnapshot.plans[0].absolutePath, undefined);
  assert.equal(portalSnapshot.plans[0].repository.root, undefined);

  // CLI-boundary check: updatePlanLifecycle/updatePlanPriority via scripts/cli/plans.mjs (not the
  // domain module directly) must strip absolutePath/repository.root from the returned record,
  // exactly like a full snapshot does — the doc's "public responses do not expose absolute paths"
  // requirement applies at this boundary, not just to buildPlanSnapshot's output.
  const noPriorityCliRecord = portalSnapshot.plans.find((item) => item.plan.id === "no-priority-plan");
  const lifecycleCliCheck = spawnSync(process.execPath, [
    "-e",
    `import('./scripts/cli/plans.mjs').then(async (m) => {
      const result = m.updatePlanLifecycle({
        id: ${JSON.stringify(noPriorityCliRecord.plan.id)},
        key: ${JSON.stringify(noPriorityCliRecord.key)},
        lifecycle: "active",
        expectedLifecycle: ${JSON.stringify(noPriorityCliRecord.plan.lifecycle)},
        mtimeMs: ${noPriorityCliRecord.mtimeMs},
      });
      process.stdout.write(JSON.stringify(result));
    })`,
  ], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."),
    env: { ...process.env, ROBOREPO_STATE_ROOT: stateRoot, ROBOREPO_PLAN_ROOTS: projects },
    encoding: "utf8",
  });
  assert.equal(lifecycleCliCheck.status, 0, lifecycleCliCheck.stderr);
  const lifecycleCliResult = JSON.parse(lifecycleCliCheck.stdout);
  assert.equal(lifecycleCliResult.change.newValue, "active");
  assert.equal(lifecycleCliResult.record.plan.lifecycle, "active");
  assert.equal(lifecycleCliResult.record.absolutePath, undefined, "CLI-layer lifecycle result must not expose absolutePath");
  assert.equal(lifecycleCliResult.record.repository.root, undefined, "CLI-layer lifecycle result must not expose repository.root");
  assert.ok(fs.existsSync(path.join(repo, "docs", "plans", "active", "no-priority.md")));

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

  const traversalSettings = { discoveryRoots: [traversalRoot], ignoredDirectories: undefined };
  const discovery = discoverRepositories(traversalSettings);
  assert.equal(discovery.repositories.length, 1, "expected exactly one discovered repo (nested-repo), got: " + JSON.stringify(discovery.repositories.map((r) => r.name)));
  assert.equal(discovery.repositories[0].name, "nested-repo");
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
      const worktreeDiscovery = discoverRepositories({ discoveryRoots: [worktreeParent], ignoredDirectories: [] });
      assert.deepEqual(worktreeDiscovery.repositories.map((item) => item.root), [fs.realpathSync(primaryWorktree)]);
    }
  }

  // Depth cap: a repo deeper than DISCOVERY_MAX_DEPTH (6) below the root must not be found.
  const deepRoot = path.join(tempRoot, "deep");
  const tooDeepSegments = Array.from({ length: 8 }, (_, i) => `d${i}`);
  const tooDeepRepo = path.join(deepRoot, ...tooDeepSegments);
  fs.mkdirSync(tooDeepRepo, { recursive: true });
  fs.writeFileSync(path.join(tooDeepRepo, ".git"), "gitdir: nowhere\n");
  const deepDiscovery = discoverRepositories({ discoveryRoots: [deepRoot], ignoredDirectories: undefined });
  assert.equal(deepDiscovery.repositories.length, 0, "repo beyond the depth cap should not be found");

  // Time-budget truncation: force the budget to ~0ms via env override so the walk's first
  // deadline check trips immediately, without needing a real slow scan or a huge synthetic tree.
  const budgetCheck = spawnSync(process.execPath, [
    "-e",
    "import('./modules/plan-suite/index.mjs').then((m) => { const d = m.discoverRepositories({ discoveryRoots: [process.env.TRAVERSAL_ROOT], ignoredDirectories: undefined }); process.stdout.write(JSON.stringify(d)); })",
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
  writePlanSettings({ stateRoot: refsStateRoot, discoveryRoots: [refsRepo] });
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

  // The positive half of the openTasks contract: an active plan with unchecked items ships their
  // text, in document order, with the completed ones filtered out. Its own repository and state
  // root so it cannot disturb the plan counts the fixtures above assert on.
  const tasksStateRoot = path.join(tempRoot, "state-tasks");
  const tasksRepo = path.join(tempRoot, "projects-tasks", "sample");
  fs.mkdirSync(path.join(tasksRepo, "docs", "plans", "active"), { recursive: true });
  fs.writeFileSync(path.join(tasksRepo, ".git"), "gitdir: nowhere\n");
  fs.writeFileSync(path.join(tasksRepo, "docs", "plans", "active", "tasks.md"), `---
id: tasks-plan
priority: high
next_action: Ship the dialog
blocked_by: []
depends_on: []
related: []
---

# Tasks Plan

## Summary

Carry open task text to the portal.

## Implementation plan

- [x] Already done
- [ ] First open item
- [ ] Second open item

## Validation

Run targeted checks.
`);
  writePlanSettings({ stateRoot: tasksStateRoot, discoveryRoots: [path.join(tempRoot, "projects-tasks")] });
  const tasksSnapshot = buildPlanSnapshot({ stateRoot: tasksStateRoot });
  const tasksRecord = tasksSnapshot.plans.find((item) => item.plan.id === "tasks-plan");
  assert.ok(tasksRecord, "expected the active tasks fixture in the snapshot");
  assert.deepEqual(
    tasksRecord.plan.openTasks.map((task) => task.text),
    ["First open item", "Second open item"],
    "openTasks must carry every unchecked item's text in document order, and nothing else",
  );
  assert.equal(tasksRecord.plan.taskCounts.complete, 1, "the completed item still counts toward progress");
  assert.equal(tasksRecord.plan.taskCounts.total, 3);

  // The scoping half, and it needs a fixture that WOULD carry tasks if the scoping were dropped:
  // a valid backlog plan with an unchecked item. An invalid plan parses to no tasks at all, so
  // asserting against one would pass whether or not the lifecycle check exists.
  fs.mkdirSync(path.join(tasksRepo, "docs", "plans", "backlog"), { recursive: true });
  fs.writeFileSync(path.join(tasksRepo, "docs", "plans", "backlog", "queued.md"), `---
id: queued-plan
priority: high
next_action: Wait for the dialog
blocked_by: []
depends_on: []
related: []
---

# Queued Plan

## Summary

Sit in the backlog with open work.

## Proposed design

Do nothing yet.

## Implementation plan

- [ ] Not on the active tab

## Validation

Run targeted checks.
`);
  const scopedSnapshot = buildPlanSnapshot({ stateRoot: tasksStateRoot });
  const queued = scopedSnapshot.plans.find((item) => item.plan.id === "queued-plan");
  assert.equal(queued.plan.taskCounts.remaining, 1,
    "fixture guard: this plan must really have an open task, or the next assertion proves nothing");
  assert.deepEqual(queued.plan.openTasks, [],
    "a non-active plan must not carry task text — the All Open Tasks dialog is active-only");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log("ok: plan docs behavior");