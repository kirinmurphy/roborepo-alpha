---
name: plan-execute
description: Use when starting, resuming, or fixing the implementation of a prepared repository plan. Accepts a plan in ready, active, or review. From ready it will create or safely reuse an isolated worktree and commit the start transition; in active it resumes in the recorded worktree; in review it fixes only the findings review sent back. It implements every in-scope unblocked objective without milestone check-ins, logs autonomous decisions, queues blocked questions for the end, then runs a validation loop in which a fresh-context validator checks the work and the agent fixes what it finds until a pass is clean, and moves the plan to review only after a clean pass and a passing completion preflight. Safe to rerun across sessions. Do not use for preparing a backlog plan (plan-promote), the human review or approval (plan-review), post-merge closure (plan-close), archiving (plan-archive), or implementation without an existing plan.
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
- `docs/plans/plans-config.json` when present.

The existing plan is the implementation contract. Verify it against the current repository before relying on it.

## Where the plan is

Read the plan's folder in the primary checkout first; it decides what this run does. A command never
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

| Skill | Load when | Contributes |
| --- | --- | --- |
| `code-style` | The work places code: module boundaries, orchestration vs. execution, reuse | Ownership and layering constraints |
| `javascript-typescript` | The work touches JS/TS — ESM, exports, types, framework-less DOM | Language and markup conventions |
| `test-harness` | The work adds or changes tests, verification commands, or fixtures | Test selection and observable-behavior assertions |

Each row is its own optional package, so check it before loading it. Run this check in Preflight,
for every row the plan's subject matter calls for, before the start transition: it is a pre-run gate
like the `worktreeRoot` confirmation, so the no-questions run mode is unaffected.

1. Check the host's skill/package manager for `<skill>` and read its availability and activation state.
2. If `available` is true, `enabled` is true, and `status` is `enabled` or `configured`, load it.
3. If it is disabled, ask: "`<skill>` is not enabled. Enable it, or skip it for this run?"
   - **Enable:** use the host's package manager to enable `<skill>` with the user's permission, then load it.
   - **Skip:** continue without it, and name it as skipped in the final report.
4. If `enabled` and `status` disagree (`partial`, `external`), report the status, offer
   the host's package reconciliation command or skip, and never describe a drifted package as loaded.
5. If it is `missing` or `unavailable`, skip it and say so in the final report.

State which paired skills applied and which did not — a skipped skill and a forgotten one look
identical otherwise.

## Run Mode

Work until the plan runs out of unblocked tasks. A run ends only when every in-scope task is either
done or blocked by an open question or external blocker.

- Do not stop for milestone, phase, or slice check-ins. Finishing a phase is a reason to start the
  next one, not to report.
- Do not ask the user anything during implementation. Questions go into the Open Questions queue
  (see Blocker Policy) and are asked together, once, at the end.
- The exceptions are the gates that come before implementation can start at all: the first-run
  `worktreeRoot` confirmation in Preflight and a refused start transition. With no worktree, no task
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
4. Run the paired-skill check in Paired Skills for every row the plan's subject matter calls for.
5. Read `docs/plans/plans-config.json` when present. If it declares a `worktreeRoot` (an absolute
   path, a `~`-relative path, or a path relative to the repository root), that is the configured
   worktree policy; resolve new worktrees under `<worktreeRoot>/<repo-name>/<branch>` without asking.
   If the key is absent, this is a first-time-per-repository decision, not routine implementation
   detail: propose the default `~/.worktrees` (expand `~` via the platform home directory, e.g.
   `os.homedir()` in Node, not a literal string), state the exact resolved path, and wait for the
   user to confirm or override before running `git worktree add`. On confirmation, write the
   resulting path (confirmed default or override) into `plans-config.json` as `worktreeRoot` so every
   later run on this repository resolves silently from then on — this is a one-time gate per
   repository, not a prompt on every `plan-execute` invocation.
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
14. Resolve the primary checkout with `git worktree list --porcelain`. The first `worktree` entry
    is the main checkout for the shared `.git` directory. Every lifecycle transition runs there, and
    from `APPROVED` on, the worktree's copy is the plan: it is the authoritative copy, the one the
    portal shows. Every plan update after that, including Decision Log, Open Questions, and `## Not tested`
    entries, goes to the worktree's copy and nowhere else. Never copy plan updates to the primary
    checkout; Git carries the worktree's plan to the base branch when the branch merges, and an edit
    to the primary copy in the meantime is reported as an outside edit.

