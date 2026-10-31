---
name: plan-write
description: Use when creating a repository plan document under docs/plans, or revising or syncing an existing one — revising follows the user's intent to change scope or design; syncing follows repository evidence to tick finished tasks and refresh next_action and reviewed_commit. Trigger on explicit /plan-write or requests to create a durable implementation plan, revise a plan, sync this plan, or update a plan after work. Do not use for preparing a plan for development (plan-promote), implementing a plan (plan-execute), reviewing an implementation (plan-review), closing a finished plan (plan-close), archiving a plan (plan-archive), ending a session (session-close), brief answers, PR descriptions, ordinary implementation without plan-document management, casual checklists, or routine lifecycle records owned by another plan skill.
---

# Plan Write

Use this skill to write managed repository plans stored as Markdown under `docs/plans`: create a new
one, or update an existing one.

This skill owns plan content, frontmatter, and the required-section schema for plan documents.
Lifecycle moves belong to other suite commands, each committed in the primary checkout:
`/plan-promote` moves a plan into `ready/`, `/plan-execute` into `active/` and then `review/`,
`/plan-review` back to `active/` on a scope change, `/plan-close` to `completed/`, and
`/plan-archive` to `archived/`. `/plan-write` writes a new plan's initial checklist; `/plan-promote`
refines it. Prose quality and implementation correctness come from the paired skills below.

## Paired Skills

Load a paired skill only when its rules materially constrain the current work;
do not wait to be asked for them by name. Reuse guidance already loaded in this conversation,
including applicable references. Read again only if the source changed, the task enters new subject matter, or the
needed guidance is no longer available in context. A pairing does not invoke the paired skill's
whole workflow or recursively load its dependencies; apply each trigger to the actual work.

| Skill | Load when | Contributes |
| --- | --- | --- |
| `technical-writing` | Creating a plan or substantively revising requirements, design, or explanatory prose; not sync-only evidence updates | Section ordering, representation, anti-patterns, reader clarity, and the Creator/Validator loop. Knows nothing about lifecycle or frontmatter, so it never overrides a rule from this skill |
| `code-style` | The plan specifies where code goes: module boundaries, orchestration vs. execution, reuse | Ownership and layering constraints |
| `javascript-typescript` | The plan prescribes JS/TS implementation choices — ESM, exports, types, framework-less DOM; not merely a JS/TS path | Language and markup conventions the plan must not contradict |
| `test-harness` | The plan proposes tests, verification commands, or a regression strategy; not recording existing test results | Test selection and observable-behavior assertions |

Conditional triggers are subject matter, never plan size: a one-phase plan that specifies module
placement still needs `code-style`.

For a pairing whose trigger applies, use the host's advertised skill availability first. Consult
the host's skill/package manager only if availability or activation is unclear; reuse a known
state unless there is evidence it changed. If disabled, ask: "Enable it, or skip it for this run?"
Enable only with permission. If missing, skip and report it. For inconsistent activation, offer
reconciliation or skip; never describe a drifted package as loaded.

State which paired skills were used, including guidance reused from context, and any applicable
skill skipped or unavailable. Do not load skills or check package state just to report
non-applicable rows.

## Create, Revise, or Sync

`/plan-write` takes no mode. The request decides the work:

| Request | Work | Driven by |
| --- | --- | --- |
| No existing plan owns the work | **Create** a backlog plan | The desired outcome |
| An existing plan, to change scope or design | **Revise** it | The user's intent |
| An existing plan, to bring up to date after work | **Sync** it: tick a task only when the code proves it done, add `## Not tested` entries for gaps, update `next_action` and `reviewed_commit` | Repository evidence |

Revise and sync can happen in the same run; say which edits came from which.

Routine records owned by another lifecycle skill do not invoke `/plan-write`: that skill owns
its findings, test results, decisions, approvals, and checklist updates. A standalone request to
sync a plan still uses this skill's authority, evidence, schema, and lifecycle rules.
Sync-only updates do not run the technical-writing loop. Creating or substantively revising a
plan still requires both plan validation and independent prose validation. When an enclosing
workflow already requires an independent Validator, one pass may cover both rubrics explicitly;
keep its read-only role, fix/recheck loop, and reporting rather than starting a duplicate loop.

Read the references for the situation:

- Always read `references/plan-schema.md` and `references/lifecycle.md`.
- `create`: also read `references/writing-guidelines.md`, `references/workflow-create.md`, and
  `references/workflow-validate.md` — creation ends in validation, so the work that produces the
  plan loads the checks that decide whether it is deliverable.
- `update`: read `references/workflow-update.md` and `references/workflow-validate.md`; also read
  `references/writing-guidelines.md` when revising scope or design, or otherwise rewriting prose.
- UI-generated prompts: read `references/prompt-contracts.md` when prompt shape matters.

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
  `related`, `reviewed_commit`, and `worktree`. A new plan leaves `worktree:` empty; `/plan-execute`
  fills it when implementation begins in a linked worktree. Do not add `status`, `validated`,
  `created_at`, `updated_at`, `owner`, `percent_complete`, `estimated_hours`, or `tags` — changing
  the schema is its own decision, made first.
- **Lifecycle is the folder, never a field.** New plans are written to `docs/plans/backlog/`.
- **Never encode lifecycle, status, dates, or versions in the filename.**
- **Load `technical-writing` before drafting, without being asked.**
- **Run both validation layers before delivering.** The repository's plan validator covers schema,
  lifecycle, naming, and cross-plan relationships, and `workflow-validate.md` adds the repository
  consistency checks no command can make; the `technical-writing` Validator covers prose quality and
  every paired skill that applied. A clean report from one does not excuse the other.
- **Challenge the design before delivering.** Validation includes the simplicity check in
  `workflow-validate.md`, which asks whether the approach is engineered beyond the core problem and
  whether a simpler one would solve it. Adopt a strictly simpler alternative directly. When the
  simpler options have different outcomes or tradeoffs, stop and talk them through with the user:
  name the core problem, compare the plan with each alternative (what it gains, what it loses,
  effort, risk), and recommend one. Do not deliver until the user picks one. The same gate applies
  to a substantive revision of scope or design.
- **Creation ends in backlog.** If the user also asked to start the work, deliver the validated
  backlog plan and hand off to `/plan-promote`, which moves the same stable `id` into
  `docs/plans/ready/` for `/plan-execute` to start.

## Common Rules

- Resolve the repository root and inspect `docs/plans` before changing plan files.
- Before editing an existing plan, resolve its authoritative copy by the "Plan authority" rule in
  `references/plan-schema.md`, and edit only that copy. An active or review plan assigned to a linked
  worktree is edited in that worktree, even when the session started in the primary checkout; ask for write
  access to the worktree rather than editing the primary copy. When the rule falls back to the
  primary copy because the worktree's copy is unavailable, or the primary copy already holds an
  outside edit, report it, and still edit only the authoritative copy.
- Use repository files, tests, config, and Git state as evidence.
- Keep Markdown files as source of truth; do not invent a task database.
- Never move a plan between lifecycle folders; each move belongs to the suite command that owns it.
- Never write or edit a plan's `### Approval` record; only `/plan-review` records a human's approval.
- Do not mark work complete from checked boxes alone; verify success criteria.
- Do not add machine-specific absolute paths to repository docs.
- Report changed files, verification run, and paired skills loaded or skipped.
- Name the plan by its H1 title, with its id in parentheses on first mention only; the id is a
  stable reference for commands, not a name a person recognizes.
