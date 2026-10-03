---
name: plan-start
description: Use when beginning implementation from an existing prepared repository plan. Inspect the current plan and repository, create or safely reuse an isolated worktree, record it in the canonical plan through a validated plan-only start commit, implement every in-scope unblocked objective without milestone check-ins, decide only clear low-consequence questions autonomously and log them, queue the rest as blockers while continuing all unblocked work, verify the work, synchronize the plan, and report the result with every open question batched at the end. Do not use for initial plan preparation, lifecycle orchestration, portal actions, integration-branch closeout, or implementation without an existing plan.
---

# Plan Start

Begin development from one existing prepared implementation plan.

The goal is to execute the plan through all in-scope, unblocked objectives while minimizing unnecessary interruptions and preserving a clear record of decisions, verification, blockers, and execution context.

## Inputs

Resolve:

- the repository root;
- the selected plan document;
- repository instructions;
- relevant installed code-style and language skills;
- current Git state;
- existing branches and worktrees;
- `docs/plans/plans-config.json` when present.

The existing plan is the implementation contract. Verify it against the current repository before relying on it.

## Run Mode

Work until the plan runs out of unblocked tasks. A run ends only when every in-scope task is either
done or blocked by an open question or external blocker.

- Do not stop for milestone, phase, or slice check-ins. Finishing a phase is a reason to start the
  next one, not to report.
- Do not ask the user anything during implementation. Questions go into the Open Questions queue
  (see Blocker Policy) and are asked together, once, at the end.
- The exceptions are the gates that come before implementation can start at all: the first-run
  `worktreeRoot` confirmation in Preflight and the dirty-checkout check in Start Transition. With no
  worktree, no task is unblocked, so these stop and ask immediately.
- When the user answers the batched questions, each answer unblocks its tasks and the run resumes in
  this same mode: record the answer in the Decision Log, continue until no unblocked tasks remain,
  and batch any new questions again.

## Preflight

1. Read the entire selected plan.
2. Inspect the current repository state and material plan claims.
3. Detect whether the plan has become stale or materially incomplete.
4. Read `docs/plans/plans-config.json` when present. If it declares a `worktreeRoot` (an absolute
   path, a `~`-relative path, or a path relative to the repository root), that is the configured
   worktree policy; resolve new worktrees under `<worktreeRoot>/<repo-name>/<branch>` without asking.
   If the key is absent, this is a first-time-per-repository decision, not routine implementation
   detail: propose the default `~/.worktrees` (expand `~` via the platform home directory, e.g.
   `os.homedir()` in Node, not a literal string), state the exact resolved path, and wait for the
   user to confirm or override before running `git worktree add`. On confirmation, write the
   resulting path (confirmed default or override) into `plans-config.json` as `worktreeRoot` so every
   later run on this repository resolves silently from then on — this is a one-time gate per
   repository, not a prompt on every `plan-start` invocation.
5. Resolve the worktree policy.
6. Inspect existing worktrees before creating another one.
7. Reuse a worktree only when it clearly matches the repository and intended branch and is safe to continue.
8. Refuse to reuse a dirty, ambiguous, unrelated, or conflicting worktree.
9. Create an isolated feature worktree when a safe matching workspace does not exist.
10. Use platform path APIs for `~` expansion and path joining so the same default resolves correctly
    on macOS, Linux, and Windows.
11. Keep absolute worktree paths out of repository plan documents.
12. Record:
    - worktree path;
    - Git administrative worktree name;
    - branch;
    - base branch;
    - starting commit.
13. Resolve the primary checkout with `git worktree list --porcelain`. The first `worktree` entry
    is the main checkout for the shared `.git` directory. When implementation runs from a linked
    worktree, keep plan-status updates synchronized in the matching plan document under the primary
    checkout, not only in the linked worktree copy. Use the same repository-relative
    `docs/plans/...` path. If the primary checkout path cannot be resolved or the matching document
    is absent there, record that limitation in the plan and final report instead of inventing a
    second source of truth.

When deterministic RoboRepo commands exist for an operation, use them instead of reconstructing the mutation manually.

## Start Transition

Read `references/start-validation.md` before any step below. It holds the exact commands, the
validator checks, and the failure behavior.

Run the transition from the primary checkout, after the target worktree is resolved and before any
implementation:

1. Require the primary checkout to be on the base branch with no uncommitted changes. Otherwise stop
   and ask the user. The one exception is the `worktreeRoot` that Preflight just wrote to
   `docs/plans/plans-config.json` on a repository's first run: commit that file alone first, as a
   configuration-only commit, then re-check that the checkout is clean.
2. Resolve the target's Git administrative worktree name — not the checkout directory's basename,
   and never a branch name or absolute path.
