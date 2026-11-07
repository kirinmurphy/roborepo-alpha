# Plan Suite Deferred Topics

## Purpose

An audit of the plan suite set a long-term goal: an approved plan reaches a green, mergeable pull
request without babysitting. Clear agent friction (`vzgsx5vz`) and Deliver finished plans as a
watched pull request (`i5mnkm7z`) cover work that can use the existing lifecycle moves.

This document records what the audit recommended and those plans left out, why, and what would
unblock each topic, so a later scoping pass does not have to repeat the audit. None of it has been
built or tried on a real plan. Metrics come from small transcript samples and should be rechecked
before they justify a change. Skill paths such as `plan-execute/SKILL.md` are under
`globals/packages/plan-suite/skills/`.

## Waiting on the plan-document branch

Store plans on a dedicated Git branch (`pvgx8oh7`)
proposes moving plan documents to one branch per repo. Re-evaluate these topics after it lands,
because it may remove the problem.

| Topic | Today | Direction when revisited |
| --- | --- | --- |
| Where lifecycle commits land | Start, submit, and close commit to local `main` (`plan-execute/SKILL.md`) | Decide against the new branch model |
| Who pushes those commits | The user pushes them by hand, because agents cannot push `main` | Expected to go away |
| Pushing the approval commit | Reruns CI after approval, because the record lives on the feature branch | Expected to go away |
| Plan-record commits in pull request diffs | Records commit on the feature branch and show in the diff | Expected to go away |
| Automatic close after merge | The user starts `/plan-close` | Detect the merge and run the guarded close. Timing depends on the lifecycle model |
| Plan-record slimming | The finding-by-finding log lives in the plan | Keep open items and a one-line verdict in the record |

## Making execute prove the work

The audit's central recommendation: `/plan-execute` owns everything an agent can prove, including
that the feature works, and review becomes a cheap second check plus the user's eyes. It would lengthen
execute and spend more tokens per plan, so measure it on a real plan before tuning.

| Topic | Recommendation |
| --- | --- |
| Behavior checks | Drive each acceptance criterion with `feature-verification` evidence, and run every `## Not tested` entry an agent can run |
| QA script | Write the few things only the user can judge, with steps and expected results |
| Structured claims | Record what execute claims, so review confirms it from outside the code rather than repeating the code rubric |
| Two gates | Separate implementation validation from delivery readiness in execute's contract |
| Escaped defects | Count each defect review finds as one that escaped execute, to measure whether its checks are good enough |
| Fix location | Requirement changes reopen to active. Fixes within requirements stay in the review session, with a subagent for larger ones |

## Gates and lifecycle rules

| Topic | Issue | Recommendation |
| --- | --- | --- |
| Not tested timing | Required in prose at approval, tolerated by code through review, enforced only at close | Settle it before approval |
| Close changing code | `/plan-close` may fix gaps with code or tests, which land on `main` with no CI and no push | Stop close from changing code. Depends on where close commits land |
| Validator proof | The preflight cannot tell whether the validation loop actually ran | Make it prove the loop ran |
| Approval across base merges | A clean base merge makes approval stale | Owned by `d9ywaa8d` |
| Review on active plans | The portal menu offers Review on active plans, which lets a plan skip execute's finish | Offer finishing execution until the delivery gate passes. Needs that gate to exist as computed state |

## Validator loop

Evidence: one plan took 18 passes and logged 79 findings, and 37 of 91 branch commits matched
validation or record bookkeeping. The cap is now eight passes.

- Run a full pass first, then later passes only on what changed since.
- Fix wording and comment findings once, without restarting the loop.
- Consider a cap of about four, tested on a real plan. Behavior checks should grow as churn shrinks.

## Status and handoff

| Topic | Recommendation | Unblocked by |
| --- | --- | --- |
| `roborepo plans status` | Compute it from the folder, worktree, pull request, CI, and review record. Store only what cannot be derived, such as a run marker | The GitHub host module from `w7vls1yk` |
| Portal "Waiting on" chip, stepper line | Show the same computed state on the page and at each skill stop | `plans status` |
| Stall detection, notifications | Detect stalled runs, likely with a Stop hook. Notify only on entering a "waiting on you" state. RoboRepo has no notification code today | `plans status` |
| Scheduled job | A cheap script that spends no tokens until it starts a session. Begin with execute-to-review only, opt in per plan or repo | `plans status`, the guardrails below |
| Allowing `git worktree add` | Unneeded while the user starts each plan and can answer a prompt | A scheduled job |

The scheduled job needs these before it starts anything unattended. It also reverses Part 02's recorded
position against a watcher, and session launching is still a stub.

| Risk | Guardrail |
| --- | --- |
| Two ticks start two sessions on one plan | A lock per plan |
| Promoting five plans starts five sessions overnight | A limit on concurrent plans, and a daily budget |
| A failing plan restarts on every tick | Stop after a set number of failures, then notify |
| An unattended session waits on a permission prompt forever | A verified fail-closed mode per harness |
| Ready is a queue the user chooses from, not "start now" | Opt in per plan or repo |

## Reporting

| Topic | Recommendation |
| --- | --- |
| HTML report | Wait until the pull request body falls short, most likely for screenshots and diagrams |
| Report storage, if built | One report per plan, overwritten on update, outside the repo, deleted at close, and registered in `modules/retention/registry.mjs` as a net for abandoned plans |

## Backlog follow-ups

| Topic | Note |
| --- | --- |
| Paired-skill check | Settle required skills at `/plan-promote`, while the user is present. Build on `ejsc769o` |
| End-to-end evals | Add the full plan flow to `0jped168`, since text pins cannot prove it works |
| Worktree-entry hook | Added to `46qth5z8` only if agents keep using `change_directory` after the rule change |
| `/session-close` no-push rule | Left as is, because the user does not use the command. Revisit if it conflicts with the delivery rule in practice |
