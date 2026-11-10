# Start Validation

The start transition records which linked worktree implements a plan, commits that fact to the plans
branch, and proves the result from fresh state before implementation moves into the worktree. A
plan/worktree integration joins plans to linked worktrees by this field, so a plan that names the
wrong worktree attaches to nothing or to the wrong row.

The start transition is one of the lifecycle transitions the repository's shared transition
operation commits; `/plan-execute` runs it, and the submit transition when implementation is
complete. The transition command owns their rules; this skill owns the judgment around them.

## Contents

- Terms
- What stays with the skill
- The command
- Validator
- Correction passes
- After approval

## Terms

| Term | Meaning |
| --- | --- |
| Plans worktree | The reserved `repo_plans` worktree on branch `repo-plans`, where plan commits land. Only `roborepo plans` commands write to it. |
| Base branch | The code branch implementation starts from: `main` unless repository policy names another (`--base`). |
| Target worktree | The linked worktree created or reused for this plan. |
| Worktree name | `basename` of `git -C <target> rev-parse --absolute-git-dir`, i.e. Git's administrative name under `.git/worktrees/`. Not the checkout directory's basename and not the branch. |
| Transition commit | The commit on the plans branch that records `worktree` and the move to `active/`. |

## What stays with the skill

- Deciding whether an existing worktree is safe to reuse.
- Resolving the worktree name to pass.
- Acting on a refusal, and everything after approval.

## The command

Run from any checkout of the repository:

```text
roborepo plans start <plan-id-or-path> --worktree <name> [--base <branch>] --json
```

It refuses before changing anything when:

- the repository has no plan store, naming `roborepo plans init`;
- the plan's file has uncommitted edits in the plans worktree;
- no linked worktree has that administrative name, or the name is the reserved `repo_plans`;
- the plan is not in `ready/` (or `active/`, to record a replacement worktree); a `backlog/` plan is
  refused with a pointer to `/plan-promote`;
- the plan does not meet the `active/` requirements.

Otherwise it:

1. writes `worktree: <name>` into the plan's frontmatter;
2. moves a `ready/` plan to `active/`, keeping its filename and `id`; an `active/` plan is edited in
   place;
3. commits only the old and new plan paths to the plans branch and pushes; when the branch already
   carries exactly this value, it commits nothing and reports `alreadyRecorded: true`;
4. lists under `staleLinks` the plan files that still name the plan's old path, without editing them;
5. runs the validator below and prints `APPROVED` or the failed checks.

## Validator

The command reads every fact fresh in the validation pass; values remembered from the transition do
not count, because another session may have moved the store in between.

| # | Check | Evidence |
| --- | --- | --- |
| 1 | The plan is in `active/`. | `git ls-files plans/active/<file>` in the plans worktree prints the path, and the old path is no longer tracked. |
| 2 | `id` and `worktree` are recorded, and `worktree` equals the target's worktree name. | The frontmatter from `git show HEAD:plans/active/<file>` matches `basename $(git -C <target> rev-parse --absolute-git-dir)`. |
| 3 | The transition is committed. | The working file is identical to the committed blob. |
| 4 | The transition commit touches only the plan. | `git show --name-status --no-renames --format= <commit>` lists only the plan's move or modification, and the document body is unchanged. |
| 5 | No plan-transition diff remains. | `git status --porcelain -- <old path> <new path>` is empty in the plans worktree. |
| 6 | The plans worktree is on `repo-plans`. | Its `HEAD` names that branch. |

Each failed check carries its number, the observed value, and a `fix`. The verdict is `APPROVED`
only when all six pass; there is no approval with a note. Every other lifecycle transition runs the
same six checks, without the worktree comparison in check 2.

## Correction passes

Apply each failed check's `fix`, then run the command again. Allow at most
three correction passes after the first run. If it still refuses:

- do not enter the target worktree;
- leave any committed transition in place;
- report the failing checks and their evidence as a blocker in the final report.

A refusal stops implementation of this plan only; it does not authorize resetting a branch,
force-moving files, or editing other plans to make a check pass.

## After approval

Switch execution into the target worktree, as SKILL.md's Enter the Worktree describes, and continue
with the Implementation Workflow. Report any `staleLinks` and fix them with `roborepo plans save`. A
plan stays on the plans branch: every later update goes through `plans save`, never a file on the
feature branch.
