---
id: i5mnkm7z
next_action: Run /plan-execute on this plan. Start with the "branch tip is pushed" check in merge readiness and its failing test, then the handoff reference, then the two skills and their pins.
blocked_by: []
depends_on: ["vzgsx5vz"]
related: ["f0jwe76j", "w7vls1yk", "d9ywaa8d", "developer-runtime-remote-branch-status", "pvgx8oh7", "kqgr1d65", "0jped168"]
reviewed_commit: f9d328468e246a26ce2fd0629ce2085f3e8ca319
worktree: plans-suite-quick-wins-2-git-delivery
---

# Deliver finished plans as a watched pull request

## Summary

`/plan-execute` already ends a finished plan with a pushed branch and a pull request with a written
body. What it does not do is wait for CI: it reports "CI is running" and stops, so the user still
finds out later whether the checks passed, and fixes a red run by hand. It also opens the pull
request only at the very end, and marks any draft ready without checking CI.

This plan closes those gaps. The pull request opens as a draft at the first push, CI is watched to a
result and fixed when it fails, and the pull request leaves draft only when CI is green and the
Validator ended clean. `/plan-review` pushes each fix as it lands and confirms the pull request shows
the reviewed commit before asking for approval. Merge readiness refuses a branch whose local tip was
never pushed. The user still approves and merges.

The long-term goal is that an approved plan reaches a green, mergeable pull request without
babysitting. Topics held back from this plan, and what would unblock each, are recorded in
`docs/internal/plan-suite-deferred-topics.md` on `main`.

## Goals

- A draft pull request exists from the first feature-branch push, with a body a reviewer can read.
- CI is watched to a result at the head commit, and a failure is fixed or raised rather than left for
  the user to find.
- A pull request leaves draft only when the Validator ended clean and every check passed at its head
  commit.
- Fixes made during review reach the pull request as they land, and the review packet names the
  pull request and its CI result at the reviewed commit.
- Merge readiness refuses a branch whose local tip differs from what was pushed.

## Non-goals

- Merging. `gh pr merge` stays denied, and the user merges.
- Starting a next stage automatically. Stages keep running in separate sessions that the user starts.
- Replying to or resolving review threads, and fixing pull requests outside a plan run. "GitHub
  Integration Part 02" (`f0jwe76j`) owns those.
- Changing `manifests/inventory/agent-permissions.json`. Every command this plan needs is already
  allowed (see Current state).
- Fixing the Validator loop's churn or changing the plan record's shape.
- Changing `manifests/platform/plan-lifecycle.json`. The "Fix findings" action stays as the path for
  sending a finding to a separate session.

## Current state

Checked against `main` at `f9d32846`. Skill paths such as `plan-execute/SKILL.md` are under
`globals/packages/plan-suite/skills/`.

### What already works

These landed after this plan was first written, and this plan builds on them rather than replacing
them.

| Capability | Where |
| --- | --- |
| Plans live on the `repo-plans` branch; start, submit, and approval commits go there and are pushed, never to the feature branch or `main` | "Store plans on a dedicated Git branch" (`pvgx8oh7`, completed) |
| Every `/plan-execute` and `/plan-review` run that commits to the feature branch ends by pushing it | `plan-execute/references/handoff.md` (Push), `plan-review/SKILL.md` (Push the feature branch) |
| After submit, `/plan-execute` merges base in, pushes, and opens or updates the pull request with a written body, then reports its link, mergeability, and CI so far | `plan-execute/references/handoff.md` (Hand off) |
| Guarded pull request writes that refuse a mismatched repo, branch, or head: replace the body, mark ready, rerun a failed run | `roborepo delivery pr-body`, `pr-ready`, `retry-ci` in `modules/delivery/operations.mjs` |
| The one module that runs `gh` | `modules/forge/github.mjs` |

### What is missing

| Gap | Today | Source |
| --- | --- | --- |
| Pull request timing | Opened only in the handoff after submit; nothing exists on GitHub while the Validation Loop runs | `handoff.md` Hand off step 6 |
| Draft handling | The handoff runs `pr-ready` whenever the pull request is a draft, whatever CI says | `handoff.md` Hand off step 6 |
| Waiting for CI | "A CI run still in progress is reported as running, not waited for." Runs take 15–22 minutes | `handoff.md` Hand off step 7 |
| Fixing red CI | Nothing reads a failing run's log or fixes it | No caller of `gh run view --log-failed` in the skills |
| Order of submit and CI | Submit runs before the base merge and push, so a plan reaches `review/` with CI unknown | `plan-execute/SKILL.md` Implementation Completion step 4 |
| Fixes in review | Committed one by one and pushed together at step 6; nothing checks that the pull request shows the reviewed commit | `plan-review/SKILL.md` steps 5 and 6 |
| Merge readiness | Reads local refs only; a tip that was never pushed passes | `mergeReadiness` in `modules/plan-suite/review-gates.mjs`; no test covers it |

