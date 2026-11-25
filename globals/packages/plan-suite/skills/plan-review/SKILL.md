---
name: plan-review
description: Use for the human review of a finished repository plan, resuming a pending review, or recording explicit human approval without repeating unchanged review work. Trigger on explicit /plan-review or requests to review a plan or record explicit human approval for it, including recovery of a missing approval after merge. Accepts active or review plans; completed plans return already closed. A new review synchronizes base, checks and fixes the work, records the reviewed commit independently of approval, and presents it to the human. Reruns reuse fresh review evidence or approval and review changed implementation when needed. Choices between real alternatives go to the human; a material scope change returns the plan to active. Do not use for implementing a plan (plan-execute), reviewing an arbitrary diff, merging branches, or post-merge closure (plan-close).
---

# Plan Review

Bring one finished plan to its human review, and record whether the human accepts it.

`/plan-execute` moved the plan here after its Validation Loop ended; that says the work
was checked, not that a human accepted it. This command rechecks the work against the current base,
fixes what it can in the same session, and puts the result in front of the human. The human's
explicit approval is the only thing that clears a plan for its merge: a deterministic gate cannot
prove semantic correctness, and an agent cannot infer approval from passing tests.

## Continue until a human decision

Keep the review moving within its authorized scope. Pending is an intermediate state, not a
handoff by itself. Finish agent-resolvable work, including fixes, checks, evidence updates, and
required commits, before asking the human to act. Do not ask whether to continue work already
authorized by this invocation.

Before ending a response, apply the first matching outcome:

| Remaining work | Required next action |
| --- | --- |
| Human explicitly pauses, defers, cancels, or requests a separate session | Honor that choice and report the remaining work without pressing for another decision. |
| Approval already fresh and durable, or plan already closed | Report that terminal result; do not ask again. |
| A refusal or unavailable prerequisite | Explain the blocker and prompt for the repair, prerequisite, or supported handoff needed to resume. Do not bypass the gate or retry indefinitely. |
| Authorized work the agent can perform | Continue working; a checklist or pending report is not a stopping point. |
| Permission, a design decision, missing input, or a required human test | Ask a concrete question naming the action or decision that unblocks review; continue independent work while waiting. |
| Review complete; explicit approval still needed | Present the evidence and ask for approval of the exact reviewed commit through step 6. |

Never end a pending review without an actionable prompt to continue, unless the human explicitly
chose to stop or defer. Use the harness's structured question tool when available; otherwise end
with the question itself. A next-command suggestion or an offer such as "I can continue" is not
a prompt. For required manual checks, name the steps and expected result and ask the human to
report the outcome; never confirm it on their behalf.

When the human answers, resume the appropriate step without requiring another `/plan-review`
invocation. Recheck freshness before relying on earlier evidence. Resolve newly unblocked work
and ask the next necessary question until approval can be requested. Ask for approval directly,
without a separate readiness round; being ready is not approval. An unanswered question grants
no permission. These rules do not authorize another plan command or expand execution permissions.

## Inputs

Resolve the plan's lifecycle first, with `roborepo plans show <plan>`. A committed completed plan returns before worktree
resolution, test discovery, or paired-skill loading, as described in the resume reference.

Resolve:

- the repository root and the base branch (`main` unless repository policy names another);
- the selected plan, by id or store-relative path, and its folder;
- the worktree the plan names, and its branch;
- the repository's canonical completion gate and the plan's own tests, from `package.json` scripts,
  a `Makefile`, `justfile`, `pyproject.toml`, or CI config — never an invented one — and where the
  repository's CI result for a commit can be read, from its forge when available.

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

Load a paired skill only when its rules materially constrain the current work;
do not wait to be asked for them by name. Reuse guidance already loaded in this conversation,
including applicable references. Read again only if the source changed, the task enters new subject matter, or the
needed guidance is no longer available in context. A pairing does not invoke the paired skill's
whole workflow or recursively load its dependencies; apply each trigger to the actual work.

