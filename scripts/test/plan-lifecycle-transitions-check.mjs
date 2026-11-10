#!/usr/bin/env node
// The plan lifecycle end to end, through the real `roborepo plans` commands against real Git
// repositories: promote, start, the completion preflight, submit, approval freshness, reopen, close
// after a normal, squash, or rebase merge, and archive. Every move must land as one commit on the plans
// branch touching only the plan's paths, leave code branches alone, refuse without changing anything,
// and repeat safely.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { reviewFreshness } from "../../modules/plan-suite/review-freshness.mjs";
import { buildPlanSnapshot } from "../../modules/plan-suite/index.mjs";
import { addRepositorySource } from "../cli/repository-sources.mjs";
import { createPlanFixture, planDoc } from "./lib/plan-git-fixture.mjs";

const fx = createPlanFixture("roborepo-plan-transitions-");
const { git, tryGit, roborepo, json, repository, storePath, worktree, commit } = fx;
const plans = (root, ...args) => roborepo(["plans", ...args, "--json"], { cwd: root });
const head = (root) => git(root, "rev-parse", "HEAD");
const read = (file) => fs.readFileSync(file, "utf8");

function approved(result, label) {
  const body = json(result, label);
  assert.equal(result.status, 0, `${label} approves\n${result.stdout}${result.stderr}`);
  assert.equal(body.verdict, "APPROVED", label);
  assert.ok(body.checks.every((check) => check.ok), `${label}: every post-commit check passes`);
  return body;
}

function refused(result, label, pattern) {
  assert.equal(result.status, 1, `${label} refuses\n${result.stdout}${result.stderr}`);
  const body = json(result, label);
  assert.equal(body.ok, false, label);
  if (pattern) assert.match(`${body.error.message}\n${body.error.resolution || ""}`, pattern, label);
  return body.error;
}

let drafts = 0;

