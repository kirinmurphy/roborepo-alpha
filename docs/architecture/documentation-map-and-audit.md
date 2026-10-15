# Documentation Audit (Historical)

This is a record of a documentation review last updated on 2026-09-29. Its file count, findings,
and cleanup suggestions describe that review, not the current documentation set. For current
ownership, use the [maintainer docs map](../internal/docs-map.md).

## Scope at the time

The review examined 25 reader-facing Markdown files: the root README, docs under `docs/`, and the
inventory README. It excluded plan files and agent instruction sources. It looked for repeated
explanations, stale behavior, navigation problems, and unclear doc ownership.

## Findings recorded

| Area | Finding at the time | Action recorded |
| --- | --- | --- |
| Install and collision behavior | Several guides repeated the same flow. | Kept the short setup path in the first-time guide and detailed conflict behavior in the collision reference. |
| Permissions | Guides still described old profile flags. | Replaced those instructions with flat behavior and command buckets. |
| Skills | Materialization was described as direct copies into harness homes. | Updated the architecture reference to describe the shared cache and per-harness links. |
| Root config | Some examples used earlier archive and adoption terms. | Updated the collision reference and architecture guide with drift-aware behavior. |
| CLI and telemetry | One large CLI document mixed commands with service detail. | Split user commands, CLI internals, and telemetry into separate references. |
| Harness parity | Explanations overlapped across architecture documents. | Kept the teaching model in the harness explanation and exact mechanics in the anatomy reference. |

The review found no broken relative file targets among the 25 files it examined. That result is a
dated observation; the current docs reference checker covers the present reader-facing set.

## Current ownership

[`docs/internal/docs-map.md`](../internal/docs-map.md) owns the live doc-of-record assignments and
navigation. Update that map when a doc is added, renamed, or retired.
