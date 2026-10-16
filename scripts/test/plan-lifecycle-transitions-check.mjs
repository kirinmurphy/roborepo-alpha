#!/usr/bin/env node
// The plan lifecycle end to end, through the real `roborepo plans` commands against real Git
// repositories: promote, start, the completion preflight, submit, the authoritative copy while the
// primary and worktree copies sit in different folders, approval freshness, reopen, close after a
// normal, squash, or rebase merge, and archive with integrated, unintegrated, and conflicting copies.
// Every move must commit only the plan's paths, refuse without mutating anything, and repeat safely.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildPlanSnapshot } from "../../modules/plan-suite/index.mjs";
import { addRepositorySource } from "../cli/repository-sources.mjs";
import { createPlanFixture, planDoc } from "./lib/plan-git-fixture.mjs";

const fx = createPlanFixture("roborepo-plan-transitions-");
const { git, roborepo, json, repository, worktree, commit } = fx;
const plans = (root, ...args) => roborepo(["plans", ...args, "--json"], { cwd: root });
const head = (root) => git(root, "rev-parse", "HEAD");
const read = (file) => fs.readFileSync(file, "utf8");
const exists = (root, file) => fs.existsSync(path.join(root, file));

function approved(result, label) {
  const body = json(result, label);
  assert.equal(result.status, 0, `${label} approves\n${result.stdout}${result.stderr}`);
  assert.equal(body.verdict, "APPROVED", label);
  assert.ok(body.checks.every((check) => check.ok), `${label}: every post-commit check passes`);
  return body;
}

function refused(root, result, label, pattern) {
  assert.equal(result.status, 1, `${label} refuses\n${result.stdout}${result.stderr}`);
  const body = json(result, label);
  assert.equal(body.ok, false, label);
  if (pattern) assert.match(`${body.error.message}\n${body.error.resolution || ""}`, pattern, label);
  return body.error;
}

// Checks every unchecked task in a plan copy and commits it, as an implementation agent would.
function completeTasks(checkout, planPath, message = "Complete the plan's tasks") {
  const file = path.join(checkout, planPath);
  return commit(checkout, message, { [planPath]: read(file).replaceAll("- [ ]", "- [x]") });
}

function approvalSection(sha) {
  return `\n## Review\n\n### Findings\n\n- [x] Missing retry test — added and verified\n\n### Verification\n\n- Unit tests passed\n\n### Approval\n\n- Decision: approved\n- Reviewed implementation commit: ${sha}\n- Confirmed by: human\n`;
}

