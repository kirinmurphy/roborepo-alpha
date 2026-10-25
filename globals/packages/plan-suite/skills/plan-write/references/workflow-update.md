# Update Workflow

For sync-only evidence updates, check the changed claims against the repository and run the
canonical plan validator as described in `workflow-validate.md`. Reuse checks already run on the
same content. Do not load prose-authoring references or run a technical-writing loop for findings,
test results, decisions, or checklist updates alone. Substantive scope, design, or prose revisions
also use `writing-guidelines.md` and technical-writing validation; an enclosing independent review
may cover both rubrics in one pass. Authority, lifecycle, and approval boundaries always apply.

1. Inspect changes from the current session or requested scope.
2. Compare the plan with actual implementation.
3. Mark completed tasks only when evidence supports them.
4. Remove or rewrite obsolete tasks only when supported by evidence; a scope or design change
   belongs to substantive revision and the owning lifecycle workflow.
5. Add newly discovered required work.
6. Update `next_action`.
7. Update blockers and dependencies.
8. Leave the plan in its folder. Moving it is the job of the command that owns that transition;
   `/plan-execute` moves an active plan to review only when its completion preflight passes.
9. Update `reviewed_commit` only after deliberate review against repository state.
10. Summarize plan changes.
