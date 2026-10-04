# Writing Guidelines

- Write for a developer who did not join the original conversation.
- Separate facts, recommendations, risks, and open questions.
- Establish why the work exists before implementation details.
- Separate current behavior from proposed behavior.
- Use repository-relative paths.
- Verify claims against source code, tests, configuration, and runtime evidence.
- Keep TODO-style plans focused on unresolved work.
- Do not document completed work as if it remains pending.
- Preserve uncertainty as explicit open decisions.
- Prefer concrete examples where data relationships matter.
- Visualize structure instead of describing it in prose. When a section covers a
  sequence, a flow between components, a decision with branches, a comparison between
  options, or a before/after state, use the matching visual form — a Markdown table for
  comparisons/option sets, a fenced ` ```mermaid ` diagram (`flowchart`/`sequenceDiagram`/
  `stateDiagram-v2`) for relationships and ordering, or a small real data/code snippet
  for measured behavior — instead of a dense paragraph walking through the same
  structure in words. Use real names, paths, and figures from the repo; never invent
  structure or numbers. A visual must reveal something prose says less clearly, not
  decorate a point already obvious — one well-placed table or diagram beats several
  weak ones. If a plan doc is ever rendered somewhere that supports live/canvas
  content (e.g. published as an Artifact rather than read as a plain repo file), an
  interactive chart may go further than a static diagram — but the plan doc itself,
  read as plain Markdown, must still carry a legible fallback (a table or mermaid
  diagram) in the same place, since most plan docs are read directly as files.

Common implementation plan shape:

```md
# Title

## Summary

## Context

## Goals

## Non-goals

## Current state

## Proposed design

## Implementation plan

## Validation

## Risks

## Open questions
```
