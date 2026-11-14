# Final Report

Before writing the report, read `/plan-write`'s `references/completion-report.md`. It owns the shape
every plan command shares (headline, what the plan is for, what changed, needs you, record), the
rule against unintroduced terms, the visual-evidence rule, the cold-reader check, and what to leave
out. This command runs the checker agent before delivering. This file adds only what is specific
to `/plan-execute`.

The plan document already holds the Decision Log, every Validation Loop finding, and the
`## Not tested` entries; the report points there instead of repeating them.

## Contents

- Shape
- Headline
- Decisions worth knowing
- Exceptions
- Needs you
- Record

## Shape

The shared shape, with two sections of this command's own after What changed:

1. Headline
2. What this plan is for
3. What changed
4. Decisions worth knowing
5. Exceptions (only when something did not pass)
6. Needs you
7. Record

Each table cell stays a few words to one short sentence.

## Headline

Name the plan's lifecycle outcome:

```text
**Submitted for review: "<title>" (<id>)**
**Still active: "<title>" (<id>), <n> objectives blocked**
**Review findings fixed: "<title>" (<id>), ready for /plan-review again**
```

What changed uses the shared table form, one row per change a person would notice:

| Change | What you'll notice |
| --- | --- |
| Pre-push check | `git push` refuses broken doc links and whitespace errors in about 4 s |

## Decisions worth knowing

Only decisions that changed scope, departed from the plan's wording, traded one behavior for
another, or that the reviewer might reverse. Routine choices stay in the Decision Log. Describe each
in plain words; the reader has not seen the plan's wording.

| Decision | Why | Instead of |
| --- | --- | --- |
| plan-review never pushes | Keeps the skill's no-push rule | Pushing after each fix, as the plan said |

## Exceptions

Report only what did not pass. A clean run says nothing here: reaching `review/` without a cap entry
below means the Validation Loop ended clean and the completion preflight passed.

| Check | Result | What it means |
| --- | --- | --- |
| Docs link check | ✗ fails on base too | Main is red until this merges |

Include, when they apply:

- failed, skipped, or not-run checks, with the exact command not run and why;
- a Validation Loop that reached the cap, with the last pass's fixes, which were not revalidated;
- checks that fail on the base branch as well;
- issues outside this plan, from the Validator or the run, each proposed as separate work when it
  is worth doing;
- blocked objectives and what blocks them;
- paired skills skipped or unavailable, with the reason;
- a missing feature-verification pairing for UI, server, API, CLI, or performance work, and why.

A ✓ belongs here only when it settles a doubt the reader would otherwise have, such as a fixed
flake that now passes repeatedly.

## Needs you

Unconfirmed `## Not tested` entries appear here as manual checks. Open Questions appear here too,
each with its options, what each leads to, and a recommendation; this is the run's only question
batch. The last row is the next command: `/plan-execute` again to resume, or `/plan-review`.

| Do | Why | How |
| --- | --- | --- |
| Push the branch | The automatic push was refused; CI has not run | `git push -u origin <branch>` |
| Run `/plan-review` | A person reviews and approves the work | `/plan-review` |

Include the push row only when the feature-branch push failed or was skipped; say whether the
session's permissions, a hook, or the remote refused it.

## Record

The shared Record block, with this command's lines:

```text
Implementation result
- Plan: "<title>" (<id>), <store-relative path>
- Lifecycle: stays active | moved to review | stays review
- Branch: <branch> (worktree <runtime path>)
- Pushed: <branch> to <remote> | not pushed (<why>)
- Details: Decision Log, findings, and Not tested entries are in the plan document
```

Add a line only for a non-default fact: a shareable link, a server left running, docs that needed
no update and why, or uncommitted work left in the worktree.
