---
name: plan-close
description: Use when closing one repository plan whose implementation is finished or abandoned. Run the repository's checks, fix agent-resolvable gaps including missing tests, check claims and landing, and move a verified plan to docs/plans/completed/ or an abandoned one to docs/plans/archived/. Refuse only for unresolved work, unconfirmed manual checks, or unconfirmed landing. Trigger on explicit /plan-close or requests such as close this plan, archive this plan, or review whether a plan is complete. Do not use for creating or revising plans (plan-write), preparing a plan (plan-promote), beginning implementation (plan-start), ending a session (session-close), reviewing a working diff, or merging branches.
---

# Plan Close

Close one existing plan: prove the work is done, or say exactly why it is not.

A closed plan is a claim the next reader trusts without checking. Resolve gaps within the selected
plan's scope when the agent can do so, then refuse only if evidence or required work remains
incomplete. A refusal names every remaining issue and updates the plan when required.

## Inputs

Resolve:

- the repository root and base branch (`main` unless repository policy names another);
- the selected plan, by id or path;
- the repository's canonical completion gate and any plan-specific tests, from `package.json`
  scripts, a `Makefile`, `justfile`, `pyproject.toml`, or CI config — never an invented one. A
  release or publication check is not a universal closure requirement unless the plan owns
  release or publication behavior;
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

1. Check the host's skill/package manager for `<skill>` and read its availability and activation state.
2. If `available` is true, `enabled` is true, and `status` is `enabled` or `configured`, load it.
3. If it is disabled, ask: "`<skill>` is not enabled. Enable it, or skip it for this run?"
   - **Enable:** use the host's package manager to enable `<skill>` with the user's permission, then load it.
   - **Skip:** continue without it, and name it as skipped in the final report.
4. If `enabled` and `status` disagree (`partial`, `external`), report the status, offer
   the host's package reconciliation command or skip, and never describe a drifted package as loaded.
5. If it is `missing` or `unavailable`, skip it and say so in the final report.

## Workflow

Work through the steps in order. Repairs can return the run to tests and validation; decide the
verdict only from the resulting state. Read `references/verdict.md` before step 3.

### 1. Run the tests

Run the repository's canonical completion gate from the checkout that holds the plan's landed work,
then run focused tests named by the plan. Prefer the repository's canonical CI command over a broad
discovery command when that command also includes release-only or
optional environment suites. Tests run first because a red plan-relevant suite changes the code the
verdict would judge.

On a plan-relevant failure, inspect the cause and fix it when the change is within the selected
plan's scope and can be made autonomously. Add a missing regression test when needed, rerun the
affected checks, and rerun the completion gate after code or test changes. If the failure needs a
user decision or an external dependency, record the failing output, continue independent
agent-resolvable work, and refuse at the verdict if it remains. For an unrelated, pre-existing
failure, report the exact output and continue only when the user explicitly waives it;
record the failure as unverified in the completion evidence. The availability of optional tools or
environment fixtures is not a closure prerequisite for an unrelated plan; evaluate each check
against the behavior this plan owns. Likewise, environment-matrix, release, registry, and
publication checks are relevant only when the
plan owns that environment or release behavior; otherwise classify them as optional evidence rather
than universal closure gates.

### 2. Validate the document

Run the repository's canonical plan validator for `<plan>` with machine-readable output. Resolve
agent-actionable findings and rerun it. Its remaining findings feed the verdict; a lifecycle finding
such as an empty `next_action` on an active plan is reported, never invented away.

### 3. Check the plan against the code

Check every claim against the code, not against its checkboxes:

- checked items are really implemented;
- unchecked items that quietly landed are reported;
- requirements the code does not satisfy are reported;
- items the plan marks deliberately deferred, with the reason written next to them, are not
  reported as open;
- UI or manual checks that could not run are reported as unverified, never as passed.

You must fix agent-resolvable gaps before the verdict: correct in-scope code or plan claims, add a
missing regression test for untested observable behavior, and perform available UI
checks. Keep the fix within the selected plan and existing authorization. Rerun the affected checks,
the canonical completion gate after code or test changes, and the plan validator after document
changes. Only leave an issue open when it needs a user decision, manual confirmation, an external
dependency, or work outside this plan.

### 4. Decide the verdict

Follow `references/verdict.md`:

