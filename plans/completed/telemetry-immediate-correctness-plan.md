---
id: telemetry-immediate-correctness
priority: high
next_action:
blocked_by: []
depends_on: []
related:
  - roborepo-telemetry-events-experiments
  - roborepo-usage-statusline
reviewed_commit: cbc30c73a60d7cfaa9bb367f09c2b6b6bcc49644
---

# Telemetry Immediate Correctness

## Summary

Fix the current telemetry blind spots before building broader telemetry experiments, markers, or
package-comparison analysis.

The urgent problems are:

- Codex captures record tool events but currently report zero tokens.
- Repeated full-document reads are invisible even when they inflate session context.
- Codex jcodemunch usage is not reported accurately because current analysis is shaped around
  Claude-style tool records.
- The telemetry dashboard and terminal report need data-quality warnings when a selected harness has
  events but no usable token records.

## Context

Current RoboRepo telemetry already captures Claude and Codex hook events into per-harness JSONL
spools under the local telemetry state directory. The terminal report and `/telemetry` dashboard
share `scripts/cli/telemetry-analyze.mjs`.

The current parser behavior is Claude-biased. Claude transcripts expose token usage through
assistant `message.usage` records. Codex transcripts expose usage through `event_msg.token_count`
records, including `payload.info.total_token_usage` and `payload.rate_limits`.

Recent raw Codex transcript inspection showed:

- Codex `token_count` events contain nonzero cumulative token totals and weekly limit percentages.
- Current RoboRepo Codex telemetry records still store `tokens.total: 0`.
- Codex used jcodemunch often, but also performed many read/search shell commands.

This plan is intentionally narrower than the broader
`docs/plans/active/roborepo-telemetry-events-experiments-plan.md`. It should ship first.

## Goals

1. Make Codex sessions contribute nonzero token totals and deltas to existing telemetry views.
2. Preserve existing Claude telemetry behavior.
3. Warn when selected-window harness data is present but token data is missing or unusable.
4. Detect repeated or large document reads without storing raw document paths or contents.
5. Distinguish Codex jcodemunch use from native/read-like shell fallback.
6. Add advisory package-rule and hook nudges that reduce redundant document and source reads.

## Non-goals

- Implementing telemetry markers, experiments, outcomes, or package cohort comparison.
- Migrating all telemetry records to schema v3.
- Blocking Codex or Claude tool calls based on telemetry findings.
- Reading private transcripts from the statusline package.
- Sending telemetry off-machine.
- Storing raw prompt, document, command output, or full file paths beyond existing privacy-safe
  hashes and previews.

## Current State

### Codex Token Gap

`scripts/cli/telemetry-transcript.mjs` currently accumulates token usage from Claude-style
`message.usage` fields. Codex transcripts use `event_msg.token_count` records instead, so Codex
captures can have real tool events but zero token totals.

Expected Codex mapping:

- `payload.info.total_token_usage.total_tokens` is the cumulative total used for `tokens.total` and
  `delta_tokens`.
- `input_tokens` includes cached input, so store non-cached input as
  `max(0, input_tokens - cached_input_tokens)`.
- `cached_input_tokens` maps to `cache_read` for cross-harness charts.
- `output_tokens` maps to `output`.
- `reasoning_output_tokens` remains available in a Codex-specific details field if exposed, but is
  not added again to total.
- `payload.rate_limits` is provider-reported limit state and must be labeled separately from local
  rolling seven-day estimates.

### Repeated Document Reads

Telemetry already stores privacy-safe file metadata and tool-result sizes. It does not currently
flag:

- same document read repeatedly in one session;
- one very large document read;
- docs indexed but no jdocmunch calls observed;
- jcodemunch observed but many native source reads or read-like shell commands still occur.

### Codex jcodemunch Analysis

Codex transcripts expose MCP calls through `event_msg.mcp_tool_call_end` and function calls through
`response_item.function_call`. Current reporting should treat these as first-class Codex evidence,
not infer Codex behavior from Claude's tool schema.

## Proposed Design

### Harness Transcript Adapters