### Commands and permissions

All allowed today in `manifests/inventory/agent-permissions.json`, so this plan adds no permission:

| Need | Command | Bucket |
| --- | --- | --- |
| Open the draft | `gh pr create --draft --base <base> --head <branch> --title … --body-file …` | allow (`open-prs`) |
| Read state and wait | `gh pr view`, `gh pr checks <number> --watch`, `gh run view <id> --log-failed` | allow (read-only) |
| Replace the body, mark ready, rerun a failed run | `roborepo delivery pr-body`, `pr-ready`, `retry-ci` | allow |
| Refresh the upstream before readiness | `roborepo delivery fetch <remote>` | allow |

`gh pr edit` and `gh pr ready` called directly are in the `ask` bucket; the skills use the
`roborepo delivery` commands instead.

`gh pr checks --required` is not usable: it reported "no required checks" on pull request #59
before required checks existed, and the plan suite installs into repos that may never require any.
The skills therefore watch all reported checks.

## Proposed design

### The delivery sequence in `/plan-execute`

```mermaid
flowchart TD
  C[First implementation commit] --> P[Push, open draft PR]
  P --> V[Validation Loop: affected checks, push fixes]
  V --> Q{Completion preflight passes?}
  Q -->|no| A[Stay active, push only]
  Q -->|yes| M[Merge base in, push, refresh PR body]
  M --> W[Watch all checks at head]
  W -->|all passed| S[Submit]
  W -->|failure not on base, attempts left| F[Read log, fix, commit, push] --> W
  W -->|same check still failing after 3 fixes| B[Stay active, record a blocker]
  W -->|fails on base too, or no checks| E[Submit, stay draft, name the exception]
  S --> R{Validator ended clean?}
  R -->|yes| D[roborepo delivery pr-ready]
  R -->|cap reached| X[Stay draft, name the exception]
```

The completion preflight runs first, as a check only, so a plan that is not finished never waits on
CI: it stays in `active/` and its branch is pushed, as today. A finished plan then merges base in
before the CI watch, so CI runs on the commit that will be reviewed. `roborepo plans submit` reruns
the preflight; a merge or CI fix cannot make it fail, since the preflight reads plan tasks, blockers,
a clean worktree, and branch commits. Submit commits only to the plans branch, so it does not change
the feature branch's head or start another CI run.

### One shared procedure

`plan-execute/references/handoff.md` stays the one reference both skills follow. `/plan-review`
links to it at `../plan-execute/references/handoff.md` instead of keeping its own push section.
The reference gains three parts and changes one.

**Open the draft early.** At the first push of a run, read the open pull request for the branch. When
none exists, run `gh pr create --draft` with a written body (the body rules in Hand off step 6 are
unchanged). Never use `--fill`. A resumed run reuses the existing pull request, draft or not.

**Watch CI.** After a push, run `gh pr checks <number> --watch` in the background where the harness
allows, so waiting spends no tokens. Then read `gh pr view --json headRefOid,statusCheckRollup` and
confirm the result is for the head commit:

| Result at head | Meaning | Action | Pull request |
| --- | --- | --- | --- |
| At least one check, all passed | Green | Continue | May leave draft |
| A failure that does not occur on base | Red | Read `gh run view <id> --log-failed`, fix, commit, push, watch again | Stays draft |
| The same check still failing after 3 fix commits for it | Blocked | Stop, record a blocker in Open Questions, report it | Stays draft |
| A failure that also occurs on base | Not green | Record it under `### Verification` as a base failure, continue, name it as an exception | Stays draft |
| No checks reported 2 minutes after the push | Not green | Run the canonical completion gate locally once, continue, name the exception | Stays draft |

"Continue" means the caller's next step. Only `/plan-execute`'s Implementation Completion submits
after it, as the diagram shows, and a Blocked result there keeps the plan in `active/`. Review
Findings and `/plan-review` never run a lifecycle transition at this point.

Rules the table relies on:

- **Base failure.** Read the base branch's CI result for the base commit the branch last merged;
  when it has none, rerun the failing check locally on the base branch. A failure counts as a base
  failure only when that evidence shows the same check failing there, as `/plan-review` step 3
  already defines it.
- **Attempts.** Counted per failing check, per run, so a rerun of the skill starts fresh, because a
  person chose to try again. One `roborepo delivery retry-ci <run-id>` is allowed per run for a
  failure that looks like infrastructure (a runner, network, or timeout error, not a test
  assertion), and it does not count as an attempt.