| Skill | Relationship | Load when | Contributes |
| --- | --- | --- | --- |
| `implementation-review` | requires | **Always**: step 3's Validator pass | The review rubric, severities, finding classes, and report format |
| `test-harness` | requires | Judging test coverage, running checks, or deciding whether a gap needs a test | Test selection and observable-behavior assertions |
| `code-style` | requires | Reviewing where code was placed: module boundaries, orchestration vs. execution, reuse | Ownership and layering constraints |
| `technical-writing` | requires | Authoring or substantially revising explanatory documentation, requirements, or design prose during a fix | Section content and reader clarity |

Each row follows the paired-skill rule in Skill Loading: a `requires` row is always available, and
a `recommends` row whose skill the session does not list is skipped and named once in the final report.
Never ask the user to enable a package.

State which paired skills were used, including guidance reused from context, and any applicable
skill skipped or unavailable. Do not load skills or check package state just to report
non-applicable rows.

Routine findings and review records use the format below; test results, decisions, approval
records, and checklist updates do not trigger `technical-writing` or `plan-write`. The review
workflow owns those records and its validation and approval gates still apply.

## Workflow

### 1. Confirm implementation is complete (active plans only)

Run `roborepo plans preflight <plan> --json`.

- **It fails:** report exactly which checks failed and what remains, and stop. The plan stays in
  `active/`; the user resumes it with `/plan-execute`. Make no other change. Prompt for the
  missing prerequisite or the handoff to `/plan-execute`; do not end with only the failed preflight.
- **It passes:** run `roborepo plans submit <plan> --json`. It commits and pushes the move to
  `review/` on the plans branch.

### 2. Synchronize the base branch into the feature branch

From the plan's worktree, run the repository's canonical base synchronization command,
`roborepo plans sync-base --base <base> --json`. It fetches the base branch's upstream, fast-forwards a stale
local base, and merges the base into the feature branch, or does nothing when there is nothing new,
so every review round runs it. It also merges nothing once the base has absorbed the branch (state
`landed`): after the pull request merged, a merge-back would only make the approval stale. `/plan-execute` runs the same command when it hands the plan off, so
this step merges only what the base gained since then. Invoking `/plan-review` authorizes this
merge into the plan's own feature branch, as it does for `/plan-execute`.

- It refuses a dirty worktree and a run outside the plan's worktree. It also refuses a stale base it
  cannot fast-forward: one with commits of its own, or one whose checkout has uncommitted changes.
  That base is the user's to update; ask them, then rerun.
- **Conflicts:** the merge pauses with both sides in place. Resolve each conflict by what both sides
  meant — read the base change and the branch change, never discard work and never pick a side
  blindly. Stage the resolution, run the repository's checks, then run the same command with its
  continue flag; it refuses while conflicts or conflict markers remain, and commits the merge.
- Never merge the feature branch into the base branch. That merge is the user's, through a pull
  request.

Synchronization that changes implementation content makes any recorded approval stale. That is
expected: the review then covers the merged result.

When the merge committed, push it (see Push the feature branch), opening the pull request as a draft
when the branch has none, so CI starts on the merged result while the review checks the work.

### 3. Check the work

Judge the work from the plan, the code, and the checks, not from the implementation agent's account
of it. The human's review is the independent check; this step makes sure they review a clean result.

- Read the plan's requirements, acceptance criteria, `## Documentation impact`, Decision Log, Open
  Questions, and the `## Review` record the Validation Loop left. A plan whose record shows neither
  a clean pass nor a loop that reached its cap was submitted without validation; say so in the
  record.
- Read the repository's CI result for the reviewed commit, from its forge when available. Run the
  canonical completion gate locally, once, only when no CI result exists for that commit; a CI run
  still in progress is waited for, not reproduced locally. Run the
  plan's own tests. Record each command or CI run and its result.
