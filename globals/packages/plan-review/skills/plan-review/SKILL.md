---
name: plan-review
description: Use for the human review of a finished repository plan, resuming a pending review, or recording explicit human approval without repeating unchanged review work. Trigger on explicit /plan-review or requests to review a plan or record explicit human approval for it, including recovery of a missing approval after merge. Accepts active or review plans; completed plans return already closed. A new review synchronizes base, checks and fixes the work, records the reviewed commit independently of approval, and presents it to the human. Reruns reuse fresh review evidence or approval and review changed implementation when needed. Choices between real alternatives go to the human; a material scope change returns the plan to active. Do not use for implementing a plan (plan-execute), reviewing an arbitrary diff, merging branches, or post-merge closure (plan-close).
---

# Plan Review

Bring one finished plan to its human review, and record whether the human accepts it.

`/plan-execute` moved the plan here after its Validation Loop came back clean; that says the work
was checked, not that a human accepted it. This command rechecks the work against the current base,
fixes what it can in the same session, and puts the result in front of the human. The human's
explicit approval is the only thing that clears a plan for its merge: a deterministic gate cannot
prove semantic correctness, and an agent cannot infer approval from passing tests.

## Inputs

Resolve the primary plan's lifecycle first. A committed completed plan returns before worktree
resolution, test discovery, or paired-skill loading, as described in the resume reference.

Resolve:

- the repository root, the primary checkout (first `worktree` entry of
  `git worktree list --porcelain`), and the base branch (`main` unless repository policy names
  another);
- the selected plan, by id or path, and its folder in the primary checkout;
- the worktree the plan names, its branch, and the worktree's copy of the plan — the authoritative
  copy while the plan is in `active/` or `review/`;
- the repository's canonical completion gate and the plan's own tests, from `package.json` scripts,
  a `Makefile`, `justfile`, `pyproject.toml`, or CI config — never an invented one.

| Folder | This run |
| --- | --- |
| `active/` | Step 1, then the review. |
| `review/` | Resolve the resume path below before synchronizing or running checks. |
| `completed/` | Confirm committed completion, report already closed, and stop. Do not reopen review because its worktree was cleaned up. |
| anything else | Refuse, naming the folder and the command that fits it. |

## Resume before repeating work

Always read [references/resume-review.md](references/resume-review.md) before starting the workflow.
It routes fresh approvals to an unchanged success result, completed reviews to the pending approval
step, and changed implementations to review of the changes. Review completion and human approval
are separate records; never turn completed checklists, passing tests, or landing into approval.
Do not synchronize base, rerun the gate, or request approval again before applying that routing.

## Paired Skills

Load these when the run calls for them; do not wait to be asked for them by name.

| Skill | Load when | Contributes |
| --- | --- | --- |
| `test-harness` | Judging test coverage, running checks, or deciding whether a gap needs a test | Test selection and observable-behavior assertions |
| `code-style` | Reviewing where code was placed: module boundaries, orchestration vs. execution, reuse | Ownership and layering constraints |
| `technical-writing` | Writing findings and the review record | Section content and reader clarity |

Each row is its own optional package, so check it before loading it:

1. Check the host's skill/package manager for `<skill>` and read its availability and activation state.
2. If `available` is true, `enabled` is true, and `status` is `enabled` or `configured`, load it.
3. If it is disabled, ask: "`<skill>` is not enabled. Enable it, or skip it for this run?"
   - **Enable:** use the host's package manager to enable `<skill>` with the user's permission, then load it.
   - **Skip:** continue without it, and name it as skipped in the final report.
4. If `enabled` and `status` disagree (`partial`, `external`), report the status, offer
   the host's package reconciliation command or skip, and never describe a drifted package as loaded.
5. If it is `missing` or `unavailable`, skip it and say so in the final report.

## Workflow

### 1. Confirm implementation is complete (active plans only)

Run the repository's canonical completion preflight command for `<plan>` from the primary checkout.

- **It fails:** report exactly which checks failed and what remains, and stop. The plan stays in
  `active/`; the user resumes it with `/plan-execute`. Make no other change.
- **It passes:** run the repository's canonical submit transition command for `<plan>` from the
  primary checkout. It commits the plan-only move to `review/` on the base branch. Do not push.

### 2. Synchronize the base branch into the feature branch

From the plan's worktree, run the repository's canonical base synchronization command. It merges the
base branch into the feature branch, and does nothing when there is nothing new, so every review
round runs it.

- It refuses a dirty worktree, a run from the primary checkout, and a local base branch that is
  behind its upstream. A stale base is the user's to update; ask them, then rerun.
