---
name: plan-execute
description: Use when starting, resuming, or fixing the implementation of a prepared repository plan. Accepts a plan in ready, active, or review. From ready it will create or safely reuse an isolated worktree and commit the start transition; in active it resumes in the recorded worktree; in review it fixes only the findings review sent back. It implements every in-scope unblocked objective without milestone check-ins, logs autonomous decisions, queues blocked questions for the end, then runs a validation loop in which a fresh-context validator checks the work and the agent fixes what it finds until a pass is clean or the eight-pass cap is reached, and moves the plan to review once that loop has ended, the completion preflight passes, and CI on the pull request is not blocked. Safe to rerun across sessions. Do not use for preparing a backlog plan (plan-promote), the human review or approval (plan-review), post-merge closure (plan-close), archiving (plan-archive), or implementation without an existing plan.
---

# Plan Execute

Start, resume, or fix the implementation of one prepared plan.

The goal is to carry the plan through every in-scope, unblocked objective while minimizing
unnecessary interruptions, and to preserve a clear record of decisions, verification, blockers, and
execution context, across as many sessions as the work takes.

## Inputs

Resolve:

- the repository root;
- the selected plan document and its lifecycle folder;
- repository instructions;
- relevant installed code-style and language skills;
- current Git state;
- existing branches and worktrees;
- `plans/plans-config.json` from the plans worktree, for `worktreeRoot` and `worktreeRepoName`.

The existing plan is the implementation contract. Verify it against the current repository before relying on it.

## Where the plan is

Read the plan with `roborepo plans show <plan>` first; its folder decides what this run does. A command never
repeats a transition that has already happened: it continues from the state it finds.

| Folder | This run |
| --- | --- |
| `backlog/` | Refuse. The plan has not been prepared; direct the user to `/plan-promote`. |
| `ready/` | Preflight, the Start Transition, Enter the Worktree, then the Implementation Workflow. |
| `active/` | Resume: reuse the worktree the plan names, Enter the Worktree, then the Implementation Workflow from the first open task. |
| `review/` | Fix findings: Enter the worktree the plan names, then the Review Findings workflow only. |
| `completed/`, `archived/` | Refuse, naming the folder. |

An active or review plan whose recorded worktree no longer exists is a blocker: report it. With the
user's agreement, for an active plan, create a new worktree and rerun the canonical start transition
command with the new name, which records it in place. A review plan cannot take a new worktree name:
recreate the linked worktree under the recorded name on the plan's branch, so the approval check can
resolve it.

## Paired Skills

Load these by subject matter while implementing; do not wait to be asked for them by name.

| Skill | Relationship | Load when | Contributes |
| --- | --- | --- | --- |
| `implementation-review` | requires | Every Validator pass (see Validation Loop) | The review rubric, severities, finding classes, and report format |
| `test-harness` | requires | The work adds or changes tests, verification commands, or fixtures | Test selection and observable-behavior assertions |
| `code-style` | requires | The work places code: module boundaries, orchestration vs. execution, reuse | Ownership and layering constraints |
| `feature-verification` | requires | Delivered UI, server, API, CLI, permission, or performance behavior needs a demonstration beyond routine test reporting | Select and show the fastest sufficient behavioral evidence; reuse existing captures and execution output |

Each row follows the paired-skill rule in Skill Loading: a `requires` row is always available, and
a `recommends` row whose skill the session does not list is skipped and named once in the final report.
Never ask the user to enable a package.

State which paired skills applied and which did not — a skipped skill and a forgotten one look
identical otherwise.

## Run Mode

Work until the plan runs out of unblocked tasks. A run ends only when every in-scope task is either
done or blocked by an open question or external blocker.

- Do not stop for milestone, phase, or slice check-ins. Finishing a phase is a reason to start the
  next one, not to report.
- Do not ask the user anything during implementation. Questions go into the Open Questions queue
  (see Blocker Policy) and are asked together, once, at the end.
- The exceptions are the gates that come before implementation can start at all: a repository with
  no plan store and a refused start transition. With no worktree, no task
  is unblocked, so these stop and ask immediately.
