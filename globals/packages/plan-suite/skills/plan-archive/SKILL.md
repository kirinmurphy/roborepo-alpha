---
name: plan-archive
description: Use to retire one repository plan that will not be completed because it was superseded or abandoned. Accepts a plan in backlog, ready, active, or review. Records the reason in the plan and commits the move to the store's archived/ folder without removing any worktree or branch that holds unmerged work. Trigger on explicit /plan-archive or requests to archive this plan or retire this plan. Do not use for closing finished work (plan-close), cleaning up worktrees, deleting branches, or revising a plan (plan-write).
---

# Plan Archive

Retire one plan that will not be completed, and keep a readable record of why.

Archived means not completed. A plan whose work landed belongs to `/plan-close`, never here; archiving
finished work to avoid the completion checks hides it from the reader who trusts the archive.

## Inputs

Resolve:

- the repository root and the base branch (`main` unless repository policy names another);
- the selected plan, by id or store-relative path, and its folder: `backlog/`, `ready/`, `active/`,
  or `review/`. Refuse any other folder, naming it;
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

Run `roborepo plans archive <plan> --reason <text> --json`. Do not compose the Git commands yourself. The command:

- writes the reason under a `## Archived` heading in the plan body, dated, and clears `next_action`;
  it adds no frontmatter;
- removes the plan's id from `depends_on` and `blocked_by` in every unfinished plan. It does not
  rewire chains: archiving B in A -> B -> C leaves
  C with no link to A;
- commits only the plan's old and new paths and those cleared plans to the plans branch, and pushes.

### 3. Handle a refusal

- **Another clone changed this plan, or a pending local commit conflicts:** read the plan again and
  rerun, or for a pending commit show the user both versions; see "Plan store" in `/plan-write`'s
  `references/plan-schema.md`.
- **The plan's own path, or a plan that depends on it, has uncommitted changes in the plans
  worktree:** someone wrote there directly; ask the user how to handle them.
- Never force the move or reset a branch.

### 4. Leave the work in place

Archiving never removes a worktree or a branch. If the user explicitly asks to remove one that holds
unmerged work, confirm that the commits will be lost, and use the repository's canonical worktree
cleanup command so its guards still apply. Never remove one by hand.

## Final Report

Name the plan by its H1 title, with its id in parentheses on first mention only. Lead with one
line naming the plan and the outcome, then give the next step and its command when there is one.

Include a status detail only when it departs from the expected result or requires action. Show
behavioral evidence through `feature-verification` where it applies and let the evidence speak
for itself. Omit passing gates, commit ids, and Git status unless they explain an exception or
enable the next step. Link to the plan document for the full record.

Give the archive reason and identify any worktree or branch holding unmerged work. Name affected
dependencies when the reader needs to act. For a refusal, give every reason and the action that
resolves it.

## Boundaries

Do not:

- archive a plan whose work has landed;
- remove, reset, or delete a worktree or branch without the user's explicit authorization;
- add archive fields to the frontmatter;
- merge a code branch;
- archive more than the one named plan.
