---
name: plan-close
description: Use when closing one repository plan after its reviewed pull request has merged, or rerunning closure to confirm completion or resume guarded cleanup. Close from docs/plans/review/; recognize an already committed plan in docs/plans/completed/ without repeating closure. Run the repository's checks, fix agent-resolvable gaps including missing tests, check claims, a fresh human approval, and landing, then commit completion and clean up the plan's worktree. Refuse only for unresolved work, unconfirmed manual checks, a stale or missing approval, or unconfirmed landing; hand superseded or abandoned plans to plan-archive. Trigger on explicit /plan-close or requests such as close this plan now that it has merged. Do not use for creating or revising plans (plan-write), preparing a plan (plan-promote), implementation (plan-execute), the human review or approval (plan-review), archiving (plan-archive), ending a session (session-close), reviewing a working diff, or merging branches.
---

# Plan Close

Close one merged plan: prove the work is done and accepted, or say exactly why it is not.

A closed plan is a claim the next reader trusts without checking. Resolve gaps within the selected
plan's scope when the agent can do so, then refuse only if evidence or required work remains
incomplete. A refusal names every remaining issue and updates the plan when required.

`/plan-close` is a single post-merge action. The user merges the reviewed implementation into the
base branch through a pull request, outside RoboRepo; this command runs afterwards. It never merges,
never synchronizes the base branch into the feature branch, and never waits for a merge.

## Inputs

Resolve:

- the repository root and base branch (`main` unless repository policy names another);
- the selected plan, by id or path;
- the repository's canonical completion gate and any plan-specific tests, from `package.json`
  scripts, a `Makefile`, `justfile`, `pyproject.toml`, or CI config — never an invented one. A
  release or publication check is not a universal closure requirement unless the plan owns
  release or publication behavior;
- current Git state, including the plan's `worktree` and that worktree's branch.

The eligible source lifecycle is the one that precedes completion in the lifecycle manifest
(`manifests/platform/plan-lifecycle.json`): `review/`. A committed `completed/` plan takes the
idempotent retry path below. A plan in any other lifecycle is refused with
its current location named and the command that fits it: `/plan-execute` or `/plan-review` for an
active plan, `/plan-archive` for work that will not be completed.

### Idempotent retries

Before loading paired skills or running the workflow, resolve the selected plan's current primary
path by id. If the supplied review path no longer exists, look for the same filename in
`completed/` and verify its id against prior evidence when available; never select a different plan.

When the plan is already in `completed/`, confirm that the same completed document is committed on
the base branch and its working copy has no pending edits. Report **already closed**, with the
existing close commit. Do not rerun tests, seek another approval, edit the plan, or make another
closure commit. The assigned worktree may already be gone; that is normal after successful cleanup.
If the completed document is uncommitted or edited, report the discrepancy without overwriting it
or claiming that closure is durable.

For an already closed plan, inspect whether its named linked worktree still exists. If absent,
report cleanup already done and stop. If present, resume only steps 9 and 10 with the canonical
plan-scoped commands and their current guards. Do not repeat a completed cleanup action or remove
a branch by hand. Report any guard that keeps the worktree without undoing the closed result.

For a plan still in `review/`, resume verification of the remaining requirements. Reuse matching
landing evidence as described in step 7; a previous refusal does not grant approval or make a
failed test pass. Recheck mutable requirements against the current state.

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

For a plan not already closed, work through the steps in order. Repairs can return the run to tests and validation; decide the
verdict only from the resulting state. Read `references/verdict.md` before step 3.

### 0. Confirm the worktree's plan copy is integrated

Do this first, before step 1, from the primary checkout (the first `worktree` entry of
`git worktree list --porcelain`). While a plan is in `active/` or `review/`, the copy in its assigned
worktree is the authoritative one; by the time a plan closes its branch has merged, so the worktree
has nothing left to contribute. This step reads the worktree's copy once, and the rest of the run
works only in the primary checkout.

The worktree's copy is usable when the primary copy is in `docs/plans/review/` and names a worktree,
Git has a linked worktree with that administrative name, and that worktree holds a readable copy
with the same `id`, in `docs/plans/active/` or `docs/plans/review/`, naming the same worktree. A copy
still in `active/` is expected when the final merge did not carry the review rename. When the plan
names no worktree, skip this step. When the worktree's copy is not usable, skip the check and state
in the final report that the worktree's plan state was not available.

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