function recordApproval(wt, planPath) {
  const sha = head(wt.path);
  const file = path.join(wt.path, planPath);
  const withoutApproval = read(file).replace(/\n## Review[\s\S]*$/, "\n");
  commit(wt.path, "Record review approval", { [planPath]: `${withoutApproval.trimEnd()}\n${approvalSection(sha)}` });
  return sha;
}

// What /plan-close writes into the primary copy before it asks for the move.
function closeEdits(root, planPath) {
  const file = path.join(root, planPath);
  fs.writeFileSync(file, `${read(file).replace(/^next_action: .*$/m, "next_action:").trimEnd()}\n\n## Verification\n\nThe fixture's checks passed.\n`);
}

// Moves one backlog plan to Review with a recorded, fresh approval, as the suite commands would.
function toReview(root, id, file, branch) {
  approved(plans(root, "promote", id), `promote ${id}`);
  const wt = worktree(root, branch);
  approved(plans(root, "start", id, "--worktree", wt.name), `start ${id}`);
  commit(wt.path, `Implement ${id}`, { [`src/${id}.txt`]: `${id}\n` });
  completeTasks(wt.path, `docs/plans/active/${file}`);
  approved(plans(root, "submit", id), `submit ${id}`);
  const synced = json(roborepo(["plans", "sync-base", "--json"], { cwd: wt.path }), `sync ${id}`);
  assert.equal(synced.state, "merged", `sync-base brings the review rename into ${branch}`);
  recordApproval(wt, `docs/plans/review/${file}`);
  return wt;
}

try {
  const root = repository("repo", {
    "docs/plans/backlog/test-flow.md": planDoc({ id: "flow0001" }),
    "docs/plans/backlog/test-weak.md": "---\nid: weak0001\npriority: low\nnext_action: Decide.\n---\n\n# Weak\n\n## Summary\n\nNot much yet.\n",
    "docs/plans/backlog/test-shelved.md": planDoc({ id: "shelf001" }),
    "docs/plans/backlog/test-squash.md": planDoc({ id: "squash01" }),
    "docs/plans/backlog/test-rebase.md": planDoc({ id: "rebase01" }),
    "docs/plans/backlog/test-carry.md": planDoc({ id: "carry001" }),
    "docs/plans/backlog/test-conflict.md": planDoc({ id: "confl001" }),
    "src/app.txt": "v1\n",
  });

  // ── Invalid moves refuse without mutating anything ───────────────────────────────────────────
  {
    const before = head(root);
    const reopen = refused(root, plans(root, "reopen", "flow0001"), "reopen a backlog plan", /from review to active; this one is backlog/);
    assert.match(reopen.resolution, /promote \(\/plan-promote\)/, "the refusal names what the plan can do instead");
    refused(root, plans(root, "submit", "flow0001"), "submit a backlog plan", /from active to review/);
    refused(root, plans(root, "close", "flow0001"), "close a backlog plan", /from review to completed/);

    const weak = refused(root, plans(root, "promote", "weak0001"), "promote an incomplete plan", /does not meet the ready requirements/);
    assert.equal(weak.code, "LIFECYCLE_REQUIREMENTS");
    assert.ok(weak.findings.some((item) => item.code === "MISSING_IMPLEMENTATION_CONTEXT"), "the gate lists each finding");
    assert.match(weak.repair.prompt, /^\/plan-write\n/, "a refused promotion carries a repair prompt");
    assert.ok(exists(root, "docs/plans/backlog/test-weak.md"), "the refused plan stays where it was");
    assert.equal(head(root), before, "no refusal commits anything");
    assert.equal(git(root, "status", "--porcelain"), "", "no refusal leaves anything behind");
  }

  // ── promote: backlog → ready, carrying the command's own edits, beside unrelated work ─────────
  {
    fs.writeFileSync(path.join(root, "notes.txt"), "someone else's unstaged file\n");
    fs.writeFileSync(path.join(root, "src/app.txt"), "v1 with someone else's staged edit\n");
    git(root, "add", "--", "src/app.txt");
    fs.appendFileSync(path.join(root, "docs/plans/backlog/test-flow.md"), "\nRefined during promotion.\n");

    const before = head(root);
    const promoted = approved(plans(root, "promote", "flow0001"), "promote");
    assert.deepEqual(promoted.plan.lifecycle, { from: "backlog", to: "ready" });
    assert.equal(git(root, "rev-parse", "HEAD^"), before, "one commit");
    const touched = git(root, "show", "--name-status", "--format=", "HEAD").split("\t");
    assert.match(touched[0], /^R/, "the commit is the plan's rename");
    assert.deepEqual(touched.slice(1), ["docs/plans/backlog/test-flow.md", "docs/plans/ready/test-flow.md"], "and nothing else");
    assert.match(git(root, "show", "HEAD:docs/plans/ready/test-flow.md"), /Refined during promotion/, "the promotion's edits ride along");
    assert.equal(git(root, "diff", "--cached", "--name-only"), "src/app.txt", "unrelated staged work stays staged");
    assert.ok(exists(root, "notes.txt"), "unrelated unstaged work stays in place");
    git(root, "reset", "--quiet", "--", "src/app.txt");
    git(root, "checkout", "--", "src/app.txt");
    fs.rmSync(path.join(root, "notes.txt"));

    const refinedBefore = head(root);
    const again = approved(plans(root, "promote", "flow0001"), "promote again");
    assert.equal(again.alreadyRecorded, true, "repeating a completed transition records nothing new");
    assert.equal(head(root), refinedBefore, "a repeat makes no commit");
    fs.appendFileSync(path.join(root, "docs/plans/ready/test-flow.md"), "\nRefined again while ready.\n");
    const refined = approved(plans(root, "promote", "flow0001"), "refine a ready plan");
    assert.equal(git(root, "rev-parse", "HEAD^"), refinedBefore, "a refinement in Ready is one commit");
    assert.equal(git(root, "show", "--name-status", "--format=", refined.commit), "M\tdocs/plans/ready/test-flow.md");
  }

  // ── start, then the completion preflight while implementation is unfinished ───────────────────
  const flow = worktree(root, "feat/flow");
  {
    const started = approved(plans(root, "start", "flow0001", "--worktree", flow.name), "start");
    assert.equal(started.fastForward.applied, true);
    assert.match(read(path.join(flow.path, "docs/plans/active/test-flow.md")), new RegExp(`^worktree: ${flow.name}$`, "m"));

    const early = json(plans(root, "preflight", "flow0001"), "early preflight");
    assert.equal(early.ok, false, "a plan with open tasks and no commits is not complete");
    const failed = early.checks.filter((check) => !check.ok).map((check) => check.n);
    assert.deepEqual(failed, [2, 5], "open tasks and a branch with no work of its own");

    const before = head(root);
    refused(root, plans(root, "submit", "flow0001"), "submit an unfinished plan", /Implementation is not complete/);
    assert.equal(head(root), before);
    assert.ok(exists(root, "docs/plans/active/test-flow.md"), "an unfinished plan stays active");

    commit(flow.path, "Implement the thing", { "src/app.txt": "v2\n" });
    completeTasks(flow.path, "docs/plans/active/test-flow.md");
    fs.writeFileSync(path.join(flow.path, "scratch.txt"), "uncommitted\n");
    const dirty = json(plans(root, "preflight", "flow0001"), "dirty preflight");
    assert.deepEqual(dirty.checks.filter((check) => !check.ok).map((check) => check.n), [4], "uncommitted work keeps the plan active");
    fs.rmSync(path.join(flow.path, "scratch.txt"));
    assert.equal(json(plans(root, "preflight", "flow0001"), "preflight").ok, true, "finished, committed work passes");
  }

  // ── submit: active → review is a pure rename; the worktree copy stays authoritative ───────────
  const stateRoot = path.join(fx.tmp, "portal-state");
  addRepositorySource({ path: root, stateRoot });
  const scanned = (id) => buildPlanSnapshot({ stateRoot }).plans.find((record) => record.plan.id === id);
  {
    const submitted = approved(plans(root, "submit", "flow0001"), "submit");
    assert.equal(submitted.preflight.ok, true, "submit reports the preflight it ran");
    assert.match(git(root, "show", "--name-status", "--format=", "HEAD"), /^R100\tdocs\/plans\/active\/test-flow.md\tdocs\/plans\/review\/test-flow.md$/);
    assert.equal(approved(plans(root, "submit", "flow0001"), "submit again").alreadyRecorded, true);

    const record = scanned("flow0001");
    assert.equal(record.plan.lifecycle, "review", "the primary copy decides the stage");
    assert.deepEqual(record.plan.authority, { source: "worktree", worktree: flow.name }, "a worktree copy still in active/ stays authoritative");
    assert.equal(record.plan.relativePath, "docs/plans/active/test-flow.md", "content is read from the worktree's copy");
    assert.equal(record.plan.primaryRelativePath, "docs/plans/review/test-flow.md", "and the primary copy's path is kept beside it");
    assert.equal(record.plan.taskCounts.remaining, 0, "the worktree's checked tasks are what the portal shows");
    assert.ok(!record.plan.validation.findings.some((item) => item.code === "PLAN_WORKTREE_COPY_UNAVAILABLE"), "the path difference is expected, not a finding");
  }

  // ── approval freshness: plan-only commits keep it, implementation changes do not ─────────────
  {
    const missing = plans(root, "approval", "flow0001");
    assert.equal(missing.status, 1);
    assert.equal(json(missing, "missing approval").state, "missing");

    const synced = json(roborepo(["plans", "sync-base", "--json"], { cwd: flow.path }), "sync before review");
    assert.equal(synced.state, "merged");
    assert.ok(exists(flow.path, "docs/plans/review/test-flow.md") && !exists(flow.path, "docs/plans/active/test-flow.md"), "the rename arrives through the merge");
    assert.equal(scanned("flow0001").plan.relativePath, "docs/plans/review/test-flow.md");

    recordApproval(flow, "docs/plans/review/test-flow.md");
    const fresh = plans(root, "approval", "flow0001");
    assert.equal(json(fresh, "fresh approval").state, "fresh", "recording the approval is a plan-only commit");
    assert.equal(fresh.status, 0);

    commit(flow.path, "Tidy the plan", { "docs/plans/review/test-flow.md": `${read(path.join(flow.path, "docs/plans/review/test-flow.md"))}\nA note.\n` });
    assert.equal(json(plans(root, "approval", "flow0001"), "after plan edit").state, "fresh", "later plan-only commits keep it fresh");

    commit(flow.path, "Change code after approval", { "src/app.txt": "v3\n" });
    const stale = json(plans(root, "approval", "flow0001"), "stale approval");
    assert.equal(stale.state, "stale");
    assert.deepEqual(stale.changedPaths, ["src/app.txt"], "the stale report names what changed");
    recordApproval(flow, "docs/plans/review/test-flow.md");
    assert.equal(json(plans(root, "approval", "flow0001"), "re-approved").state, "fresh");
  }

  // ── reopen: review → active on a scope change, keeping the worktree; then back to review ──────
  {
    const reopened = approved(plans(root, "reopen", "flow0001"), "reopen");
    assert.match(git(root, "show", "--name-status", "--format=", reopened.commit), /^R100\t/, "reopening is a pure rename");
    assert.equal(scanned("flow0001").plan.lifecycle, "active");
    assert.deepEqual(scanned("flow0001").plan.authority, { source: "worktree", worktree: flow.name }, "a worktree copy in review/ is authoritative for an active plan");
    approved(plans(root, "submit", "flow0001"), "resubmit");
  }

  // ── close: refused until the reviewed branch has merged, then review → completed ──────────────
  {
    const before = head(root);
    refused(root, plans(root, "close", "flow0001"), "close before merge", /not integrated/);
    assert.equal(head(root), before, "a refused close commits nothing");

    git(root, "merge", "--quiet", "--no-ff", "--no-edit", "feat/flow");
    closeEdits(root, "docs/plans/review/test-flow.md");
    const closed = approved(plans(root, "close", "flow0001"), "close");
    assert.equal(closed.approval.state, "fresh");
    assert.equal(closed.landing.landed, true, "the merge commit absorbs the branch");
    assert.ok(exists(root, "docs/plans/completed/test-flow.md"));
    assert.match(git(root, "show", "HEAD:docs/plans/completed/test-flow.md"), /## Verification/, "close carries its verification edits");
    assert.ok(fs.existsSync(flow.path), "close never removes the worktree itself");
    assert.equal(approved(plans(root, "close", "flow0001"), "close again").alreadyRecorded, true);
  }

  // ── close after a squash merge and after a rebase merge ───────────────────────────────────────
  {
    const squash = toReview(root, "squash01", "test-squash.md", "feat/squash");
    git(root, "merge", "--quiet", "--squash", "feat/squash");
    git(root, "commit", "--quiet", "-m", "Squash feat/squash");
    closeEdits(root, "docs/plans/review/test-squash.md");
    assert.equal(approved(plans(root, "close", "squash01"), "close after squash").landing.landed, true);
    assert.ok(fs.existsSync(squash.path));

    toReview(root, "rebase01", "test-rebase.md", "feat/rebase");
    const rebasing = path.join(fx.tmp, "worktrees", "rebasing");
    git(root, "worktree", "add", "--quiet", "-b", "rebased", rebasing, "feat/rebase");
    git(rebasing, "rebase", "--quiet", "main");
    git(root, "merge", "--quiet", "--ff-only", "rebased");
    closeEdits(root, "docs/plans/review/test-rebase.md");
    assert.equal(approved(plans(root, "close", "rebase01"), "close after rebase").landing.landed, true);
  }

  // ── archive: no worktree, an unintegrated worktree copy, and conflicting copies ───────────────
  {
    assert.equal(roborepo(["plans", "archive", "shelf001"], { cwd: root }).status, 2, "--reason is required");
    const shelved = approved(plans(root, "archive", "shelf001", "--reason", "Superseded by flow0001."), "archive backlog");
    assert.equal(shelved.worktreeCopy, "no-worktree");
    const archived = git(root, "show", "HEAD:docs/plans/archived/test-shelved.md");
    assert.match(archived, /## Archived\n\n\d{4}-\d{2}-\d{2}: Superseded by flow0001\./, "the reason goes in the plan body");
    assert.match(archived, /^next_action:$/m, "an archived plan has no next action");

    approved(plans(root, "promote", "carry001"), "promote carry");
    const carry = worktree(root, "feat/carry");
    approved(plans(root, "start", "carry001", "--worktree", carry.name), "start carry");
    commit(carry.path, "Unmerged code", { "src/carry.txt": "unmerged\n" });
    commit(carry.path, "Record progress", { "docs/plans/active/test-carry.md": `${read(path.join(carry.path, "docs/plans/active/test-carry.md"))}\nProgress only the worktree has.\n` });
    const carried = approved(plans(root, "archive", "carry001", "--reason", "Abandoned."), "archive with carry");
    assert.equal(carried.worktreeCopy, "carried");
    assert.match(git(root, "show", "HEAD:docs/plans/archived/test-carry.md"), /Progress only the worktree has\.[\s\S]*## Archived/, "the worktree's progress is carried once");
    assert.ok(fs.existsSync(path.join(carry.path, "src/carry.txt")), "archiving never touches the unmerged work");
    assert.equal(git(root, "rev-parse", "--verify", "-q", "refs/heads/feat/carry").length > 0, true, "the branch survives");

    approved(plans(root, "promote", "confl001"), "promote conflict");
    const conflict = worktree(root, "feat/conflict");
    approved(plans(root, "start", "confl001", "--worktree", conflict.name), "start conflict");
    commit(conflict.path, "Worktree edit", { "docs/plans/active/test-conflict.md": `${read(path.join(conflict.path, "docs/plans/active/test-conflict.md"))}\nWorktree note.\n` });
    commit(root, "Primary edit", { "docs/plans/active/test-conflict.md": `${read(path.join(root, "docs/plans/active/test-conflict.md"))}\nPrimary note.\n` });
    const before = head(root);
    refused(root, plans(root, "archive", "confl001", "--reason", "Abandoned."), "archive conflicting copies", /conflicting copies/);
    assert.equal(head(root), before, "a refused archive commits nothing");
    assert.ok(exists(root, "docs/plans/active/test-conflict.md"));
  }

  console.log("plan lifecycle transitions: ok");
} finally {
  fx.cleanup();
}