When deterministic repository commands exist for an operation, use them instead of reconstructing the mutation manually.

## Start Transition

Only a plan in `ready/` takes this step. Read `references/start-validation.md` before running the
transition. It describes what the start transition command does, the validator checks it runs, and
how to act on a refusal.

Run the transition from the primary checkout, after the target worktree is resolved and before any
implementation:

1. The primary checkout must be on the base branch, and the plan's own path must have no
   uncommitted changes; the command refuses otherwise, and that refusal is a reason to stop and ask
   the user. Unrelated work elsewhere in the primary checkout does not block it and is never
   committed. On a repository's first run, commit the `worktreeRoot` that Preflight just wrote to
   `docs/plans/plans-config.json` alone first, as a configuration-only commit, then continue.
2. Resolve the target's Git administrative worktree name — not the checkout directory's basename,
   and never a branch name or absolute path.
3. Run the repository's canonical start transition command for `<plan>` with worktree `<name>`. It
   writes `worktree: <name>` into the primary checkout's copy of the plan, moves it from `ready/` to
   `active/` with `git mv` (keeping its filename and `id`), stages only the old and new plan paths,
   and commits the plan-only start transition on the base branch. Do not push.
4. The same command then runs the start validator against fresh disk and Git state.
5. Enter the implementation worktree only after the validator returns `APPROVED`. Apply each failed
   check's `fix` and rerun; the validator gets at most three correction passes, and a final refusal
   blocks this plan and is reported, never worked around.
6. Repository links the result lists under `staleLinks` still name the old `ready/` path. Fix them
   in the implementation worktree, never on the base branch.

## Enter the Worktree

Before the first edit, make the worktree the session's working directory. Writes are allowed without
a prompt only inside the checkout the session is working in, so a session still rooted in the
primary checkout asks for permission on every file it edits in the worktree.

- If the execution environment requires explicit access to a linked worktree, request that access
  once using the environment's standard mechanism, then make the worktree the session's working
  directory. Follow repository-local access instructions when they exist.

This is part of the pre-implementation gate, like the `worktreeRoot` confirmation: one approval,
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
   - a `next_action` that names the next concrete step.
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
    command, or launch rule. Keep it available for manual verification and capture the resulting
    shareable URL or link when the environment exposes one. If the repository cannot expose a
    link, record what was started and why no link is available.
12. Run completion-level verification, including manual verification against the started
    environment when applicable.
13. Re-read Git status and the implementation diff in the target worktree, then commit the
    completed implementation changes there with a descriptive message, including the run's plan
    updates in the worktree's copy. Do not leave completed code
    uncommitted. If the run made no implementation changes because the work was already complete,
    report that no implementation commit was needed. Never create this commit on the primary
    checkout or base branch.
14. Run the Validation Loop (below).
15. Decide implementation completion (below).
16. Report the final state.

## Validation Loop

Read `references/validation-loop.md` before the first pass. It holds the loop's steps, how to run
the Validator, the rubric it applies, and the record it leaves in `## Review`. What decides whether
the loop is done:

- The Validator runs with fresh context, as a subagent where the environment has one, and is given
  the plan, the diff, and the gate output, never the implementer's account of the work.
- The Validator only reports. This session fixes every finding classed `fix`, code included, and
  each later pass validates the revised work.
- A finding is classed by consequence, not size: `fix` when the right fix is clear and stays within
  the plan's requirements; `escalate`, as an Open Questions entry, when it chooses between real
  alternatives, changes requirements or a contract, or lands outside the plan; `base` when the base
  branch fails the same check, which is recorded and never blocks.
