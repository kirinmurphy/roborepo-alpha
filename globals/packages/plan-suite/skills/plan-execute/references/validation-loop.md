# Validation Loop

Implementation finishes with a loop of two roles, so the work reaches review already checked. The
agent that wrote the code shares its own blind spots, so the role that grades the work never writes
it, and it judges from the plan and the diff rather than from the implementer's account.

- **Implementer**: this session. Owns the code, the fixes, the commits, and the plan record.
- **Validator**: reads, runs read-only checks, and reports findings. It never edits a file,
  commits, or decides how a finding is fixed.

This file is how `/plan-execute` runs the Validator and acts on its report. What the Validator
checks, and how it rates and classes a finding, is the `implementation-review` skill's rubric, which
`/plan-review` and `/plan-close` apply too. `plan-suite` requires that package, so
the skill is always available here: load it before the first pass.

## Running the Validator

Where the execution environment can launch a subagent, run each pass as a fresh subagent in the
target worktree, on the session's own model; never pass `isolation: "worktree"`. Give it only:

- the plan's path in the worktree;
- the base branch, so it reads the full diff with `git diff <base>...HEAD`;
- the gate evidence: the repository's CI result for the branch's head commit, from its forge when
  available; otherwise the affected checks' commands and output. Do not run the full local gate to
  produce it;
- the paired skills this run loaded;
- the instruction to load `implementation-review` and report in its format, with the plan's
  acceptance criteria and `## Documentation impact` as the requirements.

Do not give it a summary of what was built, why, or where to look. Without a subagent interface, run
the pass in this session as a separate read-only step that rereads the plan and the full diff from
disk, and record in the plan that the Validator ran in-session.

## Steps

1. **Validator pass.** The Validator applies the `implementation-review` rubric to the current work
   and reports.
2. **Record.** Add each `blocking` or `actionable` finding classed `fix` or `escalate` as an
   unchecked checkbox under `## Review` → `### Findings` in the plan, saved with
   `roborepo plans save`, and each `base` result under `### Verification`. A `note` is shown in the
   pass's report and not recorded. `Outside this scope` items stay out of the plan and go to the
   user in the final report.
3. **Fix.** Fix every `fix` finding, rerun the checks it affects, commit, and check the finding off
   with its commit: `- [x] Missing retry test — fixed (<short commit>)`. Never ask the user whether
   to fix a `fix` finding, however many passes have run. An `escalate` finding stays unchecked and
   gets an Open Questions entry under the Decision Policy.
4. **Repeat.** The next pass validates the revised work, not the previous report. A fix can
   introduce a new finding, which the next pass catches.
5. **Stop** when a pass reports no `blocking` or `actionable` `fix` findings. Open `escalate`
   findings do not restart the loop; they wait for the user's answers.
6. **Cap at eight passes.** The cap limits how many passes run, not how findings are handled: the
   eighth pass's findings are recorded and fixed like any other pass's. The loop then ends without
   another pass and the run continues to Implementation Completion. Record under `### Verification`
   that the last pass's fixes were not revalidated, and name them in the final report; `/plan-review`
   runs its own Validator over them.

Show each pass's report in the run's output, a clean pass included.

## The record

```md
## Review

### Findings
- [x] Missing retry test for the timeout path — fixed (a1b2c3d)
- [ ] Retry limit: configurable or fixed? — escalated, see Open Questions

### Verification
- Validation: clean on pass 3 at d4e5f6a (fresh-context subagent)
- Base failure: `plan-suite-findings-check.mjs` fails on `main` too (unknown plan namespace)
```

Unchecked findings are open tasks, so the completion preflight refuses to submit while any remain.
Record evidence itself, never a path under `/tmp` or another temporary folder: the OS deletes those within days and the plan outlives them.
`/plan-review` adds to this same record, and only `/plan-review` writes `### Approval`.