In the `--raw` lines, the fourth field is the blob each commit produced. The canonical close
transition command repeats this check before it commits.

- **Not integrated:** the worktree holds a plan version the base branch never had, so the pull
  request has not merged, or the local base branch has not been updated since it did. Refuse with
  `plan: not integrated`, naming the worktree and the plan path, and make no plan edits. Never copy
  the worktree's version into the primary checkout.
- **Integrated:** authority returns to the primary copy for the rest of the run. Every plan edit in
  steps 2 through 8 — validator fixes, corrected claims, `## Not tested` evidence, verification —
  goes to the primary copy, including the notes of a later refusal. Never edit the worktree's copy.
  Until the plan closes, the portal reports those notes as an outside edit; a rerun of this step
  still passes, because the base branch has every version the worktree has.

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

A fix made here lands on the base branch after the reviewed merge, so it is outside what the human
approved. Keep such fixes to tests and evidence; a change to behavior needs `/plan-review` again.

### 2. Validate the document

Run the repository's canonical plan validator for `<plan>` with machine-readable output. Resolve
agent-actionable findings and rerun it. Its remaining findings feed the verdict; a lifecycle finding
is reported, never invented away.

### 3. Check the plan against the code

Check every claim against the code, not against its checkboxes:

- checked items are really implemented;
- unchecked items that quietly landed are reported;
- requirements the code does not satisfy are reported;
- items the plan marks deliberately deferred, with the reason written next to them, are not
  reported as open;
- every finding under `## Review` is checked off with its resolution;
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
  the plan's tasks and `next_action`, and leave it in `review/`.
- **Superseded or abandoned:** stop and direct the user to `/plan-archive`, naming the reason you
  found. `/plan-close` never archives.
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

### 6. Confirm a fresh human approval

Run the repository's canonical approval check for `<plan>`. It reads `### Approval` under
`## Review` and compares the reviewed implementation commit with the landed branch tip, outside
`docs/plans/`.

- `fresh`: continue.
- `stale`: the implementation changed after it was approved, for example when the base branch moved
  before the merge. Refuse, name the changed paths, and direct the user to `/plan-review`.
- `missing`, `not-approved`, or `invalid`: refuse and direct the user to `/plan-review`. Never write
  or repair an approval here.
- `unavailable`: the plan names a worktree whose branch cannot be resolved (the worktree was removed,
  or its HEAD is detached), so neither the approval nor the landing can be checked. Refuse, and ask
  the user to recreate the linked worktree with the same name on the plan's branch. Never compare
  against the base branch instead.

### 7. Confirm the work landed

The work must be in the base branch, including after a squash or rebase merge.

Run the repository's canonical landed check for `<plan>`. A previous run's landing evidence is
the absorbing commit recorded in the plan's `## Verification` as
`- Absorbing commit: <full commit id>`. The check verifies that commit rather than trusting it:

- the absorbing commit is still in the selected base branch's first-parent history after the
  branch's fork;
- merging the branch's current tip into it still changes no tree content, so branch work added
  after the recorded landing is never covered by it.

A verified commit is reused instead of scanning base history again. A missing, malformed, or
failed one falls back to the full scan below. A portal badge, a remembered status, or a bare
`landed: true` is never evidence. Report whether the evidence was reused or newly scanned. Repeated
`/plan-close` invocations do not require a new scan when the recorded proof still holds; landing
never stands in for tests or human approval, which remain separate gates.

The full scan, which the canonical check performs and which a repository without one does by hand:

- A plan with an empty `worktree` was implemented on the base branch; it has landed.
- Otherwise resolve the worktree's branch from `git worktree list --porcelain`. If it no longer
  resolves, report `landed: unconfirmed` and refuse.
- Confirm the branch carried its own work: starting at its oldest reflog entry, find at least one
  commit on the branch that is absent from the base branch's first-parent history. If the reflog
  has expired, do not infer a starting point from ancestry alone; report `landed: unconfirmed`.
- Find the branch's fork with `git merge-base <base> <branch>`. Walk the base's first-parent commits
  after that fork, oldest first, up to the repository's scan limit. A commit absorbs the branch
  when merging the branch into that historical commit changes no tree content: compare the merge
  result's tree to the base commit's tree. The first absorbing commit proves the work landed even
  if later base commits changed those files.
- If no scanned first-parent commit absorbs the branch, the scan limit is exceeded, or any required
  Git evidence is unavailable, report `landed: unconfirmed` and refuse.

### 8. Close

