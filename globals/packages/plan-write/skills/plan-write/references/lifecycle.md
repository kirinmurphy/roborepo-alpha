# Lifecycle

The lifecycle is declared in `manifests/platform/plan-lifecycle.json`: `backlog → ready → active →
review → completed`, with `archived` as an exit from any of the first four. Each move is committed in
the primary checkout by the command that owns it; `/plan-write` never moves a plan.

`backlog`: proposed, planned, blocked, or waiting. Readiness and blockers are separate from lifecycle.
New plans start here, with their initial checklist.

`ready`: validated and prepared by `/plan-promote`, which commits the move from backlog. Must meet
every structure rule with no findings: next action, design, success criteria, and real blockers.

`active`: selected and underway in a linked worktree, after `/plan-execute` commits the start. Must
have remaining actionable work, next action, current implementation context, success criteria, and
blockers when present.

`review`: implementation complete, awaiting independent QA and human approval. `/plan-execute` or
`/plan-review` commits the move from active once the completion preflight passes; it is not a claim
that QA passed. Fixes within the requirements stay here; a material scope change returns the plan
to active, never to ready.

`completed`: merged and accepted. `/plan-close` commits the move from review after the user's own
merge, once landing and a fresh human approval are verified. Must not have unresolved required
tasks, open required decisions, blockers, or a next action. Include verification evidence or explain
what could not be verified.

`archived`: abandoned, replaced, merged into another plan, obsolete, or retained as history.
`/plan-archive` commits the move and records why. Archived does not mean completed.

Derived conditions:

- readiness: `draft` or `ready`, computed from structure and metadata. Shown as structure, so it is
  never confused with the Ready folder.
- blocking: blocked when `blocked_by` is non-empty.
- plan freshness: `never-reviewed`, `current`, `possibly-stale`, or `unknown` from `reviewed_commit`
  and Git state. It says whether the document was checked against the code, not whether a human
  approved the work.
- completion consistency: completed plans warn on unchecked tasks, blockers, unresolved decisions, next action, or unsatisfied success criteria.