Move transcript parsing behind explicit adapters:

- Claude adapter: preserve current `message.usage`, assistant/tool-result parsing, and schema-v2
  compatibility.
- Codex adapter: parse `event_msg.token_count`, `response_item.function_call`,
  `response_item.function_call_output`, and `event_msg.mcp_tool_call_end`.
- Unknown adapter: preserve metadata-only records rather than fabricating zeros.

The capture command can continue writing schema-v2 records while the adapter produces the existing
`tokens`, `session`, `last_result`, and `biggest_result` shape.

### Data-Quality Warnings

Add analyzer warnings when selected-window data is incomplete:

- harness has events but zero nonzero token records;
- transcript exists but no supported usage schema was found;
- Codex rate-limit state exists in transcript but did not land in telemetry output.

These warnings should appear in both `roborepo telemetry report` and `/telemetry`.

### Repeated-Read Warnings

Add deterministic warning types:

- `repeated_document_read`: same session, same `file_path_hash`, document extension (`.md`, `.rst`,
  `.mdx`, `.txt` under `docs/`), read two or more times with cumulative result size over 20k chars.
- `large_document_read`: one document read result over 20k chars.
- `stale_doc_lookup`: docs are indexed but the session uses repeated full-document reads without
  any observed jdocmunch calls.
- `mixed_code_lookup`: jcodemunch is observed, but the same session still performs many native
  `Read` or read-like shell commands against source files.

Warning evidence must stay privacy-safe:

- repository;
- session short ID;
- file extension and path hash;
- read count;
- cumulative result chars and approximate tokens;
- jdocmunch or jcodemunch observed call count;
- suggested next action;
- link to existing session-context actions when transcript lookup is available.

### Instruction and Hook Follow-Up

Update package guidance to prevent redundant reading:

- In `globals/packages/jdocmunch/rules.md`, prefer `search_sections`, `get_toc`, and `get_section`
  for docs.
- After reading a plan or doc once, reuse gathered anchors and facts in the current turn instead of
  rereading the full file.
- For non-indexed docs, run `roborepo index docs docs/` before broad exploration when practical.
- Use targeted line ranges only when a specific section must be verified from source.
- Do not reread a full plan/doc unless it changed, the user asks for a fresh full review, or the
  previous read was insufficient and the reason is stated.

Add Codex-side jcodemunch/jdocmunch session-start nudges where package resources can support them.
Codex hooks should remain advisory unless the package system has a documented safe denial path for
the relevant tool. Telemetry warnings, not hard blocks, are the first enforcement mechanism for
Codex read/search waste.

## Implementation Plan

- [x] Add representative Claude and Codex transcript fixtures, including Codex `event_msg.token_count`
      and `event_msg.mcp_tool_call_end`. Checked-in as `.jsonl` files under
      `scripts/test/fixtures/telemetry/` (`claude-basic`, `claude-failure`, `codex-basic`,
      `codex-turn-context-model`), read directly by
      `scripts/test/telemetry-correctness-check.mjs` instead of built inline.
- [x] Introduce harness transcript adapters while preserving the current public stats shape.
      Implemented as type-sniffing branches in `scripts/cli/telemetry-transcript.mjs`
      (`applyCodexEntry()`) rather than separate adapter modules — Claude and Codex entry shapes are
      structurally disjoint so this does not collide; formalizing separate adapter files was not
      necessary to meet the goal.
- [x] Implement Codex token mapping and delta-token behavior (`scripts/cli/telemetry-transcript.mjs`,
      `applyCodexEntry()`), matching the plan's `max(0, input_tokens - cached_input_tokens)` and
      `cached_input_tokens -> cache_read` mapping exactly.
- [x] Add data-quality warnings for missing or unusable token records
      (`dataQualityWarnings()` in `scripts/cli/telemetry-analyze.mjs`): `missing_token_data`,
      `unsupported_usage_schema`, and `rate_limit_unavailable` (added — Codex token data present but
      no `codex_rate_limits` observed in any event for that harness).
