## Code Outlives Plans

Code must make sense without any plan document. In comments, test names, and error messages, never
cite a plan file, plan id, phase, milestone, or plan decision — no "see plans/…", "Phase 4",
or "per the plan". Plans are renamed, rescoped, and closed; the citation goes stale while the code
stays.

When a comment needs a reason, write the reason itself. Track progress in the plan, not in code.

A path the code actually reads, writes, or serves is behavior, not a citation, and stays.

## Plan Records Stay Plan-Specific

A line belongs in a plan's `## Review` record (`### Findings`, `### Verification`) or Decision Log
only when it concerns this plan's requirements, its implementation, or evidence needed to approve it.

Report a general lifecycle, tooling, or environment issue to the user in the conversation, and
propose it as separate work when it is worth doing. It stays out of the plan record, even when it
interrupted this plan's work. Examples: a defect in shared transition code this plan did not
introduce, or an unrelated untracked file that made a lifecycle command refuse.

Two cases stay in the plan. A gate failure the base branch has too is approval evidence, so it keeps
its `### Verification` line. An issue that leaves this plan blocked gets an `## Open Questions` entry
naming what it stops.

## Plans Change Through the CLI

Plan files live under `plans/` on the `repo-plans` branch, in a reserved worktree. Change them only
with named `roborepo plans` commands: read with `plans show`, edit a copy in a temporary folder (see Temporary Files),
and write with `plans save`. Never edit that worktree directly or run Git in it, and never add plan
files to a code branch.

## Session Titles Name the Stage

A session's title names its workflow stage, so a person running many sessions can tell them apart.
The title is a stage prefix, a space, and a description, at most 59 characters in all; cut a longer
description at a word boundary and end it with `…`. Never put a plan id in a title.

| Session | Title |
| --- | --- |
| Running a plan command | `/plan-write:`, `/plan-promote:`, `/plan-execute:`, `/plan-review:`, `/plan-close:`, or `/plan-archive:`, then the plan's H1 title |
| Started by a plan session for part of its work | `/plan sub-task:`, then the task |
| Work with no plan | `Quick Change:`, then a short description of the change |

- When a plan command starts and you have a tool that renames your own session, set the stage title
  with it. A prompt's `Session title:` line, when it has one, gives the title to use.
- When you start another session for part of a plan's work, pass `/plan sub-task: <task>` as its
  title if the launch accepts one.
- On the first file edit in a session that is not working a plan, set `Quick Change: <description>`
  if you have a tool that renames your own session.
- If you have no such tool: in Claude Code do nothing more, because a hook sets the stage title when
  a prompt starts the stage. In Codex, print one line the person can paste, `/rename <title>`, once
  each time a plan command starts, and continue without waiting. Print no rename line for
  `Quick Change:`, and none in any other harness.
- Leave a title the person wrote that carries no stage prefix as it is.
