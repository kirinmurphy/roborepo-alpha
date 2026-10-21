---
name: code-style
description: "Use when establishing or applying general coding conventions that cross languages, including naming, file organization, helper placement, comments, exports, repetition, readability, and consistency with existing project patterns."
---

# Code Style

Use this for language-agnostic conventions. Pair with a language-specific skill when syntax, type systems, framework rules, or lint tooling matter.

Apply these while writing and changing code. Review is a backstop, not the place where code gets organized.

The measure is how easily a developer or agent can trace a behavior, test it, and change it safely. Length and the number of files or helpers are not the measure, in either direction.

## Responsibilities and Boundaries

- A module owns one coherent responsibility. Keep tightly related logic together even when the module grows long; a long module whose parts change together and read top to bottom beats the same logic scattered across files.
- Split where responsibilities diverge: parts that change for different reasons, serve different consumers, or need testing in isolation. Name each side by what it owns (e.g. schema, mappers, view-model, ui), never by size.
- Keep files and folders organized around ownership and use, not arbitrary type buckets.
- Separate configuration from implementation so business-rule changes happen in one place instead of across distributed call sites.
- When a module serves more than one consumer (e.g. a CLI and a web UI), place each piece by who actually consumes it, not by which folder happens to house the entry point. Code that only produces output for one consumer (rendering, formatting, presentation) belongs with that consumer; code both consumers need stays in the shared/common location.

### Cohesive or over-fragmented?

| Signal | Cohesive | Over-fragmented |
| --- | --- | --- |
| Changing one behavior | Touches one module | Touches several files that each hold a small piece of it |
| Following the main path | Reads within one module, or through calls that each do real work | Hops through wrappers that only forward arguments |
| The parts | Change together and share data | Were separated without a different reason to change, consumer, or test |
| A helper | Isolates real logic or serves several callers | Has one caller and renames a single expression |

The opposite failure is real too: a module that keeps absorbing unrelated responsibilities is not cohesive because it is one file. Judge by responsibility and change boundary.

## Helpers and Abstractions

Extract a helper, introduce an abstraction, or cross a file boundary only when you can name the benefit:

- it isolates meaningful logic that reads or tests more easily on its own;
- it gives one rule a single home that would otherwise drift across copies;
- it makes its caller noticeably clearer.

Similar-looking code that may evolve separately can stay inline; repetition alone is not the benefit. Place a helper next to its only consumer, and move it to a shared location when a second consumer actually needs it. Do not turn a straightforward operation into a deep call chain: every wrapper is one more hop for each reader.

- Put primary exports and the main workflow near the top; move ancillary helpers below when the language supports it cleanly.
- Prefer named exports or explicit public APIs when a project has no stronger convention.

## Flow, Data, and State

Read and write a flow in two roles:

- **Orchestrators** communicate the overall flow: they call other functions in sequence, shape data for the next step, and decide what happens when. They read as a short list of steps and hold little business logic themselves.
- **Execution functions** do one thing: an API call, a calculation that returns a result, a single field validation, a single render. Each is testable and named for that one thing.

Both roles can live in one module. Separate them where it makes the flow easier to follow, not as a rule about where files go.

- Prefer pure calculations and transformations with explicit inputs and outputs where practical.
- Keep side effects (I/O, mutation, shared state) localized and visible at the point of use, ideally in the orchestrator rather than buried in a helper whose name does not reveal them.
- Pass dependencies in rather than reaching for module-level state or ambient singletons when that makes a unit easier to trace or test.
- Make state transitions explicit: a reader should see what changes, where, and why.

## Comments

Names, types, and tests carry what the code does. Comments carry what they cannot: why, under what constraint, and with what known limitation.

Keep:

- public API contracts callers must rely on;
- invariants, external constraints, and deliberate tradeoffs or limitations;
- the reason for behavior that would otherwise look surprising or wrong;
- section headings that help navigate an unusually complex algorithm;
- tool or lint exceptions, with their justification.

Omit:

- narration of steps the code already shows;
- a heading that repeats the name of a well-named function below it;
- a comment standing in for a clearer name, type, contract, or test.

Redundant narration versus self-describing code:

```js
// Set the status to loading before fetching
state.status = "loading";
```

```js
state.status = "loading";
```

Undocumented surprising behavior versus justified rationale:

```js
await delay(2000);
```

```js
// The billing API rejects a retry sent within 2s of a 429, even with a valid Retry-After.
await delay(2000);
```

A comment's claim must match the code exactly and rest on something you verified. Write "non-pending entries" for a `status !== "pending"` filter, not "settled entries". When the reason for a choice is a requirement you were given, cite the requirement rather than inventing a plausible mechanism.

When you change code, check the comments it affects, including module headers that describe the contract: correct one that now misstates behavior, and remove one the change made redundant. Do not sweep unrelated comments.

## Local Conventions

Follow local conventions when they are clear and coherent; consistency is itself a readability benefit. Do not copy a pattern into new code that demonstrably harms comprehension or reliability just because it already exists, and do not rewrite existing instances the change does not touch.

## Review Checklist

- Names describe behavior or domain meaning.
- The main execution path of changed code can be followed without chasing pass-through wrappers.
- Responsibilities are divided at meaningful boundaries (reason to change, consumer, testability), never by length.
- Every new helper, abstraction, or file has a benefit you can name.
- Dependencies, side effects, and state transitions are explicit enough to trace and test.
- Comments add information the code cannot carry, and comments near changed code are still accurate.
- File location matches existing ownership boundaries.
- Configuration is separated from implementation where business rules would otherwise be scattered.
- Multi-consumer code is placed by who consumes it, not by which folder holds the entry point.