In the primary copy, clear `next_action`, add a completion summary, and write a `## Verification`
section with the evidence: the test command and result, which affected docs of record were checked
against the landed code, the approved commit, the absorbing commit as
`- Absorbing commit: <full commit id>`, what else was checked, and anything that could not be
verified. Later landing checks verify that recorded line instead of rescanning. Run the repository's canonical plan validator and resolve every
finding.

Then run the repository's canonical close transition command for `<plan>` from the primary checkout.
It re-verifies integration, approval freshness, and landing, validates the `completed/`
requirements, moves the plan from `review/` to `completed/` with `git mv`, and commits only the
plan's old and new paths, even when other paths are staged. Unrelated staged or unstaged work stays
in place. It never pushes. Report the commit it made. If it refuses, report each reason; the closure
is not durable, so do not proceed with server or worktree cleanup.

The close command verifies the recorded absorbing commit itself, the same way step 7 does, rather
than rescanning. Keep its checks; do not run another standalone landing check immediately before
it or bypass its guards with a remembered status.

### 9. Stop the worktree's servers

Only after step 8 committed a complete plan, or the retry path confirmed an existing committed
completion, run the repository's canonical linked-worktree server
cleanup command for `<plan>`. It sends `SIGTERM` to the processes listening on a port from inside
the plan's linked worktree, and nothing
else: never the primary checkout, never agent sessions, shells, or editors. Do not ask first; the
work has landed, so these servers run stale code. Report each server with its PID, ports, and
result. A server that is `still-running` or `failed` is reported, never killed by other means.
Skip this step for an archived or refused plan.

### 10. Remove the closed worktree

After step 9, when the plan was moved to `completed/`, run the repository's canonical worktree
cleanup command scoped to this plan with its apply flag. Scoped to the plan, it verifies the plan's
recorded absorbing commit too. Report whether it removed the worktree and branch, whether its
landing evidence was reused or scanned, which guard kept them, or why removal failed. Do not remove the worktree by hand or bypass
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
- whether it is manual confirmation, implementation work, an approval to renew, an external
  dependency, or an unconfirmed landing result.

For unchecked `## Not tested` entries, quote or faithfully reproduce each entry so the user can
confirm the specific behavior. For `landed: unconfirmed`, name the branch/worktree, base branch,
exact ancestry result, and the content-level check that is still needed. For a stale approval,
name the approved commit, the branch tip, and the changed paths. Preserve all open issues in the
plan's lifecycle folder; never check off a manual entry without user confirmation.

End every blocked or refused report with: **Would you like help resolving any of these issues?**
If the user says yes, help with the listed issues without silently changing their confirmation,
approval, or merge decisions.

## Final Report

Name the plan by its H1 title, with its id in parentheses on first mention only. The id is the
stable reference for commands and frontmatter, not a name a person recognizes; the same goes for
questions, review packets, and other prose in this run.

```text
Close result
- Plan: "<title>" (<id>), <repository-relative path>
- Tests: <command> -> pass|fail|not run
- Verdict: complete|incomplete|blocked|superseded|abandoned
- Not tested entries open: <count>
- Approval: fresh at <commit>|stale|missing|not-approved|invalid|unavailable
- Landed: yes (evidence reused|scanned)|unconfirmed|not applicable
- Lifecycle change: review -> completed, or none
- Closed: yes|no
- Close commit: <hash>|failed|not applicable
- Servers stopped: <pid :port result, ...>|none|skipped
```

Also report the evidence behind the verdict, every refusal reason, unverified checks, paired skills
loaded or skipped, the complete remaining-issues list when closure is refused, the help offer, and
current Git status.

For an already closed retry, report `Closed: yes (already closed)`, the existing close commit,
`Lifecycle change: none`, and any resumed cleanup results. Mark tests, approval, and landing
`not rerun (already closed)` rather than presenting historical results as fresh checks. Paired
skills not needed by this path are `not applicable`.

## Boundaries

Do not:

- close a plan while tests fail, work is open, a `## Not tested` entry is unchecked, the approval is
  not fresh, or landing is unconfirmed;
- check off manual-only `## Not tested` entries without user confirmation;
- write, repair, or infer an approval;
- archive a plan; that is `/plan-archive`;
- synchronize the base branch into the feature branch, or wait for a merge;
- expand implementation beyond the selected plan's scope or silently decide a material design tradeoff;
- merge, push, delete branches, or remove worktrees by hand;
- close more than the one named plan.