- **Never run the submit transition until a pass reports no `fix` findings.** At the five-pass cap,
  stop, leave the remaining findings open, and report them.

## Implementation Completion

Implementation completion is not approval. Moving a plan to `review/` says the work is finished and
has passed the Validation Loop, ready for the human review in `/plan-review`; it does not say a
human accepted it.

1. Judge whether the stated requirements were implemented. A deterministic gate cannot prove that,
   so this judgment is the agent's, recorded with the checks that ran.
2. Run the repository's canonical completion preflight command for `<plan>`. It checks that no
   task outside `## Not tested` is unchecked, `blocked_by` is empty, the worktree has no
   uncommitted changes, the feature branch has a commit of its own, and the plan passes the review
   validator apart from unconfirmed Not tested entries.
3. **Incomplete, blocked, or not yet validated:** the plan stays in `active/`. This includes a
   Validation Loop that stopped at its cap or left `escalate` findings open; their unchecked
   findings fail the preflight. Record the remaining tasks, findings, or blockers, set an actionable
   `next_action`, and commit the plan in the worktree. A later `/plan-execute` resumes from there.
4. **Complete:** from the primary checkout, run the repository's canonical submit transition
   command for `<plan>`. It reruns the preflight and commits the plan-only move from `active/` to
   `review/` on the base branch. Do not push. Report that the plan awaits `/plan-review`.

Genuinely unverified manual checks stay under `## Not tested`; they do not block completion, and
they are resolved before `/plan-close`.

## Review Findings

A plan in `review/` returns here only to fix what review recorded.

1. Read `## Review` in the worktree's copy. The unchecked items under `### Findings` are the work;
   nothing else is in scope. `/plan-review` fixes every finding whose fix is clear in its own
   session, so what reaches here is what the user chose to send to a separate session, usually after
   deciding an escalated question. A finding marked `fixed in review` is already resolved; leave it
   as it is.
2. Fix each finding within the plan's existing requirements, with the same verification discipline
   as the Implementation Workflow, then run the Validation Loop over the result.
3. Check each fixed finding off and add its resolution after a dash, for example
   `- [x] Missing retry test — added and verified`. Never edit `### Approval`: a code change already
   makes a recorded approval stale, and only `/plan-review` records a new one.
4. A finding that needs the requirements or acceptance criteria to change is not fixable here.
   Leave it unchecked, record why in Open Questions, and tell the user it needs `/plan-review`,
   which decides on the scope change.
5. Commit the fixes and the plan update in the worktree. The plan stays in `review/`; never run a
   lifecycle transition in this mode. Report that `/plan-review` should run again.

## Not Tested

Built work that no test covers goes in the worktree copy's `## Not tested` section the moment the
gap is known: a check that was skipped, an assumption never exercised, a claim resting on indirect
evidence. Each entry is an unchecked checkbox stating what to check and why a test cannot:

```markdown
## Not tested

- [ ] The user-facing setup action enables all required components. Needs a browser session against
      the supported live environment.
```

Never check an entry off yourself; the user confirms it by hand. The plan validator reports
unchecked entries, and `/plan-close` refuses to close a plan while any remain. List every entry in
the final report, and say so explicitly when there are none.

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
4. Decide autonomously only when **all** of these hold:
   - one option is clearly the best;
   - choosing it has only trivial consequences;
   - its effects stay inside this feature.

   Reversibility alone is not enough: a cheap-to-reverse choice with no clear winner is still
   blocked.
5. Otherwise, block the decision. Any of these is enough:
   - no option is clearly best;
   - the tradeoffs between options are considerable;
   - the tradeoffs reach beyond this feature;
   - the best option still carries consequences that are not trivial.
6. Always block, never decide, when the decision:
   - is destructive or difficult to reverse;
   - materially changes product scope or behavior;
   - changes a public API or persistent schema;
   - affects security, privacy, permissions, migration, or compatibility;
   - pushes, merges, publishes, spends money, or affects an external system.