- When the user answers the batched questions, each answer unblocks its tasks and the run resumes in
  this same mode: record the answer in the Decision Log, continue until no unblocked tasks remain,
  and batch any new questions again.
- Never invoke the next command. `/plan-review` is started by the user, normally in a separate
  session. Ending a session never implies that a stage is complete.

## Preflight

1. Read the entire selected plan.
2. Inspect the current repository state and material plan claims.
3. Detect whether the plan has become stale or materially incomplete. Run
   the repository's canonical plan validator for the deterministic document findings; it does not check the
   plan's claims against code, so step 2 still applies.
4. Note which Paired Skills rows the plan's subject matter calls for, and which of those the session lists.
5. Read `plans/plans-config.json` from the plans worktree. New worktrees resolve under
   `<worktreeRoot>/<worktreeRepoName>/<branch>`, without asking. A repository with no plan store is
   not set up: refusals name `roborepo plans init`, and `/plan-suite-init` runs it.
6. Resolve the worktree policy.
7. Inspect existing worktrees before creating another one.
8. Reuse a worktree only when it clearly matches the repository and intended branch and is safe to continue.
9. Refuse to reuse a dirty, ambiguous, unrelated, or conflicting worktree.
10. Create an isolated feature worktree when a safe matching workspace does not exist.
11. Use platform path APIs for `~` expansion and path joining so the same default resolves correctly
    on macOS, Linux, and Windows.
12. Keep absolute worktree paths out of repository plan documents.
13. Record:
    - worktree path;
    - Git administrative worktree name;
    - branch;
    - base branch;
    - starting commit.
14. Update the plan only through `roborepo plans save`, by the "Plan store" rule in `/plan-write`'s
    `references/plan-schema.md`, from whichever checkout you are in. That includes Decision Log, Open
    Questions, and `## Not tested` entries. The plan is never a file on the feature branch.

When deterministic repository commands exist for an operation, use them instead of reconstructing the mutation manually.

## Start Transition

Only a plan in `ready/` takes this step. Read `references/start-validation.md` before running the
transition. It describes what the start transition command does, the validator checks it runs, and
how to act on a refusal.

Run the transition after the target worktree is resolved and before any implementation:

1. Resolve the target's Git administrative worktree name — not the checkout directory's basename,
   and never a branch name or absolute path.
2. Run `roborepo plans start <plan> --worktree <name> --json`, from any checkout. It writes
   `worktree: <name>` into the plan, moves it from `ready/` to `active/` (keeping its filename and
   `id`), commits only the old and new plan paths to the plans branch, and pushes. A refusal is a
   reason to stop and ask the user.
3. The same command then runs the start validator against fresh disk and Git state.
4. Enter the implementation worktree only after the validator returns `APPROVED`. Apply each failed
   check's `fix` and rerun; the validator gets at most three correction passes, and a final refusal
   blocks this plan and is reported, never worked around.
5. Plan links the result lists under `staleLinks` still name the old `ready/` path. Fix them with
   `roborepo plans save`.
6. `synchronized: false` in the result means the remote could not be reached or refused the push (a
   hook or branch rule); `reason` says which. The commit is kept and a later store command pushes it
   once the remote can be reached and accepts it, so continue, and mention it in the final report.

## Enter the Worktree

Before the first edit, make the worktree the session's working directory. Writes are allowed without
a prompt only inside the checkout the session is working in, so a session still rooted in another
checkout asks for permission on every file it edits in the worktree.

- If the execution environment requires explicit access to a linked worktree, request that access
  once using the environment's standard mechanism, then make the worktree the session's working
  directory. Follow repository-local access instructions when they exist.

This is part of the pre-implementation gate: one approval,
then the run proceeds without questions.

## Implementation Workflow

1. Reconcile any minor stale details that are obvious and safe to fix.
2. Identify the plan's in-scope objectives, acceptance criteria, dependencies, and blockers. On a
   resumed run, start from the first unchecked task and the plan's `next_action`.