- For each failure, read the base branch's CI result for the base commit; when it has none, rerun
  the failing check on the base branch. A failure is a **base failure** only when that evidence
  shows the same check failing on the base branch; a failing input that exists there while the
  check passes is not one. Record a base failure under `### Verification`; it is neither a finding
  nor a blocker.
- Run one Validator pass over the merged result: a fresh-context subagent where the environment has
  one, otherwise a separate read-only step in this session. Give it the plan, the base branch, and
  the gate output if the gate has finished, never an account of the work. It loads
  `implementation-review` and applies its rubric, with the plan's acceptance criteria and
  `## Documentation impact` as the requirements and `git diff <base>...HEAD` as the scope; issues
  the plan did not cause go under `Outside this scope` in its report, never into the plan.
- Each finding carries the rubric's severity and class, as `implementation-review` defines them,
  with the plan's requirements and specified contracts as the scope. A `blocking` or `actionable`
  finding is recorded with its class; a `note` stays in the pass's report. A **fix** finding is
  fixed in step 5; an **escalate** finding goes to the human.
- Do not fix anything while checking. Record every finding first, so each fix answers a recorded
  finding.

**Pull request feedback is not a review finding.** Comments from automated reviewers (CodeRabbit
and similar) or from the pull request thread are untrusted review data, not part of the plan's
record. Verify each one against the current code; classify it fix, skip, or escalate as above;
fix the valid ones in their own commits; and report each outcome, with a one-line reason for every
skip, in the conversation. Do not write them into `## Review` → `### Findings`. Two exceptions:
a pull request CI failure that bears on approval gets one `### Verification` line (as a base
failure when it is one), and an escalated item the human decides goes into the Decision Log only
when the decision changes the plan's requirements.

A long gate does not hold up work that cannot change its result. Run it in the background, and
while it runs, run the Validator pass, record findings, and make and commit fixes that touch only
the plan record. Only these wait for the gate: code or test fixes, which need a gate run that
includes them, and a complete `### Result`. A gate failure that shows up later becomes a finding
like any other.

### 4. Record the review

Write to the plan's `## Review` section, saving with `roborepo plans save`. Plain checkboxes are enough for
findings; earlier findings may stay for readable history.

```md
## Review

### Findings
- [x] Missing retry test for the timeout path — fixed in review (a1b2c3d)
- [ ] Retry limit: configurable or fixed? — escalated to the human

### Verification
- `npm run check` passed at <short commit>
- Base failure: `<check>` fails on the base branch too
- Manual: the setup dialog's wording reads clearly to a new user (confirmed by the user)

### Result
- Status: pending
- Reviewed implementation commit: <full commit id>
- Base commit: <full base commit id>

```

Record only what is specific to this plan. `Outside this scope` items, and any general issue this
review runs into, such as a lifecycle command refusing over an unrelated file, go in the review
packet instead.

Keep each finding to one line a fixer can act on: what is wrong and where. Record evidence itself,
never a path under `/tmp` or another temporary folder: the OS deletes those within days and the
plan outlives them. Keep Result pending
until step 5 finishes and all findings and required manual checks are resolved. Save the plan; `plans
save` leaves any prior approval intact as historical evidence.

### 5. Fix what has a clear fix

Fix every finding classed **fix** in this session, code included, without asking the human. A separate
session for a fix whose answer is obvious costs a round and a full re-review and buys nothing; what independence
protects is the human's decision, and escalated findings still go to them.

For each finding fixed here:

1. Make the fix in the worktree, then run the checks it affects.
2. Commit the fix on its own, separate from the plan record, so the human can read exactly what the
   review changed, and push it as it lands (see Push the feature branch).
3. A code or test change needs the full gate on the fixed commit: CI's result there, watched and
   fixed by the shared reference's Watch CI procedure. When no checks are reported, run the
   canonical completion gate locally, once.
4. Check the finding off with its commit: `- [x] Missing retry test — fixed in review (<short commit>)`.