- [x] Add repeated document-read and mixed lookup analyzers (`readWarnings()` in
      `scripts/cli/telemetry-analyze.mjs`): `repeated_document_read`, `large_document_read`,
      `stale_doc_lookup`, `mixed_code_lookup`.
- [x] Render the new warnings in terminal report output (`printDataQualityWarnings`,
      `printReadWarnings` in `scripts/cli/telemetry.mjs`).
- [x] Render the new warnings in `/telemetry` with session-context actions
      (`renderDataQualityWarnings`, `renderReadWarnings` in `portal/telemetry/renders.js`; both are
      generic over `{type, harness, events, hint}` so the new `rate_limit_unavailable` type required
      no portal changes).
- [x] Update jdocmunch and jcodemunch package rules/hooks with advisory anti-reread guidance.
      `globals/packages/jdocmunch/rules.md` and `hooks-codex.json`/`hooks-claude.json` now agree on
      both the `index_local` MCP tool and the `roborepo index docs docs/` CLI form.
- [x] Add focused tests for Claude compatibility, Codex token parsing, repeated-read warnings, and
      Codex jcodemunch/read-like shell attribution. `scripts/test/telemetry-correctness-check.mjs`
      covers all of this plus a new `rate_limit_unavailable` case; wired into
      `scripts/test/test-roborepo.sh`.

## Validation

- `roborepo telemetry report` shows nonzero Codex token totals when Codex transcripts contain
  `event_msg.token_count`. Verified via `testCodexTranscript` in
  `scripts/test/telemetry-correctness-check.mjs`.
- `/telemetry` timeline, sessions, usage windows, and top-token contributors include Codex token
  deltas. Verified via `testAnalyzerIndexedSummaries`.
- Existing Claude fixture outputs remain stable. Verified via `testClaudeTranscript` and
  `testClaudeTranscriptFailureText` against checked-in fixtures.
- A fixture with repeated reads of the same Markdown file produces `repeated_document_read`.
- A fixture with one large Markdown read produces `large_document_read`.
- A fixture with jcodemunch plus many read-like shell commands produces `mixed_code_lookup`.
- Privacy checks confirm warnings do not expose raw paths, full document text, or full command
  output (evidence fields are limited to `file_ext`, `file_path_hash`, counts, and char/token
  approximations — see `readWarningRow()` in `scripts/cli/telemetry-analyze.mjs`).
- `node scripts/test/telemetry-correctness-check.mjs` passes (2026-07-23), including the new
  `rate_limit_unavailable` warning case.

## Open Questions — resolved

- Codex rate-limit `used_percent`: shown in `/telemetry` and `roborepo telemetry report` today via
  `codex_provider_rate_limits`; the new `rate_limit_unavailable` data-quality warning covers the case
  where it's absent. A future usage-statusline package can still add glanceable surfacing without
  conflicting with this.
- Document-read thresholds: kept fixed (`LARGE_DOCUMENT_READ_CHARS = 20000`,
  `REPEATED_DOCUMENT_READ_COUNT = 2`, `MIXED_CODE_LOOKUP_NATIVE_READS = 4` in
  `telemetry-analyze.mjs`). No evidence yet that they're wrong; revisit only if warnings prove noisy.
- Codex hook noise: `hooks-codex.json`/`hooks-claude.json` SessionStart hooks are single-line,
  conditional on `docs/` existing, and advisory only — no reported noise issues.

## Risks

- Codex transcript schema may change. Keep the adapter tolerant and add data-quality warnings rather
  than failing reports.
- Mapping cached input into `cache_read` is useful for cross-harness charts but not identical to
  Claude cache semantics; label provider-reported details clearly.
- Read-like shell command detection can overcount legitimate commands. Keep these warnings advisory
  and link to evidence instead of treating them as policy failures.

## Open Questions

- Should Codex rate-limit `used_percent` be shown as provider-reported weekly usage in `/telemetry`,
  or only in the future usage-statusline package?
- Should document-read thresholds be configurable after the first fixed-threshold implementation?
- Can Codex hooks safely emit package advisory messages on every startup/resume without creating
  noisy prompt context?
