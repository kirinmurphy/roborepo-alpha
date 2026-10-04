---
name: plan-promote
description: Use when reviewing and preparing an existing repository implementation plan before development begins. Inspect the current repository, reconcile stale assumptions, improve the existing plan in place, fix obvious issues, identify genuine tradeoffs, ask the user only about material decisions, validate readiness, and stop before implementation. Do not use for creating a new plan from scratch, writing feature code, creating worktrees, changing lifecycle state, or resuming active implementation.
---

# Plan Promote

Promote one existing implementation plan for development.

The goal is to leave the plan accurate, actionable, repository-grounded, and ready for an implementation decision without beginning feature work.

## Inputs

Resolve:

- the repository root;
- the selected plan document;
- repository instructions;
- relevant installed skills;
- current code, tests, configuration, documentation, and Git state.

Use the existing plan document as the source of truth. Do not create a second meta-plan unless the scope genuinely requires splitting and the user explicitly approves that split.

## Paired Skills

Load these as part of the review; do not wait to be asked for them by name.

| Skill | Load when | Contributes |
| --- | --- | --- |
| `technical-writing` | **Always**: promotion rewrites plan prose | Section content, representation, and reader clarity |
| `code-style` | The plan specifies where code goes: module boundaries, orchestration vs. execution, reuse | Ownership and layering constraints |
| `javascript-typescript` | The plan touches JS/TS — ESM, exports, types, framework-less DOM | Language and markup conventions |
| `test-harness` | The plan proposes tests, verification commands, or a regression strategy | Test selection and observable-behavior assertions |

Each row is its own optional package, so check it before loading it:

1. Run `roborepo package status <skill> --json`.
2. If `available` is true, `enabled` is true, and `status` is `enabled` or `configured`, load it.
3. If it is disabled, ask: "`<skill>` is not enabled. Enable it, or skip it for this run?"
   - **Enable:** run `roborepo package enable <skill>` with the user's permission, then load it.
   - **Skip:** continue without it, and name it as skipped in the final report.
4. If `enabled` and `status` disagree (`partial`, `external`), report the status, offer
   `roborepo package reconcile` or skip, and never describe a drifted package as loaded.
5. If it is `missing` or `unavailable`, skip it and say so in the final report.

## Workflow

1. Read the entire selected plan.
2. Inspect all repository areas materially referenced by the plan.
3. Verify current-state claims against code, tests, configuration, documentation, and Git state.
4. Identify:
   - stale assumptions;
   - missing code touchpoints;
   - incomplete requirements;
   - unclear acceptance criteria;
   - blockers;
   - dependencies;
   - overlapping plans;
   - unresolved implementation decisions.
5. Fix issues automatically when the correction is obvious, low-risk, and does not require choosing between meaningful alternatives.
6. When a real tradeoff exists:
   - identify realistic options;
   - explain their consequences;
   - recommend the strongest option;
   - ask the user for a decision.
7. Update the existing plan in place.
8. Preserve the plan ID, filename conventions, frontmatter conventions, lifecycle folder, and repository-relative paths.
9. Convert vague implementation phases into an executable sequence without prescribing incidental details that can safely be decided during development.
10. Ensure validation and acceptance criteria are concrete and testable.
11. Validate the finished document: run `roborepo plans validate <plan>` and resolve its findings,
    then confirm the repository consistency checks no command makes — referenced paths, commands,
    and tests exist, and current-state claims match the code.
12. Present the resulting plan and any remaining questions to the user.
13. Stop before implementation.

## Decision Policy

Apply an edit without asking when:

- the intended correction is unambiguous;
- it fixes stale or factually incorrect repository information;
- it improves clarity without changing scope;
- it aligns the document with an established repository convention;
- it adds a clearly missing code or test touchpoint;
- it is inexpensive to reverse.

Ask the user when:

- multiple credible approaches have meaningful tradeoffs;
- the decision changes product behavior or scope;
- it changes a public API or persistent schema;
- it affects security, privacy, permissions, migration, or compatibility;
- the plan's objectives conflict;
- no responsible option has a clear advantage.

Do not ask for approval for every edit.

## Required Plan Quality

The promoted plan should:

- explain why the work exists;
- distinguish current behavior from proposed behavior;
- identify all relevant existing code touchpoints;
- describe the intended architecture and ownership boundaries;
- include a practical implementation sequence;
- include tests and verification;
- identify risks and unresolved decisions;
- avoid machine-specific absolute paths;
- avoid duplicating existing plans or skills;
- remain understandable to a developer without access to the original conversation.

## Completion Result

Finish with:

```text
Promotion result
- Plan: <id and repository-relative path>
- Repository claims checked: yes/no
- Plan updated: yes/no
- Obvious issues fixed: <count>
- Material decisions resolved: <count>
- Open questions: <count>
- Blockers: <count>
- Promoted for implementation: yes/no
```

Also report:

- files changed;
- repository areas reviewed;
- validation performed, including `roborepo plans validate` output;
- paired skills loaded, and any skipped with the reason;
- any claims that could not be verified.

## Boundaries

Do not:

- implement feature code;
- create a feature branch or worktree;
- change plan lifecycle;
- launch another agent workflow;
- push, merge, or publish;
- claim the plan is ready when material questions remain unresolved.