- **Never passing.** Base failures and missing checks never count as green.
- **No revalidation.** A CI fix does not rerun the Validation Loop; the final report lists it, and
  `/plan-review`'s Validator covers it.

**Mark ready only when earned.** Run `roborepo delivery pr-ready` only when the Validator ended clean,
CI is green at the head commit, and no `escalate` finding is open. This replaces today's rule of
readying any draft. A Validator that stopped at its cap leaves the pull request in draft;
`/plan-review` readies it after its own pass.

**Changed: the handoff runs before submit, and CI is waited for.** The Push and Hand off intros stop
saying the handoff follows the submit transition; it follows a passing completion preflight. Hand
off step 7 stops reporting "CI's result so far" and reports the result the watch reached.

Unchanged: a refused push or an unreachable GitHub is reported with the exact command under Needs
you, and the plan's lifecycle stands.

### `/plan-execute` changes

| Part | Change |
| --- | --- |
| Implementation Workflow step 13 (the implementation commit) | Push and open the draft pull request |
| Validation Loop | Push each pass's fixes as they are committed |
| `references/validation-loop.md` | Gate evidence is the affected checks' commands and output, plus the latest finished CI result when one exists. A pass never waits for CI, because a run takes 15–22 minutes and the loop can run eight passes |
| Implementation Completion, and its "Push and hand off the feature branch" subsection | Order becomes: completion preflight; if incomplete, stay active and push; if complete, hand off (merge base, push, refresh body), watch CI, submit, then mark ready. A blocked CI failure keeps the plan in `active/` |
| Review Findings | Watch CI after the existing handoff |
| Completion Conditions | The handoff line follows the new order, and CI's watched result is reported |
| `references/final-report.md` | The Record's pull request line gains its state, draft or ready; it already has the link, mergeability, and CI. The push row still shows only when a push failed |
| Boundaries | Allow opening this plan's pull request as a draft and marking it ready through `roborepo delivery`; merging stays forbidden |

### `/plan-review` changes

| Part | Change |
| --- | --- |
| Step 2, after base synchronization | Push the merge, opening the draft pull request if none exists |
| Step 5, fixing findings | Push each fix as it lands, instead of once at step 6, and take the full gate from CI's result at the fixed commit, per the shared procedure |
| Step 6, before presenting | Run `roborepo delivery fetch <remote>`, confirm with `gh pr view` that the pull request's head equals the local tip, and confirm CI is green there or name the exception. Link the pull request in the packet |
| Step 6a, after approval | Run `roborepo plans merge-readiness`. When it passes, CI is green at the reviewed commit, and step 5's Validator loop ended on a pass with no `fix` findings (not at its cap), mark the pull request ready if it is still a draft; otherwise leave it in draft and name why. Tell the user to merge |
| "Push the feature branch" section | Replaced by a link to the shared reference |
| Boundaries | Already allow pushing the plan's feature branch. Add opening it as a draft and marking it ready; merging the feature branch into the base and merging pull requests stay forbidden |

Approval is recorded on the plans branch, so step 6a pushes nothing to the feature branch and starts
no CI run.

### Merge readiness

`mergeReadiness` in `modules/plan-suite/review-gates.mjs` gains one check, "branch tip is pushed":

| State | Result |
| --- | --- |
| The branch's tip equals `<branch>@{upstream}` | Pass |
| The tip differs, or the repo has a remote but the branch has no upstream | Fail, with "push the branch" as the fix |
| The repo has no remote | Pass, observed as "no remote" |

It reads only local refs, so the command stays offline and fast. It depends on the fetch in
`/plan-review` step 6 for a current upstream. The pull request's head is compared by the skill
through `gh pr view`, not by this check, so `roborepo plans` keeps making no network calls.

### Related plans

| Plan | Relationship |
| --- | --- |
| "Store plans on a dedicated Git branch" (`pvgx8oh7`) | Landed dependency. Removed this plan's earlier steps for unpushed lifecycle commits and for pushing the approval commit |
| "Clear agent friction: permissions, rule conflicts, and stale docs" (`vzgsx5vz`) | Landed dependency, completed |
| "GitHub Integration Part 01" (`w7vls1yk`) | In review as pull request 82; changes the permission manifest and push guard. Not needed here: every command this plan uses is allowed today |
| "GitHub Integration Part 02" (`f0jwe76j`) | Plan-vs-plan drift: it cites `plan-execute/references/pr-delivery.md` for this plan's CI fixes. This plan keeps that procedure in the existing `handoff.md`; `f0jwe76j` needs its link updated when it is next promoted. No conflict in scope |
| "A current server is running whenever a plan is ready to review" (`kqgr1d65`) | Edits `handoff.md` and `final-report.md` after this plan; its server step runs after the pull request step defined here. Builds after this plan |
| "Approval survives clean merges of the base branch" (`d9ywaa8d`) | Builds after this plan; shares `review-gates.mjs` |
| `developer-runtime-remote-branch-status`, `0jped168` | No shared code. `0jped168` (behavior evals) is what would let the Not tested entry below become a test |

