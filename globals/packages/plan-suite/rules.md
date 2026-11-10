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
with named `roborepo plans` commands: read with `plans show`, edit a copy outside the code checkout,
and write with `plans save`. Never edit that worktree directly or run Git in it, and never add plan
files to a code branch.