try {
  const root = repository("repo", {
    "plans/backlog/test-flow.md": planDoc({ id: "flow0001" }),
    "plans/backlog/test-weak.md": "---\nid: weak0001\nnext_action: Decide.\n---\n\n# Weak\n\n## Summary\n\nNot much yet.\n",
    "plans/backlog/test-shelved.md": planDoc({ id: "shelf001" }),
    "plans/backlog/test-squash.md": planDoc({ id: "squash01" }),
    "plans/backlog/test-rebase.md": planDoc({ id: "rebase01" }),
    "plans/backlog/test-late-approval.md": planDoc({ id: "late0001" }),
    "plans/backlog/test-gone.md": planDoc({ id: "gone0001" }),
    "plans/backlog/test-ffwd.md": planDoc({ id: "ffwd0001" }),
    "plans/backlog/test-carry.md": planDoc({ id: "carry001" }),
    "src/app.txt": "v1\n",
  });
  const store = storePath(root);
  const inStore = (file) => path.join(store, file);
  const exists = (file) => fs.existsSync(inStore(file));
  // The agent workflow: read the plan, edit a copy outside the checkouts, and save the copy.
  const edit = (planPath, change, cwd = root) => {
    const draft = path.join(fx.tmp, "drafts", String(drafts += 1), path.basename(planPath));
    fs.mkdirSync(path.dirname(draft), { recursive: true });
    fs.writeFileSync(draft, change(read(inStore(planPath))));
    const result = plans(cwd, "save", draft);
    assert.equal(result.status, 0, `save ${planPath}\n${result.stdout}${result.stderr}`);
    return json(result, `save ${planPath}`);
  };
  const completeTasks = (planPath) => edit(planPath, (text) => text.replaceAll("- [ ]", "- [x]"));
  // What /plan-close saves before it asks for the move, optionally with the absorbing commit its
  // landed check reported.
  const closeEdits = (planPath, absorbingCommit = null) => edit(planPath, (text) => {
    const landing = absorbingCommit ? `\n- Absorbing commit: ${absorbingCommit}\n` : "";
    return `${text.trimEnd()}\n\n## Verification\n\nThe fixture's checks passed.\n${landing}`;
  });
  const approve = (wt, id) => {
    const result = plans(root, "approve", id, "--commit", head(wt.path), "--confirmed-by", "human");
    assert.equal(result.status, 0, `approve ${id}\n${result.stdout}${result.stderr}`);
  };
  // Moves one backlog plan to Review, as the suite commands would.
  const toReview = (id, file, branch) => {
    approved(plans(root, "promote", id), `promote ${id}`);
    const wt = worktree(root, branch);
    approved(plans(root, "start", id, "--worktree", wt.name), `start ${id}`);
    commit(wt.path, `Implement ${id}`, { [`src/${id}.txt`]: `${id}\n` });
    completeTasks(`plans/active/${file}`);
    approved(plans(root, "submit", id), `submit ${id}`);
    return wt;
  };

  // ── Invalid moves refuse without changing anything ───────────────────────────────────────────
  {
    const before = head(store);
    const reopen = refused(plans(root, "reopen", "flow0001"), "reopen a backlog plan", /from review to active; this one is backlog/);
    assert.match(reopen.resolution, /promote \(\/plan-promote\)/, "the refusal names what the plan can do instead");
    refused(plans(root, "submit", "flow0001"), "submit a backlog plan", /from active to review/);
    refused(plans(root, "close", "flow0001"), "close a backlog plan", /from review to completed/);

    const weak = refused(plans(root, "promote", "weak0001"), "promote an incomplete plan", /does not meet the ready requirements/);
    assert.equal(weak.code, "LIFECYCLE_REQUIREMENTS");
    assert.ok(weak.findings.some((item) => item.code === "MISSING_IMPLEMENTATION_CONTEXT"), "the gate lists each finding");
    assert.match(weak.repair.prompt, /^\/plan-write\n/, "a refused promotion carries a repair prompt");
    assert.ok(exists("plans/backlog/test-weak.md"), "the refused plan stays where it was");
    assert.equal(head(store), before, "no refusal commits anything");
    assert.equal(git(store, "status", "--porcelain"), "", "no refusal leaves anything behind");

    // A transition reads only the store, so a raw edit in the plans worktree is refused, never committed.
    const raw = inStore("plans/backlog/test-flow.md");
    const clean = read(raw);
    fs.appendFileSync(raw, "\nA raw edit.\n");
    assert.equal(refused(plans(root, "promote", "flow0001"), "promote over a raw edit", /uncommitted edits/).code, "PLAN_STORE_DIRTY");
    assert.equal(head(store), before);
    fs.writeFileSync(raw, clean);
  }

  // ── promote: backlog → ready, one plans-branch commit, beside unrelated code work ────────────
  {
    fs.writeFileSync(path.join(root, "notes.txt"), "someone else's unstaged file\n");
    fs.writeFileSync(path.join(root, "src/app.txt"), "v1 with someone else's staged edit\n");
    git(root, "add", "--", "src/app.txt");
    edit("plans/backlog/test-flow.md", (text) => `${text}\nRefined before promotion.\n`);

    const before = head(store);
    const codeBefore = head(root);
    const promoted = approved(plans(root, "promote", "flow0001"), "promote");
    assert.deepEqual(promoted.plan.lifecycle, { from: "backlog", to: "ready" });
    assert.equal(git(store, "rev-parse", "HEAD^"), before, "one commit");
    assert.deepEqual(git(store, "show", "--name-status", "--no-renames", "--format=", "HEAD").split("\n").sort(),
      ["A\tplans/ready/test-flow.md", "D\tplans/backlog/test-flow.md"], "the commit is the plan's move and nothing else");
    assert.equal(git(store, "log", "-1", "--format=%s"), "Promote plan test-flow to ready", "the commit names the plan by its filename, not its id");
    assert.match(git(store, "show", "HEAD:plans/ready/test-flow.md"), /Refined before promotion/);
    assert.equal(head(root), codeBefore, "the code branch does not move");
    assert.equal(git(root, "diff", "--cached", "--name-only"), "src/app.txt", "unrelated staged work stays staged");
    assert.ok(fs.existsSync(path.join(root, "notes.txt")), "unrelated unstaged work stays in place");
    git(root, "reset", "--quiet", "--", "src/app.txt");
    git(root, "checkout", "--", "src/app.txt");
    fs.rmSync(path.join(root, "notes.txt"));

    const after = head(store);
    const again = approved(plans(root, "promote", "flow0001"), "promote again");
    assert.equal(again.alreadyRecorded, true, "repeating a completed transition records nothing new");
    assert.equal(head(store), after, "a repeat makes no commit");
  }

  // ── start, then the completion preflight while implementation is unfinished ───────────────────
  const flow = worktree(root, "feat/flow");
  {
    const flowHead = head(flow.path);
    approved(plans(root, "start", "flow0001", "--worktree", flow.name), "start");
    assert.equal(head(flow.path), flowHead, "starting does not move the implementation worktree");
    assert.doesNotMatch(read(inStore("plans/active/test-flow.md")), /^priority:/m, "starting writes no priority line back");
    assert.match(read(inStore("plans/active/test-flow.md")), new RegExp(`^worktree: ${flow.name}$`, "m"));

    const early = json(plans(root, "preflight", "flow0001"), "early preflight");
    assert.equal(early.ok, false, "a plan with open tasks and no commits is not complete");
    assert.deepEqual(early.checks.filter((check) => !check.ok).map((check) => check.n), [2, 5], "open tasks and a branch with no work of its own");
    const fileLine = read(inStore("plans/active/test-flow.md")).split("\n").findIndex((line) => /^\s*[-*]\s+\[ \]/.test(line)) + 1;
    assert.match(early.checks.find((check) => check.n === 2).observed, new RegExp(`^line ${fileLine}: `), "an open task is reported at its line in the file, frontmatter included");

    const before = head(store);
    refused(plans(root, "submit", "flow0001"), "submit an unfinished plan", /Implementation is not complete/);
    assert.equal(head(store), before);
    assert.ok(exists("plans/active/test-flow.md"), "an unfinished plan stays active");

    commit(flow.path, "Implement the thing", { "src/app.txt": "v2\n" });
    completeTasks("plans/active/test-flow.md");
    fs.writeFileSync(path.join(flow.path, "scratch.txt"), "uncommitted\n");
    const dirty = json(plans(root, "preflight", "flow0001"), "dirty preflight");
    assert.deepEqual(dirty.checks.filter((check) => !check.ok).map((check) => check.n), [4], "uncommitted work keeps the plan active");
    fs.rmSync(path.join(flow.path, "scratch.txt"));
    assert.equal(json(plans(root, "preflight", "flow0001"), "preflight").ok, true, "finished, committed work passes");
  }

  // ── submit: active → review is a pure rename ─────────────────────────────────────────────────
  const stateRoot = path.join(fx.tmp, "portal-state");
  addRepositorySource({ path: root, stateRoot });
  const scanned = (id) => buildPlanSnapshot({ stateRoot }).plans.find((record) => record.plan.id === id);
  {
    const flowHead = head(flow.path);
    const submitted = approved(plans(flow.path, "submit", "flow0001"), "submit from the implementation worktree");
    assert.equal(submitted.preflight.ok, true, "submit reports the preflight it ran");
    assert.deepEqual(git(store, "show", "--name-status", "--no-renames", "--format=", "HEAD").split("\n").sort(), ["A\tplans/review/test-flow.md", "D\tplans/active/test-flow.md"]);
    assert.equal(head(flow.path), flowHead, "submit commits nothing on the code branch");
    assert.equal(approved(plans(root, "submit", "flow0001"), "submit again").alreadyRecorded, true);

    const record = scanned("flow0001");
    assert.equal(record.plan.lifecycle, "review");
    assert.equal(record.plan.relativePath, "plans/review/test-flow.md");
    assert.equal(record.plan.taskCounts.remaining, 0, "the checked tasks are what the portal shows");
    assert.equal("authority" in record.plan, false, "one copy has no authority to report");
  }

  // ── validate: every checkout reads the one copy, and the portal agrees ───────────────────────
  {
    edit("plans/review/test-flow.md", (text) => `${text.replace(/^related: \[\]$/m, "related: [weak0001]").trimEnd()}\n\n## Not tested\n\n- [ ] Checked by hand.\n`);
    const codes = (plan) => plan.findings.map((item) => item.code).sort();
    const [fromPrimary] = json(plans(root, "validate", "flow0001"), "validate from the primary checkout").plans;
    const [fromWorktree] = json(plans(flow.path, "validate", "flow0001"), "validate from the worktree").plans;
    assert.equal(fromPrimary.relativePath, "plans/review/test-flow.md");
    assert.equal(fromPrimary.lifecycle, "review");
    assert.ok(codes(fromPrimary).includes("UNCONFIRMED_NOT_TESTED"));
    assert.ok(!codes(fromPrimary).includes("RELATED_NOT_FOUND"), "links between plans resolve in the store");
    assert.deepEqual(fromWorktree, fromPrimary, "a linked worktree sees the same plan");
    assert.deepEqual(codes(fromPrimary), scanned("flow0001").plan.validation.findings.map((item) => item.code).sort(), "the CLI and the portal agree");
    edit("plans/review/test-flow.md", (text) => text.replace(/\n## Not tested\n\n- \[ \] Checked by hand\.\n$/, "\n"));
  }

  // ── approval freshness: plans commits keep it, implementation changes do not ─────────────────
  {
    const missing = plans(root, "approval", "flow0001");
    assert.equal(missing.status, 1);
    assert.equal(json(missing, "missing approval").state, "missing");
    assert.equal(json(missing, "missing review result").review.state, "missing");

    const reviewPath = "plans/review/test-flow.md";
    const reviewedTip = head(flow.path);
    const reviewedBase = head(root);
    const reviewDoc = `${read(inStore(reviewPath)).trimEnd()}\n\n## Review\n\n### Result\n- Status: complete\n- Reviewed implementation commit: ${reviewedTip}\n- Base commit: ${reviewedBase}\n\n### Findings\n- [x] Review checks passed\n`;
    const saveReview = (text) => edit(reviewPath, () => text);
    saveReview(reviewDoc);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const pending = json(plans(root, "approval", "flow0001"), "completed review awaiting approval");
      assert.equal(pending.review.state, "fresh", "review completion is independent of approval");
      assert.equal(pending.state, "missing", "completed checks never grant human approval");
      assert.equal(pending.review.result.commit, reviewedTip);
      assert.deepEqual(pending.review.baseChangedPaths, []);
      assert.equal(head(flow.path), reviewedTip, "checking a pending review makes no commits");
    }
    fs.writeFileSync(path.join(flow.path, "src/app.txt"), "pending implementation\n");
    assert.equal(json(plans(root, "approval", "flow0001"), "uncommitted implementation").review.state, "incomplete");
    fs.writeFileSync(path.join(flow.path, "src/app.txt"), git(flow.path, "show", "HEAD:src/app.txt") + "\n");
    // Git can list unreadable paths and exit successfully while reporting access errors on stderr.
    const spawnSync = childProcess.spawnSync;
    try {
      for (const command of ["status", "diff", "ls-files"]) {
        childProcess.spawnSync = (binary, args, options) => {
          if (binary === "git" && args[2] === command) {
            return { status: 0, stdout: "src/protected-fixture\n", stderr: "src/protected-fixture: Operation not permitted\n" };
          }
          return spawnSync(binary, args, options);
        };
        syncBuiltinESMExports();
        const unreadable = reviewFreshness({ primary: root, markdown: reviewDoc, tip: reviewedTip, base: reviewedBase, workingPath: flow.path });
        assert.equal(unreadable.state, "unavailable", `${command} access errors do not establish changed files`);
        assert.match(unreadable.reason, /could not reliably check/);
        assert.match(unreadable.diagnostics.join("\n"), /Operation not permitted/);
        assert.equal(unreadable.changedPaths, undefined, "inaccessible paths are not reported as edits");
      }
    } finally {
      childProcess.spawnSync = spawnSync;
      syncBuiltinESMExports();
    }
    saveReview(reviewDoc.replace("- Status: complete", "- Status: pending"));
    assert.equal(json(plans(root, "approval", "flow0001"), "pending review result").review.state, "incomplete");
    saveReview(reviewDoc.replace("- [x] Review checks passed", "- [ ] Review checks passed"));
    assert.equal(json(plans(root, "approval", "flow0001"), "open review finding").review.state, "incomplete");
    saveReview(`${reviewDoc}\n## Not tested\n- [ ] Confirm the manual workflow\n`);
    assert.equal(json(plans(root, "approval", "flow0001"), "open manual check").review.state, "incomplete");
    saveReview(reviewDoc.replace(reviewedTip, "not-a-commit"));
    assert.equal(json(plans(root, "approval", "flow0001"), "invalid review commit").review.state, "invalid");
    saveReview(reviewDoc);
    commit(root, "Change base after review", { "src/base.txt": "new base work\n" });
    const movedBase = json(plans(root, "approval", "flow0001"), "base moved after review");
    assert.equal(movedBase.review.state, "fresh", "base movement does not erase the reviewed branch result");
    assert.deepEqual(movedBase.review.baseChangedPaths, ["src/base.txt"], "the caller can decide whether base synchronization is needed");
    const movedBaseText = roborepo(["plans", "approval", "flow0001"], { cwd: root }).stdout;
    assert.match(movedBaseText, /changed on base since review: 1 path \(list with --json\)/, "text output counts base changes");
    assert.doesNotMatch(movedBaseText, /src\/base\.txt/, "text output leaves the base path list to --json");
    commit(flow.path, "Change implementation after review", { "src/review.txt": "new work\n" });
    const staleReview = json(plans(root, "approval", "flow0001"), "implementation changed after review");
    assert.equal(staleReview.review.state, "stale");
    assert.deepEqual(staleReview.review.changedPaths, ["src/review.txt"]);

    approve(flow, "flow0001");
    const fresh = plans(root, "approval", "flow0001");
    assert.equal(json(fresh, "fresh approval").state, "fresh");
    assert.equal(fresh.status, 0);

    edit(reviewPath, (text) => text.replace("The thing is done.", "The thing is done. A note."));
    assert.equal(json(plans(root, "approval", "flow0001"), "after plan edit").state, "fresh", "later plans commits keep it fresh");

    commit(flow.path, "Change code after approval", { "src/app.txt": "v3\n" });
    const stale = json(plans(root, "approval", "flow0001"), "stale approval");
    assert.equal(stale.state, "stale");
    assert.deepEqual(stale.changedPaths, ["src/app.txt"], "the stale report names what changed");
    approve(flow, "flow0001");
    assert.equal(json(plans(root, "approval", "flow0001"), "re-approved").state, "fresh");
  }

  // ── Approval recorded after a squash merge touches nothing on the code branch ────────────────
  {
    const late = toReview("late0001", "test-late-approval.md", "feat/late");
    const planPath = "plans/review/test-late-approval.md";
    const reviewedTip = head(late.path);
    edit(planPath, (text) => `${text.trimEnd()}\n\n## Review\n\n### Result\n- Status: complete\n- Reviewed implementation commit: ${reviewedTip}\n- Base commit: ${head(root)}\n`);
    git(root, "merge", "--squash", "feat/late");
    git(root, "commit", "--quiet", "-m", "Land reviewed work with approval still pending");
    const pending = json(plans(root, "approval", "late0001"), "landed review awaiting approval");
    assert.equal(pending.state, "missing");
    assert.equal(pending.review.state, "fresh", "landing preserves the feature's completed review");
    const codeBefore = head(root);
    approve(late, "late0001");
    assert.equal(head(root), codeBefore, "recording approval changes nothing on base");
    assert.equal(head(late.path), reviewedTip, "or on the reviewed branch");
    assert.equal(json(plans(root, "approval", "late0001"), "late approval").state, "fresh");
    closeEdits(planPath);
    const closed = approved(plans(root, "close", "late0001"), "close after a late approval");
    assert.equal(closed.landing.landed, true);
  }

  // ── reopen: review → active on a scope change, retiring the approval; then back to review ────
  {
    const reopened = approved(plans(root, "reopen", "flow0001"), "reopen");
    assert.deepEqual(git(store, "show", "--name-status", "--no-renames", "--format=", reopened.commit).split("\n").sort(), ["A\tplans/active/test-flow.md", "D\tplans/review/test-flow.md"]);
    assert.equal(scanned("flow0001").plan.lifecycle, "active");
    assert.match(read(inStore("plans/active/test-flow.md")), /### Approval\n- Decision: invalidated\n- Reviewed implementation commit: [0-9a-f]{40}/, "reopening marks the approval, keeping the record as history");
    const retired = plans(root, "approval", "flow0001");
    assert.equal(retired.status, 1, "a retired approval does not pass the check");
    assert.equal(json(retired, "approval after reopen").state, "not-approved", "though the implementation has not changed since it was recorded");

    approved(plans(root, "submit", "flow0001"), "resubmit");
    refused(plans(root, "close", "flow0001"), "close on a retired approval", /human approval is not-approved/);
    approve(flow, "flow0001");
    assert.equal(json(plans(root, "approval", "flow0001"), "approved again after reopen").state, "fresh");
    assert.match(read(inStore("plans/review/test-flow.md")), /### Approval\n- Decision: approved/, "a new approval replaces the retired record");
  }

  // ── close: refused until the reviewed branch has merged, then review → completed ──────────────
  {
    const before = head(store);
    refused(plans(root, "close", "flow0001"), "close before merge", /landed: unconfirmed/);
    assert.equal(head(store), before, "a refused close commits nothing");
    const unlanded = plans(root, "landed", "flow0001");
    assert.equal(unlanded.status, 1, "the landed check fails before the merge");
    assert.equal(json(unlanded, "landed before merge").landed, false);

    git(root, "merge", "--quiet", "--no-ff", "--no-edit", "feat/flow");
    closeEdits("plans/review/test-flow.md");
    const closed = approved(plans(root, "close", "flow0001"), "close");
    assert.equal(closed.approval.state, "fresh");
    assert.equal(closed.landing.landed, true, "the merge commit absorbs the branch");
    const completed = git(store, "show", "HEAD:plans/completed/test-flow.md");
    assert.match(completed, /## Verification/, "the saved verification moves with it");
    assert.match(completed, /^next_action:$/m, "closing clears the next action, which no save in Review can");
    assert.ok(fs.existsSync(flow.path), "close never removes the worktree itself");
    assert.equal(approved(plans(root, "close", "flow0001"), "close again").alreadyRecorded, true);
  }

  // ── close after a squash merge and after a rebase merge ───────────────────────────────────────
  {
    const squash = toReview("squash01", "test-squash.md", "feat/squash");
    approve(squash, "squash01");
    git(root, "merge", "--quiet", "--squash", "feat/squash");
    git(root, "commit", "--quiet", "-m", "Squash feat/squash");
    const squashCommit = head(root);
    const landed = json(plans(root, "landed", "squash01"), "landed after squash");
    assert.deepEqual([landed.landed, landed.absorbingCommit, landed.reused], [true, squashCommit, false], "the first landed check scans base history");
    closeEdits("plans/review/test-squash.md", squashCommit);
    const recheck = json(plans(root, "landed", "squash01"), "landed with recorded evidence");
    assert.equal(recheck.reused, true, "a recorded absorbing commit is verified instead of rescanned");
    const closedSquash = approved(plans(root, "close", "squash01"), "close after squash");
    assert.deepEqual([closedSquash.landing.landed, closedSquash.landing.reused], [true, true], "close verifies the recorded absorbing commit");
    assert.ok(fs.existsSync(squash.path));

    const rebased = toReview("rebase01", "test-rebase.md", "feat/rebase");
    approve(rebased, "rebase01");
    commit(root, "Base moves before the rebase", { "src/moved.txt": "moved\n" });
    const rebasing = path.join(fx.tmp, "worktrees", "rebasing");
    git(root, "worktree", "add", "--quiet", "-b", "rebased", rebasing, "feat/rebase");
    git(rebasing, "rebase", "--quiet", "main");
    git(root, "merge", "--quiet", "--ff-only", "rebased");
    closeEdits("plans/review/test-rebase.md");
    assert.equal(approved(plans(root, "close", "rebase01"), "close after rebase").landing.landed, true);
  }

  // ── close after a fast-forward: lifecycle commits no longer move the base, so a branch can do this ──
  {
    const ffwd = toReview("ffwd0001", "test-ffwd.md", "feat/ffwd");
    approve(ffwd, "ffwd0001");
    const tip = head(ffwd.path);
    assert.equal(json(plans(root, "landed", "ffwd0001"), "landed before the fast-forward").landed, false, "a review plan's unmerged branch has not landed");
    git(root, "merge", "--quiet", "--ff-only", "feat/ffwd");
    assert.equal(head(root), tip, "the merge really was a fast-forward");
    const landed = json(plans(root, "landed", "ffwd0001"), "landed after the fast-forward");
    assert.deepEqual([landed.landed, landed.absorbingCommit], [true, tip], "the branch's tip is on the base");
    closeEdits("plans/review/test-ffwd.md", tip);
    assert.equal(approved(plans(root, "close", "ffwd0001"), "close after a fast-forward").landing.landed, true);
  }

  // ── close after the worktree is removed: unavailable, never compared against the base branch ──
  {
    const gone = toReview("gone0001", "test-gone.md", "feat/gone");
    approve(gone, "gone0001");
    git(root, "merge", "--quiet", "--squash", "feat/gone");
    git(root, "commit", "--quiet", "-m", "Squash feat/gone");
    commit(root, "Unrelated work on main", { "src/unrelated.txt": "later\n" });
    assert.equal(json(plans(root, "approval", "gone0001"), "approval with the worktree").state, "fresh");

    git(root, "worktree", "remove", gone.path);
    const unavailable = json(plans(root, "approval", "gone0001"), "approval without the worktree");
    assert.equal(unavailable.state, "unavailable", "a later base commit is not reported as an implementation change");
    assert.match(unavailable.reason, new RegExp(`worktree ${gone.name} is not a linked worktree`), "the reason names the missing worktree");

    closeEdits("plans/review/test-gone.md");
    const before = head(store);
    refused(plans(root, "close", "gone0001"), "close without the worktree", new RegExp(`cannot be checked[\\s\\S]*Recreate the linked worktree named ${gone.name}`));
    assert.equal(head(store), before, "a refused close commits nothing");

    git(root, "worktree", "add", "--quiet", gone.path, "feat/gone");
    const closed = approved(plans(root, "close", "gone0001"), "close after recreating the worktree");
    assert.equal(closed.landing.landed, true, "landing is checked against the recreated worktree's branch");
  }

  // ── archive: with no worktree, and with unmerged work it must leave alone ─────────────────────
  {
    assert.equal(roborepo(["plans", "archive", "shelf001"], { cwd: root }).status, 2, "--reason is required");
    approved(plans(root, "archive", "shelf001", "--reason", "Superseded by flow0001."), "archive backlog");
    const archived = git(store, "show", "HEAD:plans/archived/test-shelved.md");
    assert.match(archived, /## Archived\n\n\d{4}-\d{2}-\d{2}: Superseded by flow0001\./, "the reason goes in the plan body");
    assert.match(archived, /^next_action:$/m, "an archived plan has no next action");

    approved(plans(root, "promote", "carry001"), "promote carry");
    const carry = worktree(root, "feat/carry");
    approved(plans(root, "start", "carry001", "--worktree", carry.name), "start carry");
    const carryHead = commit(carry.path, "Unmerged code", { "src/carry.txt": "unmerged\n" });
    approved(plans(root, "archive", "carry001", "--reason", "Abandoned."), "archive an active plan");
    assert.ok(fs.existsSync(path.join(carry.path, "src/carry.txt")), "archiving never touches the unmerged work");
    assert.equal(git(root, "rev-parse", "--verify", "-q", "refs/heads/feat/carry"), carryHead, "the branch survives");
  }

  // ── archive clears the plan from what depends on it, in both list forms, in its own commit ────
  {
    const linkedDoc = (id, relations) => `---\nid: ${id}\nnext_action: Decide.\n${relations}\n---\n\n# Plan ${id}\n\n## Summary\n\nBody stays exactly as written.\n`;
    const backlog = (name) => `plans/backlog/test-${name}.md`;
    const seed = (files) => {
      for (const [file, content] of Object.entries(files)) fs.writeFileSync(inStore(file), content);
      git(store, "add", "--", ...Object.keys(files));
      git(store, "commit", "--quiet", "-m", "Seed linked plans");
    };
    seed({
      [backlog("arch-root")]: linkedDoc("archroot", "depends_on: []\nblocked_by: []\nrelated: []"),
      [backlog("arch-flow")]: linkedDoc("archflow", 'depends_on: [archroot, flow0001]\nblocked_by: ["external: vendor, inc"]\nrelated: [archroot]'),
      [backlog("arch-list")]: linkedDoc("archlist", "depends_on:\n  - archroot\nblocked_by:\n  - 'archroot'\n  - external: a vendor\nrelated: []"),
      [backlog("arch-busy")]: linkedDoc("archbusy", "depends_on: []\nblocked_by: []\nrelated: []"),
      [backlog("arch-leaf")]: linkedDoc("archleaf", "depends_on: [archbusy]\nblocked_by: []\nrelated: []"),
      [backlog("arch-dep")]: linkedDoc("archdep1", "depends_on: [archbusy]\nblocked_by: []\nrelated: []"),
    });

    const archived = approved(plans(root, "archive", "archroot", "--reason", "Abandoned."), "archive a prerequisite");
    assert.deepEqual([...archived.references.cleared].sort(), [backlog("arch-flow"), backlog("arch-list")], "every dependent is cleared");
    const flowDoc = read(inStore(backlog("arch-flow")));
    assert.match(flowDoc, /^depends_on: \[flow0001\]$/m, "the other prerequisite stays");
    assert.match(flowDoc, /^blocked_by: \["external: vendor, inc"\]$/m, "a list without the plan is untouched");
    assert.match(flowDoc, /^related: \[archroot\]$/m, "related is not a dependency, and the archived plan still resolves");
    const list = read(inStore(backlog("arch-list")));
    assert.match(list, /^depends_on: \[\]$/m, "a block list left empty becomes an empty list");
    assert.match(list, /^blocked_by:\n {2}- external: a vendor$/m, "a quoted block entry is removed and the rest kept");
    assert.match(list, /Body stays exactly as written\.\n$/);
    assert.deepEqual(git(store, "show", "--no-renames", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean).sort(),
      ["plans/archived/test-arch-root.md", backlog("arch-flow"), backlog("arch-list"), backlog("arch-root")].sort(), "the move and the clearing land in one commit");

    // Archiving the dependent leaves its prerequisite with nothing to clean up.
    const busyBefore = read(inStore(backlog("arch-busy")));
    const dependent = approved(plans(root, "archive", "archleaf", "--reason", "Abandoned."), "archive a dependent");
    assert.deepEqual(dependent.references, { cleared: [] });
    assert.equal(read(inStore(backlog("arch-busy"))), busyBefore, "the prerequisite never named its dependent");

    // A dependent with a raw edit refuses the whole move rather than committing that edit.
    const dependentFile = inStore(backlog("arch-dep"));
    const dependentBefore = read(dependentFile);
    fs.appendFileSync(dependentFile, "\nA raw edit.\n");
    const before = head(store);
    assert.equal(refused(plans(root, "archive", "archbusy", "--reason", "Abandoned."), "archive with a dirty dependent", /uncommitted edits/).code, "PLAN_STORE_DIRTY");
    assert.equal(head(store), before, "a refused archive commits nothing");
    assert.ok(fs.existsSync(inStore(backlog("arch-busy"))));
    fs.writeFileSync(dependentFile, dependentBefore);

    const storeBefore = () => git(store, "status", "--porcelain");
    // A dependent that can't be rewritten leaves nothing half moved. Root writes a read-only file anyway.
    if (process.getuid?.() !== 0) {
      fs.chmodSync(dependentFile, 0o444);
      const failed = plans(root, "archive", "archbusy", "--reason", "Abandoned.");
      fs.chmodSync(dependentFile, 0o644);
      assert.equal(failed.status, 1, `archive with a read-only dependent\n${failed.stdout}${failed.stderr}`);
      assert.equal(head(store), before, "a failed write commits nothing");
      assert.equal(storeBefore(), "", "a failed write restores the store");
      assert.equal(read(dependentFile), dependentBefore);
      assert.ok(fs.existsSync(inStore(backlog("arch-busy"))), "the plan stays where it was");
    }

    // A real commit failure, from a lock Git holds, restores every file and reports what happened.
    const indexLock = git(store, "rev-parse", "--git-path", "index.lock");
    const lockFile = path.isAbsolute(indexLock) ? indexLock : path.join(store, indexLock);
    fs.writeFileSync(lockFile, "");
    const blocked = refused(plans(root, "archive", "archbusy", "--reason", "Abandoned."), "archive with a held index lock", /git status/);
    fs.rmSync(lockFile);
    assert.equal(blocked.code, "PLAN_STORE_FAILED");
    assert.equal(head(store), before, "a failed commit commits nothing");
    assert.equal(storeBefore(), "", "a failed commit restores the store");
    assert.ok(fs.existsSync(inStore(backlog("arch-busy"))));

    // An untracked file in the plans worktree is a raw write too, so it is never committed by a move.
    fs.writeFileSync(inStore("plans/backlog/test-untracked.md"), planDoc({ id: "archuntr" }));
    assert.equal(refused(plans(root, "promote", "archuntr"), "promote an untracked plan", /uncommitted edits/).code, "PLAN_STORE_DIRTY");
    fs.rmSync(inStore("plans/backlog/test-untracked.md"));

    // A dependent bound to a worktree has one copy like any other, so it is cleared too.
    fs.writeFileSync(dependentFile, dependentBefore.replace("related: []", "related: []\nworktree: arch-bound"));
    git(store, "add", "--", backlog("arch-dep"));
    git(store, "commit", "--quiet", "-m", "Bind a dependent");
    const kept = approved(plans(root, "archive", "archbusy", "--reason", "Abandoned."), "archive with a bound dependent");
    assert.deepEqual(kept.references, { cleared: [backlog("arch-dep")] });
    assert.match(read(dependentFile), /^depends_on: \[\]$/m);
  }

  assert.equal(tryGit(root, "cat-file", "-e", "main:plans").status === 0, false, "no plan ever reaches the code branch");
  console.log("plan lifecycle transitions: ok");
} finally {
  fx.cleanup();
}