3. Build a working task sequence from the existing plan.
4. Implement one coherent slice at a time.
   Update each doc of record listed under `## Documentation impact` with the behavior it describes.
   Check the repository's doc-of-record map, when one exists, for docs newly affected by the
   implementation and update those too. For an older plan without that section, derive the affected
   docs from the implementation scope. Include these doc changes in the implementation commit.
5. Run the smallest useful verification after each slice.
6. Continue until every in-scope, unblocked objective has been addressed, without pausing between
   phases or milestones.
7. Keep the plan synchronized with:
   - the Decision Log and Open Questions sections;
   - the `## Not tested` section;
   - scope corrections;
   - blockers;
   - completed work;
   - verification results;
   - a `next_action` that names the next concrete step, written for a cold reader as
     `/plan-write`'s `references/completion-report.md` describes.
8. Do not silently omit objectives.
9. Do not expand into unrelated cleanup.
10. Perform a final comparison between:
    - the plan;
    - the implementation diff;
    - runtime behavior;
    - acceptance criteria.
11. Set up and start the repository-appropriate test/development environment or build that
    exercises the delivered behavior. Determine how to do this from the repository's own
    instructions, scripts, configuration, and conventions; do not assume a universal framework,
    command, or launch rule. Start it where the user's own tooling can find it:
    - Make the target worktree the process's working directory; a script path into the worktree
      run from another folder is not enough. Tools that map a running server to a checkout read
      the process's working directory, so that server is filed under the other folder's branch.
      A harness launch configuration that starts the server must also change into the worktree.
    - Use the user's normal local state and configuration by default. Isolate them (a scratch data
      directory or state root) only when exercising the change would write state the user would
      not want touched, such as a migration, a first-run flow, or a destructive action. Isolated
      servers may be hidden from the user's tooling, so the handoff says it is isolated and why.
    - Leave it running for manual verification, and open its URL in the harness's browser pane
      when one exists (in the Claude desktop app, `preview_start` with the URL).
    Report the URL in the handoff. If the repository cannot expose a link, record what was started
    and why no link is available.
12. Run completion-level verification, including manual verification against the started
    environment when applicable, and attempt every `## Not tested` entry (see Not Tested). Apply
    the behavioral evidence handoff below before committing.
13. Re-read Git status and the implementation diff in the target worktree, then commit the
    completed implementation changes there with a descriptive message, saving the run's plan
    updates with `roborepo plans save`. Do not leave completed code
    uncommitted. If the run made no implementation changes because the work was already complete,
    report that no implementation commit was needed. Never create this commit on the primary
    checkout or base branch. Then push it, opening the draft pull request.
14. Run the Validation Loop (below), pushing each pass's fixes as they are committed.
15. Decide implementation completion (below).
16. Report the final state.

### Behavioral evidence handoff

Before handing off completed implementation or review fixes, assess what the user needs to see to
understand the delivered behavior. When the `feature-verification` pairing applies, load it before
selecting evidence and follow its workflow. Reuse relevant native probes, command output, browser
captures, or measured results already produced; do not rerun passing work merely for presentation.
Show one primary evidence item in the final response, with a short walkthrough in the user's terms.
Distinguish passed assertions, observed behavior, illustrative diagrams, and unavailable checks.

Routine test-result reporting alone does not trigger the pairing. If it does not apply, state why
in the handoff. If the skill is unavailable, report that limitation and still present the available
evidence without widening execution permissions. A verification gap belongs in `## Not tested`;
an explanatory diagram cannot close it.

## Validation Loop

Read `references/validation-loop.md` before the first pass. It holds the loop's steps, how to run
the Validator, and the record it leaves in `## Review`; the rubric the Validator applies is the
`implementation-review` skill's. What decides whether the loop is done:

- The Validator runs with fresh context, as a subagent where the environment has one, and is given
  the plan, the diff, and the gate output, never the implementer's account of the work.
- The Validator only reports. This session fixes every `blocking` or `actionable` finding classed
  `fix`, code included, without asking the user, and each later pass validates the revised work.
- Findings carry `implementation-review`'s severity and class. Here an `escalate` finding becomes
  an Open Questions entry, and a `base` failure, which is recorded and never blocks, is not a
  finding.
