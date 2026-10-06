---
name: plan-promote
description: Use when reviewing and preparing an existing repository implementation plan before development begins. Inspect the current repository, reconcile stale assumptions and overlapping or active stories, improve the existing plan in place, fix obvious issues, identify genuine tradeoffs, ask the user only about material decisions, validate readiness, and stop before implementation. Do not use for creating a new plan from scratch, writing feature code, creating worktrees, changing lifecycle state, or resuming active implementation.
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
5. Reconcile every materially related plan before editing the selected plan:
   - enumerate plans referenced by `depends_on`, `related`, and `[[plan-id]]` links, plus plans in
     the same namespace or touching the same code paths;
   - read each relevant plan's full body and frontmatter, including `reviewed_commit`, `worktree`,
     `next_action`, checked tasks, acceptance criteria, and decision log;
   - determine whether the related implementation is landed in the current checkout by checking
     Git ancestry and branches (for example `git merge-base --is-ancestor <commit> HEAD` and
     `git branch --contains <commit>`), then confirm the claimed behavior in current code and tests;
   - classify each relationship as **unlanded dependency**, **landed dependency**, **stale active
     story**, **plan-vs-code conflict**, or **plan-vs-plan conflict**;
   - treat current code on the reviewed checkout as the evidence for current behavior. A plan's
     `active` folder, branch name, or next action does not prove that its code is unmerged, and a
     merged commit does not prove that every task or acceptance criterion is complete;
   - when a landed story remains active or contains prose that contradicts the landed code, record
     the lifecycle/prose drift explicitly. Do not treat it as an unlanded dependency, silently
     rewrite the other plan, or change its lifecycle. If the selected plan changes the landed
     contract, add a reconciliation note stating exactly which behavior it supersedes and whether
     the related plan needs separate lifecycle cleanup;
   - do not call the selected plan ready while a material conflict remains unclassified or while
     the selected plan's scope depends on an unresolved decision from another plan.
6. Fix issues automatically when the correction is obvious, low-risk, and does not require choosing between meaningful alternatives.
7. When a real tradeoff exists:
   - identify realistic options;
   - explain their consequences;
   - recommend the strongest option;
   - ask the user for a decision.
8. Update the existing plan in place.
9. Preserve the plan ID, filename conventions, frontmatter conventions, lifecycle folder, and repository-relative paths.
10. Convert vague implementation phases into an executable sequence without prescribing incidental details that can safely be decided during development.
11. Ensure validation and acceptance criteria are concrete and testable.
12. Validate the finished document: run `roborepo plans validate <plan>` and resolve its findings,
    then confirm the repository consistency checks no command makes — referenced paths, commands,
    and tests exist, current-state claims match the code, and related-plan classifications remain
    accurate. The deterministic validator does not replace this semantic reconciliation pass.
13. Present the resulting plan, related-plan classifications, and any remaining questions to the user.
14. Stop before implementation.

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
- a related active story's landed behavior conflicts with the selected plan and the selected plan
  does not clearly supersede that contract;
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
- related plans checked, with each relationship classified as landed, unlanded, stale, or conflicting;
- landed implementation commits verified against the current checkout;
- active-story conflicts and lifecycle/prose drift found, including how the selected plan reconciles them;
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
