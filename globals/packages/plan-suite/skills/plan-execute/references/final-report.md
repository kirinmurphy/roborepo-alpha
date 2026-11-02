# Final Report

The reader is reviewing outcomes, not auditing the run. Lead with where the plan stands, show what
changed for the person using the work, and spend detail only on what is wrong or what they must do.
The plan document already holds the Decision Log, every Validation Loop finding, and the
`## Not tested` entries; the report points there instead of repeating them.

## Contents

- Shape
- Headline
- Tables
- Exceptions
- Record
- What to leave out

## Shape

In this order, skipping any section that would be empty:

1. Headline
2. What changed (table)
3. Decisions worth knowing (table)
4. Exceptions (only when something did not pass)
5. Needs you (table)
6. Record

Separate sections with a `━` rule. Each table cell stays a few words to one short sentence.

## Headline

One bold line on its own, before anything else, naming the plan and its lifecycle outcome:

```text
**Submitted for review: "<title>" (<id>)**
**Still active: "<title>" (<id>), <n> objectives blocked**
**Stopped at the validation cap: "<title>" (<id>), <n> findings open**
**Review findings fixed: "<title>" (<id>), ready for /plan-review again**
```

Follow it with at most one plain sentence when the reader needs context the tables cannot give,
such as "Main is red until this merges." No commit ids, pass counts, or check names here.

## Tables

### What changed

What the user, a developer, or an agent will notice, not how it was built. One row per
user-visible change; fold related internals into the row they serve.

| Change | What you'll notice |
| --- | --- |
| Pre-push check | `git push` refuses broken doc links and whitespace errors in about 4 s |

### Decisions worth knowing

Only decisions that changed scope, departed from the plan's wording, traded one behavior for
another, or that the reviewer might reverse. Routine choices stay in the Decision Log.

| Decision | Why | Instead of |
| --- | --- | --- |
| plan-review never pushes | Keeps the skill's no-push rule | Pushing after each fix, as the plan said |

### Needs you

Everything the reader must do or decide, in the order they should do it, each row complete enough
to act on without scrolling back: what to do, why it matters, and the exact command when there is
one. Unconfirmed `## Not tested` entries appear here as manual checks. Open Questions appear here
too, each with its options and recommendation; this is the run's only question batch. The last row
is the next command: `/plan-execute` again to resume, or `/plan-review`.

| Do | Why | How |
| --- | --- | --- |
| Push the branch | The automatic push was refused; CI has not run | `git push -u origin <branch>` |
| Run `/plan-review` | Next lifecycle step | `/plan-review` |

Include the push row only when the feature-branch push failed or was skipped; say whether the
session's permissions, a hook, or the remote refused it.

## Exceptions

Report only what did not pass. A clean run says nothing here: reaching `review/` already means the
Validation Loop ended clean and the completion preflight passed.

| Check | Result | What it means |
| --- | --- | --- |
| Docs link check | ✗ fails on base too | Main is red until this merges |

Include, when they apply:

- failed, skipped, or not-run checks, with the exact command not run and why;
- a Validation Loop that stopped at the cap, with its open findings;
- checks that fail on the base branch as well;
- blocked objectives and what blocks them;
- paired skills skipped or unavailable, with the reason;
- a missing feature-verification pairing for UI, server, API, CLI, or performance work, and why;
- behavioral evidence the user should see (a screenshot, output, a recording), inline.

A ✓ belongs here only when it settles a doubt the reader would otherwise have, such as a fixed
flake that now passes repeatedly.

## Record

A short closing block for lookup, with only facts the prose did not already state:

```text
Implementation result
- Plan: "<title>" (<id>), <repository-relative path>
- Lifecycle: stays active | moved to review | stays review
- Branch: <branch> (worktree <runtime path>)
- Pushed: <branch> to <remote> | not pushed (<why>)
- Details: Decision Log, findings, and Not tested entries are in the plan document
```

Add a line only for a non-default fact: a shareable link, a server left running, docs that needed
no update and why, or uncommitted work left in the worktree.

## What to leave out

Unless it is the point of an exception:

- commit ids, including start, implementation, fix, and submit commits;
- counts of objectives, decisions, validation passes, or findings fixed;
- a passing gate, a clean validation pass, or a passing preflight;
- the Decision Log, validation pass reports, files changed, Git status, and validator output;
- anything already said earlier in the report.

The reader asks for any of these when they want depth; offer it in one line at the end.
