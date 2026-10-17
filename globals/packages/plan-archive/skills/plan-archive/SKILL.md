---
name: plan-archive
description: Use to retire one repository plan that will not be completed because it was superseded or abandoned. Accepts a plan in backlog, ready, active, or review. Records the reason in the plan, carries the worktree copy's unmerged plan progress to the base branch once, refuses conflicting copies, and commits the move to docs/plans/archived/ without removing any worktree or branch that holds unmerged work. Trigger on explicit /plan-archive or requests to archive this plan or retire this plan. Do not use for closing finished work (plan-close), cleaning up worktrees, deleting branches, or revising a plan (plan-write).
---

# Plan Archive

Retire one plan that will not be completed, and keep a readable record of why.

Archived means not completed. A plan whose work landed belongs to `/plan-close`, never here; archiving
finished work to avoid the completion checks hides it from the reader who trusts the archive.

## Inputs

Resolve:

- the repository root, the primary checkout (first `worktree` entry of
  `git worktree list --porcelain`), and the base branch (`main` unless repository policy names
  another);
- the selected plan, by id or path, and its folder in the primary checkout: `backlog/`, `ready/`,
  `active/`, or `review/`. Refuse any other folder, naming it;
- the reason: superseded (by which plan) or abandoned (why). Ask the user when the request does not
  state it; never invent one;
- the worktree the plan names, if any, and whether its branch holds commits the base branch does not.

## Paired Skills

Load these when the run calls for them; do not wait to be asked for them by name.

| Skill | Load when | Contributes |
| --- | --- | --- |
| `technical-writing` | The reason needs more than one sentence | Section content and reader clarity |

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

### 1. Confirm archiving is the right exit

- If the plan's work has landed on the base branch, stop and direct the user to `/plan-close`.
- If the plan names a worktree whose branch holds commits the base branch does not have, say so
  plainly: that code is unmerged, and archiving will leave it exactly where it is.

### 2. Archive

Run the repository's canonical archive transition command for `<plan>` from the primary checkout,
passing the reason. Do not compose the Git commands yourself. The command:

- writes the reason under a `## Archived` heading in the plan body, dated, and clears `next_action`;
  it adds no frontmatter;
- applies the copy table below, because abandoned work never merges, so Git never brings the
  worktree's plan copy to the base branch on its own;
- commits only the plan's old and new paths on the base branch, and never pushes.

| Copies | The command does |
| --- | --- |
| The plan names no worktree, or the worktree copy is integrated | Records the reason in the primary copy and moves it |
| Worktree copy not integrated, and the primary copy is a version the worktree branch already had | Writes the worktree copy's content into the primary copy, records the reason, and moves it, as one archive change on the base branch |
| Worktree copy not integrated, and the primary copy holds a version the worktree never had | Refuses with `conflicting copies`, naming both |
| Worktree copy unavailable | Archives the primary copy and reports that the worktree's plan state was not available |

This is the only time plan content is copied between checkouts: once, one way, at the archive
transition. Never merge two edited copies.

### 3. Handle a refusal

- **Conflicting copies:** the user decides. Either merge the base branch into the worktree, or move
  the primary copy's edit into the worktree's copy and revert it in the primary checkout. Then run
  this command again.
- **The plan's own path has uncommitted changes:** someone else is editing it; ask the user how to
  handle them.
- Never force the move, edit the other copy yourself to make the check pass, or reset a branch.

### 4. Leave the work in place

Archiving never removes a worktree or a branch. If the user explicitly asks to remove one that holds
unmerged work, confirm that the commits will be lost, and use the repository's canonical worktree
cleanup command so its guards still apply. Never remove one by hand.

## Final Report

```text
Archive result
- Plan: <id and repository-relative path>
- Reason: superseded by <plan> | abandoned: <why>
- Lifecycle change: <from> -> archived | none
- Worktree copy: no-worktree | integrated | carried | unavailable | conflicting
- Archive commit: <hash> | refused | already recorded
- Unmerged work left in place: <branch and worktree> | none
```

Also report every refusal reason with the action that resolves it, and current Git status.

## Boundaries

Do not:

- archive a plan whose work has landed;
- remove, reset, or delete a worktree or branch without the user's explicit authorization;
- add archive fields to the frontmatter;
- push or merge;
- archive more than the one named plan.
