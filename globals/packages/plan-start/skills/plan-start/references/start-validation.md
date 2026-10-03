# Start Validation

The start transition records which linked worktree implements a plan, commits that fact to the
canonical plan on the base branch, and proves the result from fresh state before implementation
moves into the worktree. Home joins plans to Runtime checkouts by this field, so a plan that names
the wrong worktree, or names it only in an uncommitted file, attaches to nothing or to the wrong
row.

This transition is the one lifecycle change `plan-start` performs.

## Terms

| Term | Meaning |
| --- | --- |
| Primary checkout | First `worktree` entry of `git worktree list --porcelain`. Holds the canonical plan. |
| Base branch | The branch implementation starts from: `main` unless repository policy names another. |
| Target worktree | The linked worktree created or reused for this plan. |
| Worktree name | `basename` of `git -C <target> rev-parse --absolute-git-dir`, i.e. Git's administrative name under `.git/worktrees/`. Not the checkout directory's basename and not the branch. |
| Transition commit | The plan-only commit on the base branch that records `worktree` and, when needed, the move to `active/`. |

## Transition order

Run every step from the primary checkout. Do not change the shell or session working directory into
the target worktree until step 7 approves.

1. Resolve the primary checkout, base branch, and target worktree (create or reuse it per Preflight).
2. Confirm the primary checkout is on the base branch and `git status --porcelain` is empty. If it is
   on another branch or has any change, stop and ask the user; a checkout with someone else's edits
   is not eligible for an automated commit.

   Exception — first run in a repository: Preflight asks the user to confirm `worktreeRoot` and
   writes it to `docs/plans/plans-config.json`. When that file, with only that key added, is the
   sole change, stage it by name and commit it alone on the base branch as a configuration-only
   commit (do not push), then repeat this check. Never fold it into the transition commit; check 4
   below requires that commit to touch only the plan.
3. Resolve the worktree name from the target. A main checkout has none and cannot be associated;
   stop if the target is not a linked worktree.
4. Write `worktree: <name>` into the canonical plan's frontmatter. If the plan is in `backlog/`, move
   it to `active/` with `git mv` as SKILL.md's Start Transition describes; if it is already in
   `active/`, edit it in place. If the file already carries exactly this value in `active/` at the base
   branch's `HEAD`, there is nothing to commit; skip to step 6.
5. Re-run `git status --porcelain`, stage only the old and new plan paths by name, and commit on the
   base branch with a message naming the plan and worktree. Never use `git add -A` or `.`. Do not
   push.
6. When the target worktree was created in this run and has no commits of its own, fast-forward its
   branch to the transition commit (`git -C <target> merge --ff-only <base>`) so the branch carries
   the canonical plan state. Leave a reused worktree's branch alone and record that its copy of the
   plan predates the transition.
7. Run the validator below against fresh disk and Git state. Enter the target worktree only on
   `APPROVED`.

## Validator

Read every fact fresh in the validation pass. Values remembered from the transition steps do not
count; another session may have moved the checkout in between.

Approve only when all checks pass:

| # | Check | Evidence |
| --- | --- | --- |
| 1 | The canonical plan is in `active/`. | `git -C <primary> ls-files docs/plans/active/<file>` prints the path. |
| 2 | `worktree` is nonempty and equals the target's worktree name. | The frontmatter value from `git -C <primary> show <base>:docs/plans/active/<file>` matches `basename $(git -C <target> rev-parse --absolute-git-dir)`. |
| 3 | The transition is committed on the base branch. | Check 2 reads the committed blob, not the working file; the working file is identical to it (`git diff --quiet <base> -- <path>`). |
| 4 | The transition commit touches only the plan. | When step 5 committed, `git show --name-status --format= <commit>` lists only the plan's rename (`R`) or modification (`M`). Its diff changes only frontmatter when no move occurred. |
| 5 | No plan-transition diff remains in the primary checkout. | `git -C <primary> status --porcelain -- docs/plans` is empty. |
| 6 | Execution is still in the primary checkout. | The current working directory resolves to the primary checkout, not the target. |

Return either `APPROVED` or a list of corrections, one per failed check, each naming the check
number, the observed value, and the exact action that fixes it. Do not approve with a note.

## Correction passes

Apply the returned corrections from the primary checkout, then validate again. Allow at most three
correction passes after the first validation. If the validator still refuses:

- do not enter the target worktree;
- leave any committed transition in place — it is plan-only and reversible with `git revert`;
- report the failing checks and their evidence as a blocker in the final report.

A refusal stops implementation of this plan only; it does not authorize resetting the base branch,
force-moving files, or editing other plans to make a check pass.

## After approval

Switch execution into the target worktree and continue with the Implementation Workflow. Plan
status updates still go to the primary checkout's canonical copy, as Preflight requires. Later
updates are ordinary plan edits, not part of this transition.
