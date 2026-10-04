---
name: plan-write
description: Use when creating a repository plan document under docs/plans, or revising or syncing an existing one — revising follows the user's intent to change scope or design; syncing follows repository evidence to tick finished tasks and refresh next_action and reviewed_commit. Trigger on explicit /plan-write or requests to create a durable implementation plan, revise a plan, sync this plan, or update a plan after work. Do not use for preparing a plan for development (plan-promote), implementing a plan (plan-start), closing a finished plan (plan-close), ending a session (session-close), brief answers, PR descriptions, ordinary implementation without plan-document management, or casual checklists.
---

# Plan Write

Use this skill to write managed repository plans stored as Markdown under `docs/plans`: create a new
one, or update an existing one.

This skill owns plan content, frontmatter, and the required-section schema for plan documents.
Lifecycle moves belong to other suite commands: `/plan-start` moves a plan into `active/`, and
`/plan-close` moves it to `completed/` or `archived/`. Prose quality and implementation correctness
come from the paired skills below.

## Paired Skills

**Load these as part of the work; do not wait to be asked for them by name.** Their rules constrain
the plan's content, not just its wording, and they join the validation scope — the
`technical-writing` Validator checks the plan against every paired skill that was loaded.

| Skill | Load when | Contributes |
| --- | --- | --- |
| `technical-writing` | **Always** | Section ordering, representation, anti-patterns, reader clarity, and the Creator/Validator loop. Knows nothing about lifecycle or frontmatter, so it never overrides a rule from this skill |
| `code-style` | The plan specifies where code goes: module boundaries, orchestration vs. execution, reuse | Ownership and layering constraints |
| `javascript-typescript` | The plan touches JS/TS — ESM, exports, types, framework-less DOM | Language and markup conventions the plan must not contradict |
| `test-harness` | The plan proposes tests, verification commands, or a regression strategy | Test selection and observable-behavior assertions |

Conditional triggers are subject matter, never plan size: a one-phase plan that specifies module
placement still needs `code-style`.

Each row is its own optional package, so check it before loading it:

1. Run `roborepo package status <skill> --json`.
2. If `available` is true, `enabled` is true, and `status` is `enabled` or `configured`, load it.
3. If it is disabled, ask: "`<skill>` is not enabled. Enable it, or skip it for this run?"
   - **Enable:** run `roborepo package enable <skill>` with the user's permission, then load it.
   - **Skip:** continue without it, and name it as skipped in the final report.
4. If `enabled` and `status` disagree (`partial`, `external`), report the status, offer
   `roborepo package reconcile` or skip, and never describe a drifted package as loaded.
5. If it is `missing` or `unavailable`, skip it and say so in the final report.

State which paired skills applied and which did not — a skipped skill and a forgotten one look
identical otherwise.

## Create, Revise, or Sync

`/plan-write` takes no mode. The request decides the work:

| Request | Work | Driven by |
| --- | --- | --- |
| No existing plan owns the work | **Create** a backlog plan | The desired outcome |
| An existing plan, to change scope or design | **Revise** it | The user's intent |
| An existing plan, to bring up to date after work | **Sync** it: tick a task only when the code proves it done, add `## Not tested` entries for gaps, update `next_action` and `reviewed_commit` | Repository evidence |

Revise and sync can happen in the same run; say which edits came from which.

Read the references for the situation:

- Always read `references/plan-schema.md` and `references/lifecycle.md`.
- `create`: also read `references/writing-guidelines.md`, `references/workflow-create.md`, and
  `references/workflow-validate.md` — creation ends in validation, so the work that produces the
  plan loads the checks that decide whether it is deliverable.
- `update`: read `references/workflow-update.md` and `references/workflow-validate.md`; also read
  `references/writing-guidelines.md` when the revision rewrites prose.
- Portal-generated prompts: read `references/prompt-contracts.md` when prompt shape matters.

## Creation Gates

These conditions must hold before a new plan can be called created. The full rules live in
`references/plan-schema.md`; these are the ones whose absence makes the artifact invalid.

- **Resolve the plan identity before drafting body content.** Read `docs/plans/plans-config.json`
  when it exists and choose the namespace from it; a project namespace wins over a universal one
  whenever it is the more specific fit. Form `<namespace>-<slug>.md` from that namespace, and pair
  it with a reader-facing H1 that names the outcome rather than restating the filename. When no
  config exists, say so and propose a vocabulary from the repository instead of inventing a prefix.
- **Generate an opaque `id`** of 6-8 lowercase base36 characters. Never derive it from the title,
  filename, or slug; it survives every rename and lifecycle move.
- **Frontmatter carries only** `id`, `priority`, `next_action`, `blocked_by`, `depends_on`,
  `related`, `reviewed_commit`, and `worktree`. A new plan leaves `worktree:` empty; `plan-start`
  fills it when implementation begins in a linked worktree. Do not add `status`, `validated`,
  `created_at`, `updated_at`, `owner`, `percent_complete`, `estimated_hours`, or `tags` — changing
  the schema is its own decision, made first.
- **Lifecycle is the folder, never a field.** New plans are written to `docs/plans/backlog/`.
- **Never encode lifecycle, status, dates, or versions in the filename.**
- **Load `technical-writing` before drafting, without being asked.**
- **Run both validation layers before delivering.** `roborepo plans validate` covers schema,
  lifecycle, naming, and cross-plan relationships, and `workflow-validate.md` adds the repository
  consistency checks no command can make; the `technical-writing` Validator covers prose quality and
  every paired skill that applied. A clean report from one does not excuse the other.
- **Creation ends in backlog.** If the user also asked to start the work, deliver the validated
  backlog plan and hand off to `/plan-start`, which moves the same stable `id` into
  `docs/plans/active/`.

## Common Rules

- Resolve the repository root and inspect `docs/plans` before changing plan files.
- Use repository files, tests, config, and Git state as evidence.
- Keep Markdown files as source of truth; do not invent a task database.
- Never move a plan between lifecycle folders; that belongs to `/plan-start` and `/plan-close`.
- Do not mark work complete from checked boxes alone; verify success criteria.
- Do not add machine-specific absolute paths to repository docs.
- Report changed files, verification run, and paired skills loaded or skipped.
