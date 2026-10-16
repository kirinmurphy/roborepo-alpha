---
name: plan-review
description: Use to independently review a finished repository plan before its pull request merges. Trigger on explicit /plan-review or requests to independently review a plan or record explicit human approval for it. Accepts a plan in active, where it first runs the completion preflight and commits the move to review, or in review. It merges the base branch into the feature branch, checks the implementation against the plan's requirements independently of the implementation agent, records concise findings and verification in the plan, fixes additive findings itself (tests that only add coverage, doc and evidence corrections), and asks the human to record explicit human approval for the reviewed implementation commit. Corrections within the requirements stay in review; a material scope change returns the plan to active. Rerun after fixes. Do not use for fixing review findings that change behavior (plan-execute), reviewing an arbitrary diff, merging branches, or post-merge closure (plan-close).
---

# Plan Review

Review one finished plan independently, and record whether a human accepts it.

Implementation completion moved the plan here; it did not say the work is right. This command is
the independent check, and the human's explicit approval is the only thing that clears a plan for
its merge. A deterministic gate cannot prove semantic correctness, and an agent cannot infer
approval from passing tests.

## Inputs

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
| `review/` | The review, from step 2. A rerun after `/plan-execute` fixed findings starts here too. |
| anything else | Refuse, naming the folder and the command that fits it. |

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

### 3. Review independently

Judge the work from the plan and the code, not from the implementation agent's account of it. Run
this in a separate session from the one that implemented the plan; if that is not possible, say so
in the review record.

- Read the plan's requirements, acceptance criteria, `## Documentation impact`, Decision Log, and
  Open Questions.
- Read the full diff between the base branch and the feature branch.
- Run the repository's canonical completion gate and the plan's own tests. Record each command and
  result.
- Check every acceptance criterion against the code and the test evidence. A checked task is a
  claim, not evidence.
- Check that new behavior has tests that assert observable outcomes, and that docs of record match
  the code.
- Check every `## Not tested` entry: attempt the checks an agent can run, and list the manual ones
  for the human.
- Do not fix anything while reviewing. Record every finding first, so each fix answers a recorded
  finding and the review judges the work as it was handed over. Step 5 then fixes the additive ones.

### 4. Record the review

Write a small `## Review` section in the worktree's copy of the plan. Plain checkboxes are enough for
findings; earlier findings may stay for readable history.

```md
## Review

### Findings
- [ ] Missing retry test for the timeout path
- [x] Error handling gap — corrected

### Verification
- `npm run check` passed at <short commit>
- Manual: the setup dialog enables every component (confirmed by the user)

### Approval
- Decision: approved
- Reviewed implementation commit: <full commit id>
- Confirmed by: human
```

Keep each finding to one line a fixer can act on: what is wrong and where. Commit the plan in the
worktree as a plan-only commit.

### 5. Fix additive findings

Some findings add to the work without changing what it does. Fixing those here saves a separate
`/plan-execute` round without giving up independence, because nothing the reviewer writes changes
the behavior it judged. Everything else goes to `/plan-execute`, so the reviewer never approves its
own design.

| Fix here | Leave for `/plan-execute` |
| --- | --- |
| A test that only adds coverage of behavior the code already has | Any change to what code does, including a bug fix |
| A correction to a doc, comment, or error message that is demonstrably wrong | A choice between real alternatives |
| Plan evidence: `### Verification`, `## Not tested` wording, checked tasks that are actually done | A change to a public interface, command, file format, or contract |
| A typo or a broken link | Anything outside the plan's requirements |

When a finding is not clearly in the first column, leave it for `/plan-execute`. A new test that
fails has found a behavior defect: drop the test, and record the defect as a finding for
`/plan-execute` instead.

For each finding fixed here:

1. Make the fix in the worktree, then run the checks it affects. After any code or test change,
   rerun the repository's canonical completion gate.
2. Commit the fix on its own, separate from the plan record, so the human can read exactly what the
   reviewer changed.
3. Check the finding off with its commit: `- [x] Missing retry test — fixed in review (<short commit>)`.

Commit the updated plan in the worktree. Then take exactly one of these outcomes.

### 6a. Findings within the requirements

Leave the plan in `review/`. Tell the user to run `/plan-execute` on this plan in a separate session
to fix the open findings, then `/plan-review` again. Do not invoke either command yourself.

### 6b. A material change to scope or acceptance criteria

When review shows the requirements themselves must change, this is the user's decision. Present the
proposed change and its consequences, and wait for an explicit answer.

On agreement:

1. Revise the requirements, acceptance criteria, and tasks in the worktree's copy, record the user
   decision in the Decision Log, and set `next_action`.
2. Invalidate any approval: set `- Decision: invalidated` in `### Approval`.
3. Commit the plan in the worktree.
4. From the primary checkout, run the repository's canonical reopen transition command for `<plan>`.
   It commits the plan-only move back to `active/`. The plan keeps its worktree and branch, and
   never returns to `ready/`.

### 6c. No open findings: ask for approval

When every finding is resolved and every required manual check has been confirmed by the user:

1. Resolve the feature branch's current tip as a full commit id. That is the implementation being
   approved.
2. Ask the human directly for approval, naming the plan, the commit, the verification performed,
   and every commit this review made in step 5. An agent cannot approve, and passing tests are not
   approval.
3. **Approved:** write `### Approval` with `Decision: approved`, the full commit id, and who
   confirmed it, then commit it in the worktree. Run the repository's canonical approval check for
   `<plan>`; it must report `fresh`. Plan-only commits after approval keep it fresh; any change
   outside `docs/plans/` makes it stale.
4. **Not approved:** record the human's reasons as findings and continue as 6a or 6b.

After approval, tell the user to open and merge the pull request themselves, then run
`/plan-close`. If the base branch moves before that merge, the user reruns `/plan-review`;
`/plan-close` never synchronizes, and it refuses a stale approval.

## Final Report

```text
Review result
- Plan: <id and repository-relative path>
- Completion preflight: passed | failed with <checks> | not run (already in review)
- Lifecycle change: active -> review | review -> active | none
- Base synchronization: up-to-date | merged <commit> | conflicts resolved <commit> | refused (<reason>)
- Tests: <command> -> pass|fail
- Findings: <open count> open, <resolved count> resolved, <count> fixed in review (<commits>)
- Not tested entries open: <count>
- Approval: approved at <commit> | requested | not requested | invalidated
- Approval freshness: fresh | stale | missing
- Next command: /plan-execute | /plan-review | merge the pull request, then /plan-close
```

Also report the evidence behind each finding, the verification commands and results, paired skills
loaded or skipped, and current Git status in the worktree and the primary checkout.

## Boundaries

Do not:

- fix a finding that changes behavior, chooses between alternatives, or changes a contract, or edit
  implementation code beyond what an additive fix in step 5 needs;
- infer, assume, or record approval without the human's explicit answer;
- merge the feature branch into the base branch, push, open or merge pull requests;
- change lifecycle state except the submit transition from `active/` and the reopen transition
  after an agreed scope change;
- move a plan back to `ready/`;
- invoke another plan command;
- review more than the one named plan.