7. A blocked decision becomes an Open Questions entry; see Blocker Policy.

### Decision Log

Log every non-trivial decision made autonomously in a `## Decision Log` section of the worktree's
copy of the plan, so the user can review it later. Each entry states:

- the decision;
- the alternatives considered;
- why the chosen option won.

Answers the user gives to queued questions go in the same log, marked as user decisions.

## Blocker Policy

A blocker should stop only the work it actually blocks. Blockers are either decisions the Decision
Policy refused to make or external obstacles such as a failing dependency or a missing credential.

When blocked:

1. Add an entry to the `## Open Questions` section of the worktree's copy of the plan:
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

- Launch them with `model: sonnet`.
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
- the Validation Loop ended on a pass with no `fix` findings, or stopped at its cap and says so;
- targeted verification has passed or failures are explained;
- required broader verification has been run when practical;
- autonomous decisions are in the Decision Log;
- every known untested gap is a `## Not tested` entry;
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
- the plan was moved to `review/` if and only if the Validation Loop ended clean and the completion
  preflight passed.

Completion does not authorize:

- unrelated refactoring;
- infinite retries around external blockers;
- guessing through consequential product decisions;
- pushing, merging, publishing, or deleting worktrees without explicit permission or repository policy;
- any commit on the base branch other than the start and submit transitions;
- leaving completed implementation changes uncommitted in the target worktree.

## Final Report

Name the plan by its H1 title, with its id in parentheses on first mention only. The id is the
stable reference for commands and frontmatter, not a name a person recognizes; the same goes for
questions, review packets, and other prose in this run.

Report:

```text
Implementation result
- Plan: "<title>" (<id>), <repository-relative path>
- Mode: start | resume | review findings
- Worktree: <runtime path>
- Worktree name: <Git administrative name recorded in the plan>
- Start transition: <commit on the base branch, "already recorded", or "not applicable">
- Start validator: APPROVED after <n> correction passes, refused with <checks>, or not applicable
- Branch: <branch>
- Base branch: <branch>
- Starting commit: <commit>
- Objectives completed: <count>
- Objectives blocked: <count>
- Findings fixed: <count, or "not applicable">
- Validation: clean on pass <n> | stopped at the cap with <count> open | in-session (no subagent interface)
- Base failures: <checks that fail on the base branch too, or "none">
- Material decisions: <count>
- Open questions: <count>
- Not tested entries: <count>
- Implementation commit: <commit and message, or "no implementation commit needed">
- Completion preflight: passed | failed with <checks> | not run
- Lifecycle: stays active | moved to review (<commit>) | stays review
- Docs updated: <list> | none needed (<reason>)
- Test/development environment: <what was started>
- Shareable link: <URL/link, or why none is available>
- Verification passed: yes/no/partial
- Implementation complete: yes/no
```

Also include:

- files changed;
- the Decision Log: each autonomous decision, alternatives, and reasoning;
- each Validation Loop pass's report, the clean one included;
- tests and checks run;
- manual verification;
- the `## Not tested` entries, each with what to check and why no test covers it;
- paired skills loaded, and any skipped with the reason;
- Open Questions, asked together as the run's only question batch: each with its options, pros and
  cons, recommendation, and the tasks it blocks;
- deferred scope;
- the plan validator's output for the worktree's copy of the plan;
- current Git status;
- whether anything was committed, pushed, merged, or published;
- the next command the user runs: `/plan-execute` again to resume, or `/plan-review`.

## Boundaries

Do not:

- create a second implementation plan;
- repeat a full planning interview unless the plan is materially stale or incomplete;
- change lifecycle state, except the start transition from `ready/` and the submit transition to
  `review/`;
- perform `/plan-review`'s human review, or record approval;
- own user-interface behavior;
- create integration branches;
- perform closeout or merge orchestration;
- invoke another plan command;
- launch unrelated workflows;
- hide failed verification or partial completion.