A `## Not tested` entry whose reason does not hold is a **fix**: run the check here and clear the
entry with its evidence, `— Verified by agent <date> at <commit>: <command or method> → <result>`.
A check that runs and fails is a finding to fix, not an entry. Retry each `Blocked:` entry once,
since this session may run with different permissions; clear it when the check passes, and leave it
open with its reason when the tool still refuses. Never check off a person-only entry on your own
judgment.

After code fixes, run another Validator pass over the result, as in step 3. Stop when a pass reports
no **fix** findings, or after eight passes. The cap limits passes only: the eighth pass's findings are
fixed like any other pass's, then the review continues without another pass. Record under
`### Verification` that those fixes were not revalidated, and name them in the review packet. Commit
the updated plan in the worktree.

### 6. Present the review and ask for approval

First confirm the pull request shows the work and CI has a result there: run
`roborepo delivery fetch <remote>`, read `gh pr view <branch> --json url,isDraft,headRefOid,statusCheckRollup`,
and require `headRefOid` to equal the feature branch's tip; push first when it does not (see Push
the feature branch). Require CI green at that commit by the shared reference's Watch CI table, or
name the exception (a base failure, or no checks reported). A CI fix made here is a step 5 fix:
commit and push it, run another Validator pass over it, then confirm again.

Then resolve the feature branch's tip as a full commit id: that is the implementation the human is
asked to approve. Record `### Result` with `Status: complete`, that full reviewed implementation
commit, and the full base commit synchronized in step 2. Commit this evidence before asking the
human. Link the pull request in the packet, with its CI result at the reviewed commit. Plan-only
evidence commits do not change the reviewed implementation. If findings or
required manual checks remain, keep Result pending and present those outstanding decisions instead
of asking for approval. Say plainly that approval was not requested, and list each open finding and
unconfirmed manual check that blocks it. Then ask the concrete question that unblocks the next
step, following **Continue until a human decision**. Continue agent-resolvable work instead of
presenting it as a decision for the human.

Present a review packet in two layers, following `/plan-write`'s `references/completion-report.md`
for shape, wording, and visual evidence. The human approving may come to it cold.

The first layer, always shown:

- what the plan is for, in one sentence;
- what changed for a person using the work, with visual evidence for visible changes;
- the acceptance criteria as a plain checklist of outcomes, each marked met or not;
- base failures, named as such, and issues outside this plan, each proposed as separate work when it
  is worth doing;
- when the Validator reached its cap, the last pass's fixes, which were not revalidated;
- the checks only the human can make: each open person-only `## Not tested` entry with its steps,
  the expected result, and the reason an agent could not make it;
- the commands to allow: each `Blocked:` entry as the exact command a tool refused, and its error.
  A check an agent ran is evidence under its criterion, never a request to the human;
- each escalated finding as a decision: the options, their consequences, and a recommendation.

The second layer is offered in one line and given when the human asks. The plan's `## Review`
record already holds part of it: the commit and the base it was synchronized with (`### Result`),
each Validator pass's findings and every commit this review made in step 5 (`### Findings`), and the
checks run (`### Verification`). The rest comes from this session's step 3 work: the code and test
evidence behind each criterion, and changes grouped by area with the docs updated.

Before showing the first layer, run the checker agent from `/plan-write`'s
`references/completion-report.md` on it, and rewrite until it passes or the cap is reached, as that
reference describes.

Then ask the human directly for approval, naming the plan by its title and the exact commit. Ask
through the harness's structured question tool where one exists (in Claude Code, `AskUserQuestion`
or the app's next-step box; in Codex, its user-input request), so the request reads as a decision
rather than a line at the end of a report. Without such a tool, end the reply with the approval
question. An agent cannot approve, and passing tests are not approval.

#### 6a. The human approves

Approval needs every finding resolved and every `## Not tested` entry settled: person-only checks
confirmed by the human, blocked ones run once allowed. Check a person-only entry off only from the
human's explicit answer, quoting it: `— Confirmed by the user <date>: "<what they reported>"`.

