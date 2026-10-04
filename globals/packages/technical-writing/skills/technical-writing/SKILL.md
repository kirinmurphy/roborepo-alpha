---
name: technical-writing
description: Use when creating or revising durable technical documentation — architecture notes, implementation plans, migration docs, operational runbooks, design proposals, or repo reference/guide docs — that must explain concepts, current behavior, happy path, edge cases, decisions, and implementation steps for future readers. Use for docs that need clear structure, newcomer-friendly explanations, and separation of facts, recommendations, risks, and open questions. Do not use for brief answers, quick todos, PR descriptions, commit messages, or lightweight implementation notes unless the user asks for a structured document.
---

# Technical Writing

Use this skill to write or revise technical documentation that helps future readers understand a
system, plan, migration, or operational workflow.

## Paired Skills

**Load these as part of the mode; do not wait to be asked for them by name.**

| Skill | Load when | Contributes |
| --- | --- | --- |
| `plan-write` | The document lives under `docs/plans` | Frontmatter, lifecycle folders, naming, and the required-section schema. Don't duplicate its section list here (see `doc-shapes.md`'s note on this) |
| `code-style` | The document specifies where code goes: module boundaries, orchestration vs. execution, reuse | Ownership and layering constraints the guidance must respect |
| `javascript-typescript` | The document covers JS/TS — ESM, exports, types, framework-less DOM structure | Language and markup conventions the guidance must not contradict |
| `test-harness` | The document proposes tests, verification commands, or a regression strategy | Test selection and observable-behavior assertions |

This skill covers prose quality; a paired skill governs whether what the document *says to build*
is right. Both are in scope, and whatever loaded here joins the Validator's rule set in
`references/review-loop.md`. State which paired skills applied and which did not — a skipped skill
and a forgotten one look identical otherwise.

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
procedure lives in the reference; what decides whether the work is done:

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
