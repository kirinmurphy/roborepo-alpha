---
name: plan-close
description: Use when closing one repository plan whose implementation is finished or abandoned. Run the repository's tests, check the plan's claims against the code, decide complete, incomplete, blocked, or superseded, refuse to close while Not tested entries remain unconfirmed or the work has not landed in the base branch, and move a verified plan to docs/plans/completed/ or an abandoned one to docs/plans/archived/. Trigger on explicit /plan-close or requests such as close this plan, archive this plan, or review whether a plan is complete. Do not use for creating or revising plans (plan-write), preparing a plan (plan-promote), implementing (plan-start), ending a session (session-close), reviewing a working diff, or merging branches.
---

# Plan Close

Close one existing plan: prove the work is done, or say exactly why it is not.

A closed plan is a claim the next reader trusts without checking, so this skill refuses rather than
closes whenever the evidence is incomplete. A refusal names what is open and updates the plan; it
is a correct outcome, not a failure.

## Inputs

Resolve:

- the repository root and base branch (`main` unless repository policy names another);
- the selected plan, by id or path;
- the repository's own test command, from `package.json` scripts, a `Makefile`, `justfile`,
  `pyproject.toml`, or CI config — never an invented one;
- current Git state, including the plan's `worktree` and that worktree's branch.

The eligible source lifecycle is the one that precedes completion in the plan lifecycle policy
(`modules/plan-suite/lifecycle-policy.mjs`): today, `active/`. A plan in any other lifecycle is
refused with its current location named.

## Paired Skills

Load these when the run calls for them; do not wait to be asked for them by name.

| Skill | Load when | Contributes |
| --- | --- | --- |
| `technical-writing` | Writing the completion summary and `## Verification` section | Section content and reader clarity |
| `test-harness` | Judging whether a failing or missing test is relevant to the plan | Test selection and observable-behavior assertions |

Each row is its own optional package, so check it before loading it:

1. Run `roborepo package status <skill> --json`.
2. If `available` is true, `enabled` is true, and `status` is `enabled` or `configured`, load it.
3. If it is disabled, ask: "`<skill>` is not enabled. Enable it, or skip it for this run?"
   - **Enable:** run `roborepo package enable <skill>` with the user's permission, then load it.
   - **Skip:** continue without it, and name it as skipped in the final report.
4. If `enabled` and `status` disagree (`partial`, `external`), report the status, offer
   `roborepo package reconcile` or skip, and never describe a drifted package as loaded.
5. If it is `missing` or `unavailable`, skip it and say so in the final report.

## Workflow

Each step runs only when the one before it passes. Read `references/verdict.md` before step 3.

### 1. Run the tests

Run the repository's test command from the checkout that holds the plan's landed work, and wait for
it. Tests run first because a red suite changes the code the verdict would judge.

On failure, refuse: report the failing output and stop. If the failure is clearly pre-existing and
unrelated (it also fails on the base branch), say so and ask whether to continue; do not decide
that alone.

### 2. Validate the document

Run `roborepo plans validate <plan> --json`. Its findings feed the verdict; a lifecycle finding
such as an empty `next_action` on an active plan is reported, never invented away.

### 3. Check the plan against the code

Check every claim against the code, not against its checkboxes:

- checked items are really implemented;
- unchecked items that quietly landed are reported;
- requirements the code does not satisfy are reported;
- items the plan marks deliberately deferred, with the reason written next to them, are not
  reported as open;
- UI or manual checks that could not run are reported as unverified, never as passed.

### 4. Decide the verdict

Follow `references/verdict.md`:

- **Incomplete or blocked:** refuse. Name the open work, update the plan's tasks and `next_action`,
  and leave it in its lifecycle folder.
- **Superseded or abandoned:** record the reason in the plan, then `git mv` it to
  `docs/plans/archived/`.
- **Complete:** continue to step 5.

### 5. Confirm `## Not tested` is clear

Unchecked `## Not tested` entries are built work nobody confirmed. While any remain, refuse and list
them; `roborepo plans validate` reports them as `UNCONFIRMED_NOT_TESTED`. Never check one off
yourself. The user clears an entry by confirming it by hand, or by deleting it with the reason
recorded in the plan's `## Decision Log`.

### 6. Confirm the work landed

The work must be in the base branch, including after a squash or rebase merge.

- A plan with an empty `worktree` was implemented on the base branch; it has landed.
- Otherwise resolve the worktree's branch from `git worktree list --porcelain` and run
  `git merge-base --is-ancestor <branch> <base>`. Exit 0 proves it landed.
- Any other result, or a worktree that no longer resolves, is `landed: unconfirmed`. Ancestry can
  only prove a merge, not disprove one: a squash merge reads as unmerged. Refuse, and report the
  branch, the evidence, and that the content-level landed test from the worktree-cleanup plan
  (`a7bslb00`) is what will settle squash merges once it exists.

### 7. Close

`git mv` the plan to `docs/plans/completed/`, keeping its filename and `id`. Clear `next_action`,
add a completion summary, and write a `## Verification` section with the evidence: the test command
and result, what was checked against the code, and anything that could not be verified. Run
`roborepo plans validate <plan>` against the moved file and resolve every finding.

Stage the plan by path. Commit only when the user asks; never push.

### 8. Stop the worktree's servers

Only after step 7 closed a complete plan, run `roborepo plans stop-servers <plan> --json`. It sends
`SIGTERM` to the processes listening on a port from inside the plan's linked worktree, and nothing
else: never the primary checkout, never agent sessions, shells, or editors. Do not ask first; the
work has landed, so these servers run stale code. Report each server with its PID, ports, and
result. A server that is `still-running` or `failed` is reported, never killed by other means.
Skip this step for an archived or refused plan.

## Final Report

```text
Close result
- Plan: <id and repository-relative path>
- Tests: <command> -> pass|fail|not run
- Verdict: complete|incomplete|blocked|superseded|abandoned
- Not tested entries open: <count>
- Landed: yes|unconfirmed|not applicable
- Lifecycle change: <from> -> <to>, or none
- Closed: yes|no
- Servers stopped: <pid :port result, ...>|none|skipped
```

Also report the evidence behind the verdict, every refusal reason, unverified checks, paired skills
loaded or skipped, and current Git status.

## Boundaries

Do not:

- close a plan while tests fail, work is open, a `## Not tested` entry is unchecked, or landing is
  unconfirmed;
- check off `## Not tested` entries;
- implement missing work; report it and leave it to `/plan-start`;
- merge, push, delete branches, or remove worktrees;
- close more than the one named plan.
