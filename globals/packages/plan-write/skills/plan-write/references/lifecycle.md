# Lifecycle

`backlog`: proposed, planned, blocked, or waiting. Readiness and blockers are separate from lifecycle.

`active`: selected and underway. Must have remaining actionable work, next action, current implementation context, success criteria, and blockers when present.

`completed`: success criteria met. Must not have unresolved required tasks, open required decisions, blockers, or a next action. Include verification evidence or explain what could not be verified.

`archived`: abandoned, replaced, merged into another plan, obsolete, or retained as history. Archived does not mean completed.

Derived conditions:

- readiness: `draft` or `ready`, computed from structure and metadata.
- blocking: blocked when `blocked_by` is non-empty.
- review state: `never-reviewed`, `current`, `possibly-stale`, or `unknown` from `reviewed_commit` and Git state.
- completion consistency: completed plans warn on unchecked tasks, blockers, unresolved decisions, next action, or unsatisfied success criteria.
