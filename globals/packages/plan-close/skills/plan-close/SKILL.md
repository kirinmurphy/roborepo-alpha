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

### 0. Confirm the worktree's plan copy is integrated

Do this first, before step 1, from the primary checkout (the first `worktree` entry of
`git worktree list --porcelain`). While a plan is active, the copy in its assigned worktree is the
authoritative one; by the time a plan is complete its branch has merged, so the worktree has
nothing left to contribute. This step reads the worktree's copy once, and the rest of the run works
only in the primary checkout.

The worktree's copy is usable when the primary copy is in `docs/plans/active/` and names a
worktree, Git has a linked worktree with that administrative name, and that worktree holds a
readable copy with the same `id`, still in `docs/plans/active/`, naming the same worktree. When the
plan names no worktree, skip this step. When the worktree's copy is not usable, skip the check and
state in the final report that the worktree's plan state was not available.

Otherwise the copy is integrated when the base branch already has every plan version the worktree
has: the worktree copy's working bytes equal the primary copy's working bytes, or its blob id is
the plan at the branch's fork or a plan blob the base branch produced since then. Run in the
primary checkout:

```text
git merge-base HEAD <branch>                              # <fork>
git hash-object <worktree>/<plan path>                    # the worktree copy's blob id
git rev-parse <fork>:<plan path>                          # the plan at the fork
git log --raw --no-abbrev --format= <fork>..HEAD -- docs/plans
```

In the `--raw` lines, the fourth field is the blob each commit produced.

- **Not integrated:** the worktree holds a plan version the base branch never had, so its plan
  progress has not landed. Refuse with `plan: not integrated`, naming the worktree and the plan
  path, and make no plan edits. Never copy the worktree's version into the primary checkout. The
  only other outcome of such a run is archiving superseded or abandoned work through the archive
  handoff in step 4.
- **Integrated:** authority returns to the primary copy for the rest of the run. Every plan edit in
  steps 2 through 7 — validator fixes, corrected claims, `## Not tested` evidence, verification,
  the move to `completed/` — goes to the primary copy, including the notes of a later refusal.
  Never edit the worktree's copy. Until the plan closes, the portal reports those notes as an
  outside edit; a rerun of this step still passes, because the base branch has every version the
  worktree has.

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

Check the affected reader-facing docs of record named in `## Documentation impact`, and any
additional docs the implementation actually affects, against the landed code. Use the repository's
doc-of-record map when one exists. Fix in-scope drift before the verdict; unresolved required drift
prevents closure. For older plans without that section, derive the affected docs from the landed
change instead of requiring a plan migration.

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
  `docs/plans/archived/`, in the primary checkout. Abandoned work never merges, so Git never
  brings the worktree's plan copy to the base branch; archiving carries it there once, as step 0
  left the copies:

  | Copies | Archiving does |
  | --- | --- |
  | Worktree copy integrated, or the plan names no worktree | Records the reason in the primary copy and moves it |
  | Worktree copy not integrated, and the primary copy equals the plan at the fork or a blob the worktree branch produced (`git log --raw --no-abbrev --format= <fork>..<branch> -- docs/plans`) | Writes the worktree copy's content into the primary copy, records the reason, and moves it, staged by path as one archive change on the base branch |
  | Worktree copy not integrated, and the primary copy holds a version the worktree never had | Refuses with `plan: conflicting copies`, naming both; the user merges the base branch into the worktree, or moves the edit into the worktree's copy and reverts it in the primary checkout |
  | Worktree copy unavailable | Archives the primary copy and states in the final report that the worktree's plan state was not available |

  This is the only time plan content is copied between checkouts: once, one way, at the archive
  transition. Never merge two edited copies.
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
- Otherwise resolve the worktree's branch from `git worktree list --porcelain`. If it no longer
  resolves, report `landed: unconfirmed` and refuse.
- Confirm the branch carried its own work: starting at its oldest reflog entry, find at least one
  commit on the branch that is absent from the base branch's first-parent history. If the reflog
  has expired, do not infer a starting point from ancestry alone; report `landed: unconfirmed`.
- Find the branch's fork with `git merge-base <base> <branch>`. Walk the base's first-parent commits
  after that fork, oldest first, up to the repository's scan limit. A commit absorbs the branch
  when merging the branch into that historical commit changes no tree content. Use the repository's
  canonical landed check when available; otherwise compare the merge result's tree to the base
  commit's tree. The first absorbing commit proves the work landed even if later base commits
  changed those files. Record the branch, base, and absorbing commit in the completion evidence.
- If no scanned first-parent commit absorbs the branch, the scan limit is exceeded, or any required
  Git evidence is unavailable, report `landed: unconfirmed` and refuse.

### 7. Close

`git mv` the plan to `docs/plans/completed/`, keeping its filename and `id`. Clear `next_action`,
add a completion summary, and write a `## Verification` section with the evidence: the test command
and result, which affected docs of record were checked against the landed code, what else was
checked, and anything that could not be verified. Run
the repository's canonical plan validator against the moved file and resolve every finding.

Stage only the old and new plan paths. Immediately before committing, re-read Git status and the
staged diff to identify any unrelated work. After validation passes, commit the completed plan's
move and edits automatically, even when other paths are staged:

```text
git commit --only -m "Close plan <id>" -- <active plan path> <completed plan path>
```

The two pathspecs are this plan's paths before and after the move; never use a wildcard, `-a`, or
an unrestricted commit. Confirm the new commit contains only those plan paths and that unrelated
staged or unstaged work remains in place. Never push. If the commit fails, report the failure, mark
the closure as not durable, and do not proceed with server or worktree cleanup.

### 8. Stop the worktree's servers

Only after step 7 committed a complete plan, run the repository's canonical linked-worktree server
cleanup command for `<plan>`. It sends `SIGTERM` to the processes listening on a port from inside
the plan's linked worktree, and nothing
else: never the primary checkout, never agent sessions, shells, or editors. Do not ask first; the
work has landed, so these servers run stale code. Report each server with its PID, ports, and
result. A server that is `still-running` or `failed` is reported, never killed by other means.
Skip this step for an archived or refused plan.

### 9. Remove the closed worktree

After step 8, when the plan was moved to `completed/`, run the repository's canonical worktree
cleanup command scoped to this plan with its apply flag. Report whether it removed the worktree and
branch, which guard kept them, or why removal failed. Do not remove the worktree by hand or bypass
a guard. Skip this step for an archived or refused plan, and in repositories without a canonical
cleanup command.

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
- Close commit: <hash>|failed|not applicable
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
