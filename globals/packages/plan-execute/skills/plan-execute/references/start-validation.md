# Start Validation

The start transition records which linked worktree implements a plan, commits that fact to the
primary checkout's copy of the plan on the base branch, and proves the result from fresh state before
implementation moves into the worktree. A plan/worktree integration joins plans to linked worktrees by
this field, so a plan that names the wrong worktree, or names it only in an uncommitted file,
attaches to nothing or to the wrong row.

The start transition is one of the lifecycle transitions the repository's shared transition
operation commits; `/plan-execute` runs it, and the submit transition when implementation is
complete. The transition command owns their rules; this skill owns the judgment around them.

## Terms

| Term | Meaning |
| --- | --- |
| Primary checkout | First `worktree` entry of `git worktree list --porcelain`. Holds the plan's primary copy, where lifecycle transitions are committed. |
| Base branch | The branch implementation starts from: `main` unless repository policy names another (`--base`). |
| Target worktree | The linked worktree created or reused for this plan. |
| Worktree name | `basename` of `git -C <target> rev-parse --absolute-git-dir`, i.e. Git's administrative name under `.git/worktrees/`. Not the checkout directory's basename and not the branch. |
| Transition commit | The plan-only commit on the base branch that records `worktree` and the move to `active/`. |

## What stays with the skill

- Confirming `worktreeRoot` on a repository's first run, and committing `plans-config.json` alone as
  a configuration-only commit before the transition. Never fold it into the transition commit; the
  validator requires that commit to touch only the plan.
- Deciding whether an existing worktree is safe to reuse.
- Resolving the worktree name to pass.
- Acting on a refusal, and everything after approval.

## The command

Run from the primary checkout, never from the target worktree:

```text
<plan-transition-command> start <plan-id-or-path> --worktree <name> [--base <branch>] --json
```

It refuses before changing anything when:

- the current directory is not the primary checkout;
- the primary checkout is not on the base branch, or the plan's own path has uncommitted changes —
  an edit to the plan someone else is making is not eligible for an automated commit, so stop and
  ask the user. Unrelated staged or unstaged work elsewhere does not block the transition and stays
  where it is;
- no linked worktree has that administrative name;
- the plan is not in `ready/` (or `active/`, to record a replacement worktree); a `backlog/` plan is
  refused with a pointer to `/plan-promote`;
- the plan does not meet the `active/` requirements.

Otherwise it:

1. writes `worktree: <name>` into the plan's frontmatter;
2. moves a `ready/` plan to `active/` with `git mv`, keeping its filename and `id`; an `active/`
   plan is edited in place;
3. commits only the old and new plan paths on the base branch (`git commit --only`); when the base
   branch already carries exactly this value, it commits nothing and reports `alreadyRecorded: true`;
4. fast-forwards the target branch to the transition commit when the branch has no commits of its
   own and no uncommitted edits; a reused branch with its own work is left alone and the result says
   its copy of the plan predates the transition;
5. lists under `staleLinks` the files that still name the plan's old path, without editing them;
6. runs the validator below and prints `APPROVED` or the failed checks.

It never pushes. Do not push from the skill either.

## Validator

The command reads every fact fresh in the validation pass; values remembered from the transition do
not count, because another session may have moved the checkout in between.

| # | Check | Evidence |
| --- | --- | --- |
| 1 | The primary copy of the plan is in `active/`. | `git ls-files docs/plans/active/<file>` prints the path, and the old path is no longer tracked. |
| 2 | `id` and `worktree` are recorded, and `worktree` equals the target's worktree name. | The frontmatter from `git show <base>:docs/plans/active/<file>` matches `basename $(git -C <target> rev-parse --absolute-git-dir)`. |
| 3 | The transition is committed on the base branch. | The working file is identical to the committed blob (`git diff --quiet <base> -- <path>`). |
| 4 | The transition commit touches only the plan. | `git show --name-status --format= <commit>` lists only the plan's rename (`R`) or modification (`M`), and the document body is unchanged. |
| 5 | No plan-transition diff remains in the primary checkout. | `git status --porcelain -- <old path> <new path>` is empty. |
| 6 | Execution is still in the primary checkout. | The current directory resolves to the primary checkout, not the target. |

Each failed check carries its number, the observed value, and a `fix`. The verdict is `APPROVED`
only when all six pass; there is no approval with a note. Every other lifecycle transition runs the
same six checks, without the worktree comparison in check 2.

## Correction passes

Apply each failed check's `fix` from the primary checkout, then run the command again. Allow at most
three correction passes after the first run. If it still refuses:

- do not enter the target worktree;
- leave any committed transition in place — it is plan-only and reversible with `git revert`;
- report the failing checks and their evidence as a blocker in the final report.

A refusal stops implementation of this plan only; it does not authorize resetting the base branch,
force-moving files, or editing other plans to make a check pass.

## After approval

Switch execution into the target worktree, as SKILL.md's Enter the Worktree describes, and continue
with the Implementation Workflow. Fix any
`staleLinks` there, as part of the feature branch: the base branch takes no commit but the
transitions. From approval on, the worktree's copy is the authoritative plan: every later plan
update is an ordinary edit there, never a copy to the primary checkout.