## Implementation plan

- [ ] Add the "branch tip is pushed" check to `mergeReadiness`, with cases in
      `scripts/test/plan-lifecycle-transitions-check.mjs` (where the `plans approve` fixtures live;
      merge readiness has no test today): tip equal to upstream passes; tip ahead of upstream fails;
      no upstream with a remote fails; no remote passes. Write the cases first and confirm the two
      failing ones fail before the check exists.
- [ ] Update `plan-execute/references/handoff.md`: draft at first push, the CI watch table and its
      rules, the mark-ready rule replacing "ready any draft", the Push and Hand off intros (the
      handoff now runs after the completion preflight and before submit), and Hand off step 7
      reporting the watched result.
- [ ] Update `plan-execute/SKILL.md`: step 13's push and draft, pushes during the Validation Loop, the
      new Implementation Completion order and its "Push and hand off the feature branch" subsection,
      Review Findings, Completion Conditions, and Boundaries.
- [ ] Update `plan-execute/references/validation-loop.md` and `references/final-report.md`.
- [ ] Update `plan-review/SKILL.md` steps 2, 5, 6, and 6a, replace its push section with a link to
      the shared reference, and update its Boundaries.
- [ ] Update the pins in `scripts/test/plan-suite-skills-check.mjs`: the handoff phrases that name
      the old order ("After the submit transition, and after Review Findings commits its fixes",
      "CI's result so far", "Then hand off the feature branch"), and the plan-review boundary
      phrase. Add pins for `handoff.md`: `--draft`, the 3-attempt limit, the rule that no checks is
      not green, and `pr-ready` only after green CI and a clean Validator.
- [ ] Update the docs under Documentation impact.

## Validation

- `node scripts/test/plan-lifecycle-transitions-check.mjs` passes, and the two failing
  merge-readiness cases failed before the check was added.
- `node scripts/test/plan-suite-skills-check.mjs` passes, with pins for the new procedure.
- `bash scripts/doctor.sh --quiet` passes. CI runs the full gate, because skills are package outputs.

## Not tested

- [ ] A complete plan run on a real change, using the skills as changed here: draft pull request at
      first push, CI watched without polling, a failing check fixed, marked ready, review fixes
      pushed, and the user merges. This plan's own run uses the installed skills from before the
      change, so it cannot show this. Text pins cannot show an agent follows the procedure, and
      behavior evals (`0jped168`) do not exist yet.

## Documentation impact

| Doc | Update |
| --- | --- |
| `docs/user/guides/plan/lifecycle/plan-suite.md` | The handoff paragraph under `/plan-execute` (draft at first push, CI watched, ready only when green), the review steps, and the merge step |
| `docs/user/reference/roborepo-cli.md` | The new check in the `merge-readiness` row |
| `docs/user/reference/plans-portal.md`, `docs/internal/plans-portal-internals.md` | What merge readiness requires |

## Risks

| Risk | Mitigation |
| --- | --- |
| A run now waits 15–22 minutes for CI before submit | Accepted: the wait spends no tokens in the background, and it replaces the user checking by hand later |
| A long CI run outlasts the session | Nothing is stored about the wait. Rerunning `/plan-execute` finds the pull request and reads its current checks |
| More pushes mean more CI runs | `.github/workflows/ci.yml` cancels superseded runs on the same ref |
| A CI fix lands after the last Validator pass | The final report lists it, and `/plan-review` runs its own Validator before approval |

## Decision Log

- 2026-11-24, during promotion: kept the shared procedure in the existing
  `plan-execute/references/handoff.md` instead of a new `pr-delivery.md`, because both skills
  already push through it and a second reference would duplicate its push and body rules.
- 2026-11-24, during promotion: moved the base merge ahead of the CI watch, so the commit CI passes
  is the commit the plan is submitted at, and put the completion preflight first, so an unfinished
  plan never waits on CI.
- 2026-11-24, during promotion: dropped the acceptance check that this plan's own pull request opens
  as a draft. The run that builds this plan uses the skills from before the change; the real-run
  check stays under Not tested.
- 2026-11-24, during promotion: dropped the steps for unpushed lifecycle commits riding along and
  for pushing the approval commit, because `pvgx8oh7` moved those commits to the plans branch.
- 2026-11-24, during promotion: the skills use `roborepo delivery pr-ready` and `retry-ci` rather
  than `gh pr ready` (in the `ask` bucket) and `gh run rerun`, because the delivery commands are
  allowed and refuse a pull request or run that does not match the pushed head.