3. Write `worktree: <name>` into the canonical plan's frontmatter. If the plan is still in
   `backlog/`, move it from `backlog/` to `active/` with `git mv`, keeping its filename and `id`,
   and update repository links that point at the old path. A plan already in `active/` is edited in
   place, never moved again.
4. Re-read Git status, stage only the old and new canonical plan paths by name, and commit the
   plan-only start transition on the base branch. Do not push.
5. Run the start validator against fresh disk and Git state.
6. Enter the implementation worktree only after the validator returns `APPROVED`. The validator
   gets at most three correction passes; a final refusal blocks this plan and is reported, never
   worked around.

This is the one lifecycle change `plan-start` makes.

## Implementation Workflow

1. Reconcile any minor stale details that are obvious and safe to fix.
2. Identify the plan's in-scope objectives, acceptance criteria, dependencies, and blockers.
3. Build a working task sequence from the existing plan.
4. Implement one coherent slice at a time.
5. Run the smallest useful verification after each slice.
6. Continue until every in-scope, unblocked objective has been addressed, without pausing between
   phases or milestones.
7. Keep the plan synchronized with:
   - the Decision Log and Open Questions sections;
   - scope corrections;
   - blockers;
   - completed work;
   - verification results.
8. When the implementation worktree is linked, mirror those plan-document updates to the primary
   checkout's copy so `/plans` reflects the active status after linked worktrees are ignored by
   discovery.
9. Do not silently omit objectives.
10. Do not expand into unrelated cleanup.
11. Perform a final comparison between:
    - the plan;
    - the implementation diff;
    - runtime behavior;
    - acceptance criteria.
12. Run completion-level verification.
13. Report the final state.

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

Log every non-trivial decision made autonomously in a `## Decision Log` section of the canonical
plan, so the user can review it later. Each entry states:

- the decision;
- the alternatives considered;
- why the chosen option won.

Answers the user gives to queued questions go in the same log, marked as user decisions.

## Blocker Policy

A blocker should stop only the work it actually blocks. Blockers are either decisions the Decision
Policy refused to make or external obstacles such as a failing dependency or a missing credential.

When blocked:

1. Add an entry to the `## Open Questions` section of the canonical plan:
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

Claude only; other harnesses skip this section.

Delegate procedural slices of the plan to subagents when that clearly helps, for example
mechanical edits across many files, bulk renames, or long test runs. Rules:

- Launch them with `model: sonnet`.
- Run them in the target worktree. Never pass `isolation: "worktree"` or let one create a branch or
  worktree.
- Give each subagent a slice with no unmade decisions. A subagent that hits a decision reports it
  back instead of choosing.
- The main agent keeps ownership of decisions, the Decision Log, the Open Questions queue, plan
  synchronization, commits, and verification of subagent output.
- Do not run parallel subagents that edit the same files.

## Completion Conditions

Implementation is complete when:

- every in-scope, unblocked objective has been implemented;
- acceptance criteria have been evaluated;
- targeted verification has passed or failures are explained;
- required broader verification has been run when practical;
- autonomous decisions are in the Decision Log;
- every blocked decision and external blocker is in Open Questions, with the tasks it blocks;
- no unblocked task remains;
- blockers and deferred scope are explicit;
- the plan reflects implementation reality.

Completion does not authorize:

- unrelated refactoring;
- infinite retries around external blockers;
- guessing through consequential product decisions;
- pushing, merging, publishing, or deleting worktrees without explicit permission or repository policy;
- any commit on the base branch other than the plan-only start transition.

## Final Report

Report:

```text
Implementation result
- Plan: <id and repository-relative path>
- Worktree: <runtime path>
- Worktree name: <Git administrative name recorded in the plan>
- Start transition: <commit on the base branch, or "already recorded">
- Start validator: APPROVED after <n> correction passes, or refused with <checks>
- Branch: <branch>
- Base branch: <branch>
- Starting commit: <commit>
- Objectives completed: <count>
- Objectives blocked: <count>
- Material decisions: <count>
- Open questions: <count>
- Verification passed: yes/no/partial
- Implementation complete: yes/no
```

Also include:

- files changed;
- the Decision Log: each autonomous decision, alternatives, and reasoning;
- tests and checks run;
- manual verification;
- Open Questions, asked together as the run's only question batch: each with its options, pros and
  cons, recommendation, and the tasks it blocks;
- deferred scope;
- current Git status;
- whether anything was committed, pushed, merged, or published.

## Boundaries

Do not:

- create a second implementation plan;
- repeat a full planning interview unless the plan is materially stale or incomplete;
- change lifecycle state, except the backlog-to-active start transition in
  `references/start-validation.md`;
- own portal behavior;
- create integration branches;
- perform closeout or merge orchestration;
- launch unrelated workflows;
- hide failed verification or partial completion.
