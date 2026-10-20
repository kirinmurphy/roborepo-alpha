---
name: plan-promote
description: Use when reviewing and preparing an existing repository implementation plan before development begins. Accepts a plan in backlog, or in ready to refine it. Inspect the current repository, reconcile stale assumptions and overlapping or active stories, improve the existing plan in place, fix obvious issues, identify genuine tradeoffs, ask the user only about material decisions, validate readiness, commit the plan's move to ready, and stop before implementation. Do not use for creating a new plan from scratch, writing feature code, creating worktrees, or starting or resuming implementation.
---

# Plan Promote

Promote one existing implementation plan for development.

The goal is to leave the plan accurate, actionable, repository-grounded, and committed to `ready/`
without beginning feature work. A plan already in `ready/` can be promoted again to refine it in
place. A plan in any other folder is refused, naming the folder and the command that fits it:
`/plan-execute` for active or review work, `/plan-write` to revise a plan elsewhere.

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

1. Check the host's skill/package manager for `<skill>` and read its availability and activation state.
2. If `available` is true, `enabled` is true, and `status` is `enabled` or `configured`, load it.
3. If it is disabled, ask: "`<skill>` is not enabled. Enable it, or skip it for this run?"
   - **Enable:** use the host's package manager to enable `<skill>` with the user's permission, then load it.
   - **Skip:** continue without it, and name it as skipped in the final report.
4. If `enabled` and `status` disagree (`partial`, `external`), report the status, offer
   the host's package reconciliation command or skip, and never describe a drifted package as loaded.
5. If it is `missing` or `unavailable`, skip it and say so in the final report.

## Workflow

1. Read the entire selected plan, then run `roborepo plans validate <plan> --json` from the
   repository root before inspecting repository areas or editing the plan. Pass the selected
   plan's repository-relative path; never omit the selector and validate every plan for this step.
   Use the findings as input to preparation. Document findings, including blocking findings, are
   issues to repair during promotion preparation, not a reason to stop that preparation. If the
   command cannot resolve the selected plan or fails to produce validation findings because of an
   execution error, resolve that failure before continuing. A nonzero exit caused by blocking
   findings does not prevent preparation.
2. Inspect all repository areas materially referenced by the plan.
3. Verify current-state claims against code, tests, configuration, documentation, and Git state.
   Check the plan's `## Documentation impact` list against its implementation scope and the
   repository's doc-of-record map, when one exists. Fill an obvious missing doc of record before
   declaring the plan ready. Do not bulk-migrate older plans just for this section.
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
8. Update the existing plan in place, in the primary checkout.
9. Preserve the plan ID, filename conventions, frontmatter conventions, and repository-relative paths.
10. Convert vague implementation phases into an executable sequence without prescribing incidental
    details that can safely be decided during development. `/plan-write` wrote the initial
    checklist; refine it here so `/plan-execute` can work it task by task.
11. Ensure validation and acceptance criteria are concrete and testable.
12. Run `roborepo plans validate <plan> --json` again for the selected plan's current path and
    resolve its findings. The initial validation does not replace this check after edits.
    Then confirm the repository consistency checks no command makes — referenced paths, commands,
    and tests exist, current-state claims match the code, and related-plan classifications remain
    accurate. The deterministic validator does not replace this semantic reconciliation pass.
13. Present the resulting plan, related-plan classifications, and any remaining questions to the user.
14. Promote or hold:
    - **Ready** (no material question remains unresolved): run the repository's canonical promote
      transition command for `<plan>` from the primary checkout. From `backlog/` it moves the plan to
      `ready/` with `git mv` and commits the move together with this run's edits to the plan; in
      `ready/` it commits the refinements in place. Either way the commit contains only the plan's
      old and new paths, and unrelated staged or unstaged work stays where it is. It refuses, with
      the findings and a repair prompt, when the plan does not meet the `ready/` requirements: fix
      them and run it again. It refuses when the primary checkout is not on the base branch; stop and
      ask the user. Do not push.
    - **Not ready** (material questions remain): leave the plan where it is. If this run changed it,
      show the user the changes and ask whether to commit them; on approval, recheck Git state and
      commit only the selected plan path. Do not include pre-existing edits or other files without
      explicit approval.
15. After the promotion report, show the `/plan-execute` instruction for a promoted plan using its
    repository-relative path in `ready/`, ready to paste into a new session.
16. Stop before implementation. Never invoke `/plan-execute` yourself.

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

Name the plan by its H1 title, with its id in parentheses on first mention only. The id is the
stable reference for commands and frontmatter, not a name a person recognizes; the same goes for
questions, review packets, and other prose in this run.

Include this in the promotion report:

```text
Promotion result
- Plan: "<title>" (<id>), <repository-relative path>
- Repository claims checked: yes/no
- Plan updated: yes/no
- Obvious issues fixed: <count>
- Material decisions resolved: <count>
- Open questions: <count>
- Blockers: <count>
- Promoted for implementation: yes/no
- Lifecycle change: backlog -> ready | refined in ready | none
- Promotion commit: <hash> | already recorded | not made (<reason>)
```

Also report:

- files changed;
- repository areas reviewed;
- validation performed, including the plan validator's output;
- related plans checked, with each relationship classified as landed, unlanded, stale, or conflicting;
- landed implementation commits verified against the current checkout;
- active-story conflicts and lifecycle/prose drift found, including how the selected plan reconciles them;
- paired skills loaded, and any skipped with the reason;
- any claims that could not be verified.

After the report of a promoted plan, show this snippet with the actual repository-relative plan path:

````text
Paste this instruction into a new session to start this plan:
```text
/plan-execute <plan document file>
```
````

For a plan held in `backlog/` with changes, ask for commit approval after the report. The approval
request should identify the selected plan and summarize the changes to be committed. After the
user's decision, report whether the plan was committed and include the commit hash when applicable.

## Boundaries

Do not:

- implement feature code;
- create a feature branch or worktree;
- change plan lifecycle, except the move from `backlog/` to `ready/` through the promote transition;
- launch another agent workflow;
- push, merge, or publish;
- claim the plan is ready when material questions remain unresolved.