- **Never run the submit transition until the loop has ended:** a pass reports no `blocking` or
  `actionable` `fix` findings, or the eight-pass cap is reached. The cap limits passes only: the
  last pass's findings are fixed like any other's, and the run continues, recording that those fixes
  were not revalidated.
- Push each pass's fixes once committed. A pass never waits for CI.

## Implementation Completion

Implementation completion is not approval. Moving a plan to `review/` says the work is finished and
has passed the Validation Loop, ready for the human review in `/plan-review`; it does not say a
human accepted it.

1. Judge whether the stated requirements were implemented. A deterministic gate cannot prove that,
   so this judgment is the agent's, recorded with the checks that ran.
2. Run the repository's canonical completion preflight command for `<plan>`. It checks that no
   task outside `## Not tested` is unchecked, `blocked_by` is empty, the worktree has no
   uncommitted changes, the feature branch has a commit of its own, and the plan passes the review
   validator. That validator tolerates an open Not tested entry only when it gives the reason an
   agent cannot clear it, and refuses a cleared entry with no evidence, naming each entry to fix.
3. **Incomplete, blocked, or not yet validated:** the plan stays in `active/`. This includes a
   Validation Loop that left `escalate` findings open; their unchecked findings fail the preflight.
   Record the remaining tasks, findings, or blockers, set an actionable `next_action` written for a
   cold reader, and save the plan. Push the feature branch (see Push and hand off the feature
   branch). An unfinished plan never waits on CI. A later `/plan-execute` resumes from there.
4. **Complete:** hand off the feature branch first (see Push and hand off the feature branch). A CI
   check still failing after its fix attempts keeps the plan in `active/` as a blocker.
5. **Then submit:** run `roborepo plans submit <plan> --json`. It reruns the preflight and moves the
   plan to `review/` on the plans branch, starting no CI run. Mark the pull request ready by the
   handoff's rule, and report that the plan awaits `/plan-review`.

A check only a person can make, or one a tool blocked, stays open under `## Not tested` with its
reason. It does not block completion; the user settles it in `/plan-review`, before approval.

### Push and hand off the feature branch

Push and hand off as [references/handoff.md](references/handoff.md) describes, from the worktree and
without asking: push only the feature branch, never with force; the first push opens a draft pull
request; the handoff merges the base in, pushes, updates the body, and watches CI to a result.
Invoking `/plan-execute` authorizes this merge of the base into the plan's own feature branch.
Merging the feature branch into the base stays forbidden. The pull request leaves draft only by the
reference's Mark ready rule.

## Review Findings

A plan in `review/` returns here only to fix what review recorded.

1. Read `## Review` in the plan. The unchecked items under `### Findings` are the work;
   nothing else is in scope. `/plan-review` fixes every finding whose fix is clear in its own
   session, so what reaches here is what the user chose to send to a separate session, usually after
   deciding an escalated question. A finding marked `fixed in review` is already resolved; leave it
   as it is.
2. Fix each finding within the plan's existing requirements, with the same verification discipline
   as the Implementation Workflow, including the behavioral evidence handoff, then run the Validation Loop over the result.
3. Check each fixed finding off and add its resolution after a dash, for example
   `- [x] Missing retry test — added and verified`. Never edit `### Approval`: a code change already
   makes a recorded approval stale, and only `/plan-review` records a new one.
4. A finding that needs the requirements or acceptance criteria to change is not fixable here.
   Leave it unchecked, record why in Open Questions, and tell the user it needs `/plan-review`,
   which decides on the scope change.
5. Commit the fixes in the worktree and save the plan update. The plan stays in `review/`; never run a
   lifecycle transition in this mode. Hand off the feature branch (see Push and hand off the
   feature branch), including its CI watch, then report CI's result and that `/plan-review` should
   run again.
6. With no unchecked finding, finish an incomplete handoff instead: one whose branch is ahead of its
   remote or has no open pull request. Run the handoff, and never report it done without the PR.

## Not Tested

Built work that no test covers goes in the plan's `## Not tested` section the moment the
gap is known: a check that was skipped, an assumption never exercised, a claim resting on indirect
evidence. Each entry is a checkbox stating what to check.

