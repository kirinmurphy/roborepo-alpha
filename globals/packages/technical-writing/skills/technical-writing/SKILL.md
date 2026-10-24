---
name: technical-writing
description: Use when creating or revising durable technical documentation — architecture notes, implementation plans, migration docs, operational runbooks, design proposals, or repo reference/guide docs — that must explain concepts, current behavior, happy path, edge cases, decisions, and implementation steps for future readers. Use for docs that need clear structure, newcomer-friendly explanations, and separation of facts, recommendations, risks, and open questions. Do not use for brief answers, quick todos, PR descriptions, commit messages, lightweight implementation notes, routine review records, test results, decisions, and checklist updates unless the user asks for substantive document authoring.
---

# Technical Writing

Use this skill to write or revise technical documentation that helps future readers understand a
system, plan, migration, or operational workflow.

Routine review records, test results, decisions, and checklist updates stay in their owning
workflow. Editing skill instructions uses the skill-maintenance guidance; it does not by itself
invoke document authoring. A substantive rewrite of requirements, design, or explanatory prose
still uses this skill, even when it occurs during implementation or review.

## Paired Skills

Load a paired skill only when its rules materially constrain the current work;
do not wait to be asked for them by name. Reuse guidance already loaded in this conversation,
including applicable references. Read again only if the source changed, the task enters new subject matter, or the
needed guidance is no longer available in context. A pairing does not invoke the paired skill's
whole workflow or recursively load its dependencies; apply each trigger to the actual work.

| Skill | Load when | Contributes |
| --- | --- | --- |
| `code-style` | The document specifies where code goes: module boundaries, orchestration vs. execution, reuse | Ownership and layering constraints the guidance must respect |
| `javascript-typescript` | The document prescribes JS/TS implementation choices — ESM, exports, types, framework-less DOM structure; not merely a JS/TS path | Language and markup conventions the guidance must not contradict |
| `test-harness` | The document proposes tests, verification commands, or a regression strategy; not recording existing test results | Test selection and observable-behavior assertions |

This skill is agnostic to document-specific workflows. Apply content, structure, and ownership
constraints supplied by the caller or repository without choosing or invoking a workflow based
on the document's kind or location. Report skills actually used, including reused guidance,
and applicable skills skipped or unavailable; non-applicable rows need no inventory.

This skill covers prose quality and the content constraints of applicable paired skills.

## Mode Selection

If invoked as `/technical-writing` with no mode, return this compact help and stop:

```text
/technical-writing write    draft or revise a doc, then validate it
/technical-writing review   read-only Creator/Validator pass over an existing doc
```

`write` is the only artifact-producing mode: creating, editing, revising, restructuring, and
updating a durable document are all `write`, and there is no separate `edit` or `revise` mode.
`review` evaluates an existing document and reports violations without changing it.

For a named mode, read only the needed references:

- Always read this file's Core Writing Philosophy below.
- `write`: also read `references/doc-shapes.md`, `references/section-guidance.md`,
  `references/representation.md`, `references/anti-patterns.md`, and `references/review-loop.md`.
- `review`: also read `references/review-loop.md`, plus whichever of `doc-shapes.md` /
  `section-guidance.md` / `representation.md` / `anti-patterns.md` / `doc-organization.md` the
  review needs to check against.
- Revising a documentation set (not a single doc): also read `references/doc-organization.md`.

## Completion Gate

**Do not present a durable document as finished until the Creator/Validator loop in
`references/review-loop.md` has run** — every `write` invocation, new document or edit alike. The
procedure lives in the reference. When an enclosing workflow already requires an independent
Validator, a single pass may cover both rubrics explicitly; preserve read-only review, report its
findings, fix and recheck them, and retain the enclosing workflow's gates. Do not start a second
loop solely because this skill was paired. What decides whether the work is done:

- The Creator owns edits. The Validator only reports violations and never rewrites.
- Every Validator pass is surfaced to the user in chat, including a pass that finds nothing.
- A pass with violations returns to the Creator, and the next pass validates the *revised* draft.
- The document is finished when a Validator pass reports zero violations, or when the documented
  10-pass cap is reached — at the cap, report the outstanding violations instead of claiming
  completion.

`review` reports the same way but stops there: it never edits the document, and a clean report from
`review` is an evaluation, not a delivery.

## Core Writing Philosophy

- Establish why the system or behavior exists before describing how it works. A reader who
  understands the problem first can evaluate the solution; a reader who only sees mechanics
  cannot.
- Make the doc useful to a new engineer who lacks the conversation context.
- Separate current behavior from proposed behavior.
- Put the happy path before edge cases.
- Define domain terms before using them heavily.
- Keep each section self-contained enough that it does not depend on later sections.
- Preserve uncertainty as explicit open decisions, not buried caveats.
- Prefer concrete examples over abstract explanation when data relationships matter.
- Verify claims against source code, tests, configuration, and runtime evidence.
- Match the form to the content — diagrams, tables, and code blocks over prose. See
  `references/representation.md`.

## Naming and Titles

- The filename is an identifier: lowercase, hyphenated, specific enough to disambiguate from its
  neighbors.
- The H1 is prose for a human reader — normal capitalization and spacing, naming the outcome. It is
  not the filename with the hyphens removed.
- Never encode status, priority, or dates in a filename. Those change; filenames get linked to.
- Follow the dominant naming convention already visible in the directory you are writing into,
  rather than introducing a new one. Say which convention you inferred.