- **Incomplete or blocked after agent-resolvable repairs:** refuse. Name the remaining work, update
  the plan's tasks and `next_action`, and leave it in its lifecycle folder.
- **Superseded or abandoned:** record the reason in the plan, then `git mv` it to
  `docs/plans/archived/`.
- **Complete:** continue to step 5.

### 5. Confirm `## Not tested` is clear

Unchecked `## Not tested` entries are built work nobody confirmed. Attempt each check the agent
can perform: run an existing test, add a missing regression test for observable behavior, or use an
available UI. Check off an entry only after recording the concrete passing evidence in the plan.
If this changes code or tests, rerun the affected checks and canonical completion gate; rerun the
plan validator after changing the document. Never check off manual-only `## Not tested` entries
without the user's confirmation. A user may instead defer an entry to another plan; record that
scope decision and its reason in the `## Decision Log` before removing the entry. While any
unchecked entries remain, refuse and list them; the validator reports `UNCONFIRMED_NOT_TESTED`.

### 6. Confirm the work landed

The work must be in the base branch, including after a squash or rebase merge.

- A plan with an empty `worktree` was implemented on the base branch; it has landed.
- Otherwise resolve the worktree's branch from `git worktree list --porcelain` and run
  `git merge-base --is-ancestor <branch> <base>`. Exit 0 proves it landed.
- If ancestry returns non-zero, perform a content-level landed check for squash and rebase merges:
  identify the implementation files changed by the worktree branch, compare those files with the
  base branch, and confirm that the implementation content is present on the base branch. Ignore
  only lifecycle-only plan moves and documented post-merge plan synchronization; do not ignore
  implementation differences. Record the compared branch, base, and file-level result in the
  completion evidence.
- If the content-level check succeeds, report `landed: yes` even though ancestry is false. If the
  worktree no longer resolves or the content-level comparison cannot prove the implementation is
  present, report `landed: unconfirmed` and refuse. Ancestry alone can prove a merge, not disprove
  a squash merge.

### 7. Close

`git mv` the plan to `docs/plans/completed/`, keeping its filename and `id`. Clear `next_action`,
add a completion summary, and write a `## Verification` section with the evidence: the test command
and result, what was checked against the code, and anything that could not be verified. Run
the repository's canonical plan validator against the moved file and resolve every finding.

Stage the plan by path. Commit only when the user asks; never push.

### 8. Stop the worktree's servers

Only after step 7 closed a complete plan, run the repository's canonical linked-worktree server
cleanup command for `<plan>`. It sends `SIGTERM` to the processes listening on a port from inside
the plan's linked worktree, and nothing
else: never the primary checkout, never agent sessions, shells, or editors. Do not ask first; the
work has landed, so these servers run stale code. Report each server with its PID, ports, and
result. A server that is `still-running` or `failed` is reported, never killed by other means.
Skip this step for an archived or refused plan.

## Refusal and blocker reporting

When any remaining issue prevents closure, stop and report every issue explicitly. Do not report
only a count or a generic "blocked" status. Lead with the user-visible behavior or concrete
input/output: what someone tries to do, the expected and observed outcome, and what remains
uncertain if the action has not been tried. Use plain language before naming internal files, test
codes, or Git mechanics. For each issue, include:

- the exact plan entry, validation finding, failed check, or Git result;
- why it prevents closure;
- the user action that would resolve it; and
- whether it is manual confirmation, implementation work, an external dependency, or an
  unconfirmed landing result.

For unchecked `## Not tested` entries, quote or faithfully reproduce each entry so the user can
confirm the specific behavior. For `landed: unconfirmed`, name the branch/worktree, base branch,
exact ancestry result, and the content-level check that is still needed. Preserve all open issues
in the plan's lifecycle folder; never check off a manual entry without user confirmation.

End every blocked or refused report with: **Would you like help resolving any of these issues?**
If the user says yes, help with the listed issues without silently changing their confirmation or
merge decisions.

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
loaded or skipped, the complete remaining-issues list when closure is refused, the help offer, and
current Git status.

## Boundaries

Do not:

- close a plan while tests fail, work is open, a `## Not tested` entry is unchecked, or landing is
  unconfirmed;
- check off manual-only `## Not tested` entries without user confirmation;
- expand implementation beyond the selected plan's scope or silently decide a material design tradeoff;
- merge, push, delete branches, or remove worktrees;
- close more than the one named plan.