- **Conflicts:** the merge pauses with both sides in place. Resolve each conflict by what both sides
  meant — read the base change and the branch change, never discard work and never pick a side
  blindly. Stage the resolution, run the repository's checks, then run the same command with its
  continue flag; it refuses while conflicts or conflict markers remain, and commits the merge.
- The move the primary checkout committed arrives through this merge. When Git cannot pair the
  rename, the command keeps the worktree's content at the plan's new path and reports it.
- Never merge the feature branch into the base branch. That merge is the user's, through a pull
  request.

Synchronization that changes implementation content makes any recorded approval stale. That is
expected: the review then covers the merged result.

### 3. Check the work

Judge the work from the plan, the code, and the checks, not from the implementation agent's account
of it. The human's review is the independent check; this step makes sure they review a clean result.

- Read the plan's requirements, acceptance criteria, `## Documentation impact`, Decision Log, Open
  Questions, and the `## Review` record the Validation Loop left. A plan without a clean validation
  record was submitted without one; say so in the record.
- Run the repository's canonical completion gate and the plan's own tests. Record each command and
  result.
- For each failure, rerun the failing check on the base branch, or show its failing input exists
  there. A failure the base branch has too is a **base failure**: record it under
  `### Verification`, and it is neither a finding nor a blocker.
- Run one Validator pass over the merged result: a fresh-context subagent where the environment has
  one, otherwise a separate read-only step in this session. Give it the plan, the base branch, and
  the gate output, never an account of the work. It applies the same rubric as `/plan-execute`'s
  Validation Loop: every acceptance criterion against the code and test evidence (a checked task is a
  claim, not evidence), tests that assert observable outcomes for new behavior, docs of record that
  match the code, `## Not tested` entries an agent could run instead, each gate failure, and the
  constraints of every loaded paired skill where the diff falls under them.
- Classify every finding by consequence, not size: **fix** when the right fix is clear and stays
  within the plan's requirements and specified contracts, code included; **escalate** when it
  chooses between real alternatives, changes requirements or a contract the plan did not specify,
  or lands outside the plan.
- Do not fix anything while checking. Record every finding first, so each fix answers a recorded
  finding.

### 4. Record the review

Write to the `## Review` section in the worktree's copy of the plan. Plain checkboxes are enough for
findings; earlier findings may stay for readable history.

```md
## Review

### Findings
- [x] Missing retry test for the timeout path — fixed in review (a1b2c3d)
- [ ] Retry limit: configurable or fixed? — escalated to the human

### Verification
- `npm run check` passed at <short commit>
- Base failure: `<check>` fails on the base branch too
- Manual: the setup dialog enables every component (confirmed by the user)

### Result
- Status: pending
- Reviewed implementation commit: <full commit id>
- Base commit: <full base commit id>

### Approval
- Decision: requested
```

Keep each finding to one line a fixer can act on: what is wrong and where. Keep Result pending
until step 5 finishes and all findings and required manual checks are resolved. Commit the plan in
the worktree as a plan-only commit; leave any prior approval intact as historical evidence rather
than replacing it with an implied new approval.

### 5. Fix what has a clear fix

Fix every finding classed **fix** in this session, code included. A separate session for a fix
whose answer is obvious costs a round and a full re-review and buys nothing; what independence
protects is the human's decision, and escalated findings still go to them.

For each finding fixed here:

1. Make the fix in the worktree, then run the checks it affects. After any code or test change,
   rerun the repository's canonical completion gate.
2. Commit the fix on its own, separate from the plan record, so the human can read exactly what the
   review changed.
3. Check the finding off with its commit: `- [x] Missing retry test — fixed in review (<short commit>)`.

After code fixes, run another Validator pass over the result, as in step 3. Stop when a pass reports
no **fix** findings, or after five passes, leaving the rest open and reporting them. Commit the
updated plan in the worktree.

### 6. Present the review and ask for approval

Resolve the feature branch's current tip as a full commit id: that is the implementation the human
is asked to approve. Record `### Result` with `Status: complete`, that full reviewed implementation
commit, and the full base commit synchronized in step 2. Commit this evidence before asking the
human. Plan-only evidence commits do not change the reviewed implementation. If findings or
required manual checks remain, keep Result pending and present those outstanding decisions instead
of asking for approval.

Present a review packet:

- the plan, the commit, and the base it was synchronized with;
- each acceptance criterion with the code and test evidence that meets it;
- what changed, grouped by area, with the docs updated;
- each Validator pass and what it found;
- every commit this review made in step 5;
- base failures, named as such;
- the manual checks that need the human, from `## Not tested`;
- each escalated finding as a decision: the options, their consequences, and a recommendation.

Then ask the human directly for approval, naming the plan by its title and the exact commit. An agent cannot approve, and passing tests are not
approval.

#### 6a. The human approves

Approval needs every finding resolved and every required manual check confirmed by the human.

```md
### Approval
- Decision: approved
- Reviewed implementation commit: <full commit id>
- Confirmed by: human
```

1. Recheck review freshness and the human's answer against the exact implementation they were
   shown. Write `### Approval` with `Decision: approved`, that full reviewed commit id, and who
   confirmed it, then commit it immediately as a plan-only change before other work or ending the
   turn. Include a reference to the explicit answer in the review prose. If the write or commit
   fails, report approval received but not durably recorded; resume this step on the next run.
2. Run the repository's canonical approval check for `<plan>`; it must report `fresh`. Plan-only
   commits after approval keep it fresh; any change outside `docs/plans/` makes it stale.
3. Tell the user to open and merge the pull request themselves, then run `/plan-close`. If the base
   branch moves before that merge, the user reruns `/plan-review`; `/plan-close` never
   synchronizes, and it refuses a stale approval.

For an approval-only resumption or post-merge recovery, use the write location and verification
procedure in `references/resume-review.md`; do not restart steps 1–5.

#### 6b. The human asks for changes or decides an escalation

Record each request or decision as a finding, with the decision in the Decision Log.

- Within the requirements: fix it in this session as in step 5, then present again from step 6.
- The human wants it done in a separate session: leave the plan in `review/` and tell them to run
  `/plan-execute` on it, then `/plan-review` again. Do not invoke either command yourself.

#### 6c. A material change to scope or acceptance criteria

When review shows the requirements themselves must change, this is the human's decision. Present
the proposed change and its consequences, and wait for an explicit answer.

On agreement:

1. Revise the requirements, acceptance criteria, and tasks in the worktree's copy, record the user
   decision in the Decision Log, and set `next_action`.
2. Invalidate any approval: set `- Decision: invalidated` in `### Approval`.
3. Commit the plan in the worktree.
4. From the primary checkout, run the repository's canonical reopen transition command for `<plan>`.
   It commits the plan-only move back to `active/`. The plan keeps its worktree and branch, and
   never returns to `ready/`.

## Final Report

Name the plan by its H1 title, with its id in parentheses on first mention only. The id is the
stable reference for commands and frontmatter, not a name a person recognizes; the same goes for
questions, review packets, and other prose in this run.

```text
Review result
- Plan: "<title>" (<id>), <repository-relative path>
- Resume path: full review | changes since review | approval only | already approved | already closed
- Completion preflight: passed | failed with <checks> | not run (<resume reason>)
- Lifecycle change: active -> review | review -> active | none
- Base synchronization: up-to-date | merged <commit> | conflicts resolved <commit> | refused (<reason>) | not rerun (<resume reason>)
- Tests: <command> -> pass|fail | reused at <commit> | not rerun (already approved|already closed)
- Base failures: <checks that fail on the base branch too, or "none">
- Validator passes: <count>, clean | stopped at the cap with <count> open | reused at <commit> | not rerun (<resume reason>)
- Findings: <open count> open, <count> fixed in review (<commits>), <count> escalated
- Not tested entries open: <count>
- Review result: complete at <commit> | pending | stale | missing
- Approval: approved at <commit> | requested | not requested | invalidated
- Approval freshness: fresh | stale | missing | not-approved | invalid | unavailable
- Next command: merge the pull request, then /plan-close | /plan-close (already landed) | /plan-review | /plan-execute | none (already closed)
```

Also report the evidence behind each finding, the verification commands and results, paired skills
loaded or skipped, and current Git status in the worktree and the primary checkout.
Label historical checks as reused. Skills and checks bypassed by an unchanged success path are
not applicable to this run; never present them as newly performed. Report unavailable worktree
status as expected after completed cleanup.

## Boundaries

Do not:

- fix a finding that chooses between real alternatives, changes requirements, or changes a contract
  the plan did not specify, without the human's decision;
- infer, assume, or record approval without the human's explicit answer;
- merge the feature branch into the base branch, push, open or merge pull requests;
- change lifecycle state except the submit transition from `active/` and the reopen transition
  after an agreed scope change;
- move a plan back to `ready/`;
- invoke another plan command;
- review more than the one named plan.