Run every check an agent can run before submitting; the user is asked only for what an agent
cannot do. Attempt each entry, using `feature-verification` for UI, server, API, CLI, or
performance behavior, and write the missing test when a test can cover it. Then leave the entry in
one of the states `/plan-write`'s `references/plan-schema.md` defines:

| Outcome | Entry |
| --- | --- |
| The check passed | Checked, ending `— Verified by agent <date> at <commit>: <command or method> → <result>` |
| The check ran and failed | Not an entry: a defect. Fix it, as with any failing test |
| A tool blocked the check | Open, ending `Blocked: <exact command> failed with <error>`, and what would unblock it |
| Only a person can make it | Open, ending `Needs a person: <why an agent cannot>` |

The schema lists the accepted `Needs a person:` reasons and shows an example entry in each state.

A blocked check is retried through the harness's normal route before it is written down:

1. Check against the environment step 11 left running, through the harness's preview tools or a
   bare `roborepo browser run --url` call, rather than starting a second server on the same port.
2. With nothing running, run `roborepo browser run --serve` as a bare call, with no pipe, `cd`, or
   chained command. Where the harness sandboxes shell commands but excludes `roborepo`, only a bare
   call is excluded.
3. Otherwise rerun the command outside the sandbox, which goes through the permission prompt.

Only then write the `Blocked:` reason. The final report lists the command under Commands to allow;
it is not an Open Question and marks no task blocked under the Blocker Policy.

Never check off a person-only entry on your own judgment, never clear an entry without a
resolution naming the passing evidence, and record a user's confirmation only from their explicit
answer. `roborepo plans submit` refuses while an open entry gives no reason or a cleared one has
no evidence, and `/plan-close` refuses to close a plan while any entry is open. List every open
entry in the final report, and say so explicitly when there are none.

## Decision Policy

Minor implementation details need no analysis; make them and move on. For any decision that is not
trivial:

1. Identify realistic options and write down each one's pros and cons.
2. Evaluate:
   - correctness;
   - explicit plan requirements;
   - repository architecture and conventions;
   - installed code-style guidance;
   - clarity;
   - maintainability;
   - DRYness;
   - testability;
   - reversibility;
   - operational risk.
3. Prefer:
   - explicit plan requirements;
   - then repository conventions;
   - then installed skill guidance;
   - then general industry convention.
4. Decide autonomously when one option is clearly the best and no alternative has a compelling
   argument for it. A clear win needs no approval, however large the change, unless step 6 applies.
5. Otherwise, block the decision: two or more options each have a compelling argument, so a
   reasonable person could choose either. Reversibility alone does not settle it: a cheap-to-reverse
   choice with no clear winner is still blocked.
6. Always block, never decide, when the decision:
   - is destructive or difficult to reverse;
   - materially changes product scope or behavior;
   - changes a public API or persistent schema;
   - affects security, privacy, permissions, migration, or compatibility;
   - pushes, merges, publishes, spends money, or affects an external system. The feature-branch
     pushes, the draft pull request, the handoff's base merge into the feature branch and pull
     request update, CI fixes, and marking the pull request ready when its conditions hold (Push
     and hand off the feature branch) are fixed steps of this skill, not decisions.
7. A blocked decision becomes an Open Questions entry; see Blocker Policy.

### Decision Log

Log every non-trivial decision made autonomously in a `## Decision Log` section of the
plan, so the user can review it later. Each entry states:

- the decision;
- the alternatives considered;
- why the chosen option won.

Answers the user gives to queued questions go in the same log, marked as user decisions.

## Blocker Policy

A blocker should stop only the work it actually blocks. Blockers are either decisions the Decision
Policy refused to make or external obstacles such as a failing dependency or a missing credential.

When blocked:

1. Add an entry to the plan's `## Open Questions` section:
   - the question or obstacle, with evidence;
   - for a decision: the options, their pros and cons, and a recommendation when there is one;
   - why it was blocked rather than decided;
   - the tasks it blocks.
2. Mark the task that needs the answer blocked, along with every task that depends on it.
3. Continue all independent implementation and verification.
4. Re-evaluate open entries after related changes; resolve any that later work makes clear, and
   move them to the Decision Log.