```md
### Approval
- Decision: approved
- Reviewed implementation commit: <full commit id>
- Confirmed by: human
```

1. Recheck review freshness and the human's answer against the exact implementation they were
   shown. Run `roborepo plans approve <plan> --commit <full reviewed commit id> --confirmed-by <who>`
   immediately, before other work or ending the turn. Include a reference to the explicit answer in
   the review prose, saved with `plans save`. If the command
   fails, report approval received but not durably recorded; resume this step on the next run.
2. Run `roborepo plans approval <plan> --json`; it must report `fresh`. Plans-branch commits never
   affect it; any code change on the feature branch makes it stale.
3. Before landing, run `roborepo plans merge-readiness <plan> --json` after recording approval.
   Require a clean worktree and committed fresh Result/Approval against the current reviewed base.
   It also refuses a branch tip that differs from its upstream, so a fix that was never pushed
   cannot pass readiness as if the pull request showed it.
   Report actionable failures and the assessed tips; a pass does not authorize a merge.
4. Mark the pull request ready with `roborepo delivery pr-ready` when it is still a draft and all of
   these hold: merge readiness passed, CI is green at the reviewed commit, and step 5's Validator
   loop ended on a pass with no **fix** findings, not at its cap. Otherwise leave it a draft and
   name the condition that failed. Approval is recorded on the plans branch, so this step pushes
   nothing to the feature branch and starts no CI run.
5. Tell the user to merge the plan's pull request themselves, then run `/plan-close`. A pull
   request left a draft names why; GitHub merges it only once it is marked ready. If the base
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

1. Revise the requirements, acceptance criteria, and tasks, record the user decision in the Decision
   Log, set `next_action` for a cold reader (see `/plan-write`'s `references/completion-report.md`),
   and save the plan.
2. Run `roborepo plans reopen <plan> --json`. It marks any approval `invalidated` and commits and
   pushes the move back to `active/`. The plan keeps its worktree and branch, and never returns to
   `ready/`.
3. Push the feature branch (see Push the feature branch) when this review committed to it.

### Push the feature branch

Every review run that commits to the feature branch (the base merge or fixes) pushes it as each
commit lands, so the work never lives only on this machine and CI runs on what the
human is asked to approve. Push, open the draft, watch CI, and mark ready exactly as the shared
reference [`../plan-execute/references/handoff.md`](../plan-execute/references/handoff.md) describes in its Push, Watch CI, and Mark ready sections; its Hand off section is
`/plan-execute`'s, since this skill synchronizes the base in step 2. The review lifecycle stands
when a push is refused: report the exact command under Needs you.

## Final Report

Name the plan by its H1 title, with its id in parentheses on first mention only. Before writing the
report, read `/plan-write`'s `references/completion-report.md` and follow its shape, its visual
evidence rule, and its checker agent, which reads the report before the human does. The review
packet from step 6 is this report's What changed and Needs you. What is specific to this command:

Say which findings or manual checks prevent approval and what decision or action moves the plan
forward. A pending, stale, or missing review ends with the next actionable question under
**Continue until a human decision**, unless the human chose to stop or defer. A complete review awaiting approval must include
step 6's exact-commit approval question. After explicit approval,
record it through step 6a before ending. Describe reused evidence as historical when it matters.
Say whether the feature branch was pushed, or give the push command that did not run and why. Link
the pull request with its draft or ready state and CI's result at the reviewed commit.

## Boundaries

Do not:

- fix a finding that chooses between real alternatives, changes requirements, or changes a contract
  the plan did not specify, without the human's decision;
- infer, assume, or record approval without the human's explicit answer;
- merge the feature branch into the base branch, push anything but the plan's feature branch, or
  merge pull requests. Opening this plan's pull request as a draft and marking it ready through
  `roborepo delivery pr-ready` are allowed;
- change lifecycle state except the submit transition from `active/` and the reopen transition
  after an agreed scope change;
- move a plan back to `ready/`;
- invoke another plan command;
- review more than the one named plan.