5. When no unblocked tasks remain, present every open entry to the user in one batch, as part of the
   final report.

Do not declare the entire feature complete while a required objective remains blocked.

## Subagents

Apply this section only when the repository's execution environment provides the relevant agent
interface; otherwise record the limitation and continue with the available interfaces.

Delegate procedural slices of the plan to subagents when that clearly helps, for example
mechanical edits across many files, bulk renames, or long test runs. The Validator is not a
procedural slice: it runs on the session's own model, as `references/validation-loop.md` describes.
Rules for procedural subagents:

- Launch them on a cheaper model where the harness offers a choice.
- Run them in the target worktree. Never pass `isolation: "worktree"` or let one create a branch or
  worktree.
- Give each subagent a slice with no unmade decisions. A subagent that hits a decision reports it
  back instead of choosing.
- The main agent keeps ownership of decisions, the Decision Log, the Open Questions queue, plan
  synchronization, commits, and verification of subagent output.
- Do not run parallel subagents that edit the same files.

## Completion Conditions

A run is complete when:

- every in-scope, unblocked objective has been implemented;
- acceptance criteria have been evaluated;
- the Validation Loop ended on a pass with no `blocking` or `actionable` `fix` findings, or at its
  cap with the last pass's findings fixed, and says so;
- targeted verification has passed or failures are explained;
- required broader verification has been run when practical;
- autonomous decisions are in the Decision Log;
- every known untested gap is a `## Not tested` entry, cleared with evidence or open with its reason;
- every blocked decision and external blocker is in Open Questions, with the tasks it blocks;
- no unblocked task remains;
- blockers and deferred scope are explicit;
- the plan reflects implementation reality, with a `next_action` for whoever resumes it;
- affected docs of record describe the implemented behavior, or the plan explains why none needs
  an update;
- a repository-appropriate test/development environment or build was started, and its shareable
  link is recorded when one exists;
- completed implementation changes are committed in the target worktree, or the final report
  explicitly says that no implementation commit was needed;
- the feature branch was pushed after the run's last commit, or the final report gives the exact
  push command and why it did not run;
- before a submit, and after review-findings fixes, the handoff merged the base, opened or updated
  the pull request, and watched CI to a result at the head commit, which the final report gives with
  the pull request's draft or ready state; or the final report says which handoff step did not run
  and why;
- the plan was moved to `review/` if and only if the Validation Loop ended, the completion
  preflight passed, and the handoff's CI watch did not end Blocked.

Completion does not authorize:

- unrelated refactoring;
- infinite retries around external blockers;
- guessing through consequential product decisions;
- pushing anything but the plan's feature branch, merging anything but the base into the plan's
  feature branch, pull request writes beyond the handoff reference's, merging a pull request, publishing, or deleting worktrees, without explicit
  permission or repository policy;
- any commit on the base branch;
- leaving completed implementation changes uncommitted in the target worktree.

## Final Report

Name the plan by its H1 title, with its id in parentheses on first mention only. The id is the
stable reference for commands and frontmatter, not a name a person recognizes; the same goes for
questions, review packets, and other prose in this run.

Before the final report in every execution mode (start, resume, and review findings), read
[references/final-report.md](references/final-report.md) and follow its required template and
reporting checklist. It builds on `/plan-write`'s `references/completion-report.md`, the shape
every plan command shares, including the checker agent that reads the report before the user does.
Include all applicable reporting obligations, behavioral evidence or its stated limitation,
verification results, blockers, and the next user command.

## Boundaries

Do not:

- create a second implementation plan;
- repeat a full planning interview unless the plan is materially stale or incomplete;
- change lifecycle state, except the start transition from `ready/` and the submit transition to
  `review/`;
- perform `/plan-review`'s human review, or record approval;
- own user-interface behavior;
- create integration branches;
- perform closeout, or merge the feature branch or its pull request into the base; opening this
  plan's pull request as a draft and marking it ready through `roborepo delivery pr-ready` are
  allowed;
- invoke another plan command;
- launch unrelated workflows;
- hide failed verification or partial completion.
