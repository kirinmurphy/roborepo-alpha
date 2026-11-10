---
id: roborepo-usage-statusline
priority: high
next_action:
blocked_by: []
depends_on:
  - roborepo-package-development-infrastructure
related: []
reviewed_commit: 9fd1bda
---

## Completion summary

Implemented `usage-statusline` as a default-enabled Token Optimization package with package-owned
runtime asset and harness config resources. Claude Code gets a managed command-based status line
formatter with context, 5-hour, and weekly percentage segments; unavailable values render as `—`,
real zero remains `0%`, and color thresholds obey `NO_COLOR`. Codex gets native
`tui.status_line` fields only: `model-with-reasoning`, `context-remaining`, `five-hour-limit`,
`weekly-limit`, and `git-branch`.

The package infrastructure now supports `package-runtime-asset` and `harness-config` resources, including
validation, enable/disable application, and live-state probes. Claude `statusLine` singleton
conflicts preserve unmanaged settings. Codex status-line arrays merge with stable deduplication and
remove only package-owned items on disable.

Turn/tool-count status-line segments were intentionally omitted because the currently documented
Claude status-line payload does not expose those fields.

Verification:

- `npm run test:usage-statusline` passed.
- `npm run test:packages` passed.
- `npm run test:package-default-enabled` passed.
- `npm run test:package-lifecycle` passed.
- `npm test` passed.
- `npm run test:plans` passed.

# RoboRepo Usage Statusline Package — Implementation Plan

## Dependency

Implement this plan only after completing the RoboRepo Package Development Infrastructure plan.

Before editing:

1. Load the `roborepo-development` skill.
2. Load its package-development reference.
3. Use the official package scaffold.
4. Use JCodeMunch for symbol-level discovery where available.
5. Follow current repository instructions and validation commands.

Do not repeat or reimplement generic package composition, installation, selection, ownership, portal, or lifecycle infrastructure inside this package.

## Status

- Package ID: `usage-statusline`
- Display name: Usage Statusline
- Category: Token Optimization
- Default selection: enabled
- User control: removable/disableable
- Harnesses: Claude Code and Codex CLI
- Prompt-token contribution: zero
- Network activity: none

## Summary

Add a default-selected package that keeps context and account usage visible in supported harness footers.

Use percentage consumed consistently:

```text
Context: 42% · 5h: 18% · Weekly: 61%
```

When a value is unavailable, keep its segment visible:

```text
Context: 42% · 5h: — · Weekly: —
```

Also surface session-pressure signals when the harness exposes them through a documented status-line
input or native footer field:

```text
Context: 42% · 5h: 18% · Weekly: 61% · Turns: 142 · Tools: 207
```

Claude Code supports a documented command-based status line, so RoboRepo can apply warning colors:

- `0–49%`: terminal default color
- `50–69%`: orange
- `70–100%`: red

Codex supports a documented ordered list of native footer fields. Configure those fields without patching the TUI or relying on undocumented formatting controls.

## Goals

1. Keep current context consumption visible without running an informational command.
2. Keep five-hour and weekly/seven-day consumption visible.
3. Show `—` when the harness has not supplied a metric.
4. Highlight Claude usage at 50% and 70%.
5. Warn when session shape itself is risky, even if account/rate-limit percentages are missing.
6. Consume no model tokens.
7. Use only documented harness interfaces.
8. Be enabled by default while respecting explicit user disable state.

## Non-goals

- Patching either harness TUI.
- Scraping commands, terminal output, logs, transcripts, or private databases.
- Calling account endpoints.
- Sending live usage values to RoboRepo telemetry.
- Reconstructing turn/tool counts from transcripts inside the status-line process.
- Guaranteeing identical formatting across harnesses.
- Displaying purchased-credit balances or estimated costs.
- Replacing harness compaction behavior.

## Package creation

Create the package through the official scaffold added by the prerequisite plan. Select:

- Category: Token Optimization.
- Harnesses: Claude Code and Codex.
- Default enabled: yes.
- Resource types: Claude config, Codex config, runtime script, tests, portal details.

Use the generated canonical paths. Do not manually create a parallel package layout.

Conceptual package resources:

```text
usage-statusline/
  package.config.json
  README.md
  claude/
    settings.json
  codex/
    config.toml
  scripts/
    claude-statusline.mjs
  tests/
    fixtures/
```

## User-facing semantics

All numbers mean percentage consumed.

| Segment | Meaning |
| --- | --- |
| Context | Current context window consumed |
| 5h | Five-hour allowance consumed |
| Weekly | Weekly/seven-day allowance consumed |

Do not mix context remaining with rate-limit consumed unless Codex lacks a supported consumed-context field. If a Codex fallback must use remaining context, retain Codex's native label rather than presenting it as consumed.

Unavailable metrics use an em dash. Never translate absence into `0%`; zero is a real value.

## Claude Code adapter

### Configuration

Use Claude Code's documented `statusLine` command setting.

Conceptual generated configuration:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"<managed-runtime-path>/claude-statusline.mjs\"",
    "padding": 1
  }
}
```

Use the path and package-runtime-asset handling defined by the package-development infrastructure. Do not commit machine-specific paths.

### Documented input fields

Read only:

```text
context_window.used_percentage
rate_limits.five_hour.used_percentage
rate_limits.seven_day.used_percentage
session.assistant_turns or equivalent, if documented
session.tool_calls or equivalent, if documented
```

The script should ignore all other session fields. If Claude does not document turn/tool-count
fields for the status-line payload, omit those segments rather than reading transcripts or RoboRepo
telemetry state.

### Formatter implementation

Implement a dependency-free Node.js formatter.

Requirements:

- Read one JSON value from stdin.
- Print one line to stdout.
- Never read the transcript path or other session files.
- Never access the network.
- Never persist state.
- Avoid subprocesses and external utilities.
- Honor `NO_COLOR`.
- Reset ANSI styling after every colored segment.

Keep transformation logic functional and independently testable:

```js
const clamp = value => Math.min(100, Math.max(0, value))

const normalizePercent = value =>
  Number.isFinite(Number(value)) ? Math.round(clamp(Number(value))) : null

const toneFor = value =>
  value === null ? "default" : value >= 70 ? "red" : value >= 50 ? "orange" : "default"
```

Define metrics declaratively:

```js
const metrics = [
  ["Context", data.context_window?.used_percentage],
  ["5h", data.rate_limits?.five_hour?.used_percentage],
  ["Weekly", data.rate_limits?.seven_day?.used_percentage]
]
```

Render null or missing values as `—`.

### Session-pressure stages

Treat context/rate-limit percentages and session shape as separate inputs that both produce a
warning stage. The displayed color for each segment comes from that segment's own value. The overall
status-line severity, for compatibility reports and tests, is the maximum stage among all available
segments.

Initial thresholds:

| Signal | Default | Orange | Red |
| --- | --- | --- | --- |
| Context used | `<50%` | `50-69%` | `>=70%` |
| 5h used | `<50%` | `50-69%` | `>=70%` |
| Weekly used | `<50%` | `50-69%` | `>=70%` |
| Assistant turns | `<150` | `150-199` | `>=200` |
| Tool calls | `<200` | `200-299` | `>=300` |

Rationale: telemetry showed large spikes from long-session context accumulation, including a
session with `579` assistant turns and `340` tool calls where the triggering prompt was small and
the cost was mostly cached context reread. Turn/tool thresholds catch this failure mode before the
weekly percentage alone explains it.

Do not persist user-tunable thresholds in the first implementation. Keep thresholds in one formatter
constant so later package settings can expose them without rewriting output semantics.

### Color behavior

Color the complete `label: value` segment:

```text
default = no prefix
orange  = ESC[38;5;208m
red     = ESC[91m
reset   = ESC[0m
```

Do not color unavailable segments orange or red. Do not add green; normal usage should remain visually quiet.

### Output matrix

| Input state | Plain-text output |
| --- | --- |
| All available | `Context: 42% · 5h: 18% · Weekly: 61%` |
| Rate limits unavailable | `Context: 42% · 5h: — · Weekly: —` |
| Context unavailable | `Context: — · 5h: 18% · Weekly: 61%` |
| Five-hour unavailable | `Context: 42% · 5h: — · Weekly: 61%` |
| Seven-day unavailable | `Context: 42% · 5h: 18% · Weekly: —` |
| All unavailable | `Context: — · 5h: — · Weekly: —` |
| Session pressure available | `Context: 42% · 5h: 18% · Weekly: 61% · Turns: 142 · Tools: 207` |
| Session pressure unavailable | `Context: 42% · 5h: 18% · Weekly: 61% · Turns: — · Tools: —` |

Invalid JSON should produce no stdout, a concise stderr diagnostic, and a non-zero exit.

## Codex adapter

Use Codex's documented `[tui].status_line` list. Verify every field against the current official configuration schema and the minimum Codex version supported by RoboRepo.

Expected configuration:

```toml
[tui]
status_line = [
  "context-used",
  "five-hour-limit",
  "weekly-limit",
  "model-with-reasoning",
  "git-branch",
]
```

If `context-used` is not supported, use `context-remaining` and document that Codex displays remaining rather than consumed context.

Codex controls native labels, missing-value behavior, colors, and layout. Do not reconstruct unavailable native segments with an undocumented script or data source.

If the current official Codex schema documents a native color setting, it may be enabled. Otherwise omit it.

If Codex does not support native turn/tool-count footer fields, do not add a custom parser or
background command to synthesize them. Instead, rely on Codex's native usage fields in the footer
and on RoboRepo telemetry warnings for session-pressure analysis.

Do not:

- Patch Codex.
- Inject escape codes into identifiers.
- Parse `/status` or `/usage` output.
- Parse logs or transcripts.
- Start `codex app-server` for footer data.
- Poll rate-limit endpoints.

## Existing status-line conflicts

Use the generic singleton/array ownership behavior established by the prerequisite plan.

Package-specific expectations:

- Claude `statusLine` is a singleton contribution.
- Never combine an existing arbitrary status-line command into a generated shell pipeline.
- Codex `tui.status_line` must use stable ordering and deduplication where supported.
- Normalize confirmed Codex aliases before deduplication.
- Preserve unmanaged configuration or surface an actionable conflict.

## Default-enabled behavior

Register `usage-statusline` in the existing default package selection.

Requirements:

- New default configurations select it.
- Explicit disable remains disabled across regeneration and updates.
- Explicit enable remains enabled if defaults later change.
- Enabling or disabling automatically invokes the shared apply pipeline.
- Users never need to run `roborepo update` just to make the selection take effect.

## Portal integration

Show the package in Token Optimization.

Package card:

- Name: Usage Statusline
- Summary: Shows context, rate-limit, and supported session-pressure signals in harness footers without model calls.
- Default badge: Enabled by default
- Token badge: `0 prompt tokens`
- Harness badges: Claude Code, Codex
- Capability note: Claude supports warning colors and may show session pressure when supplied; Codex uses native formatting and field support.

Expanded preview:

```text
Context: 42% · 5h: 18% · Weekly: 61% · Turns: 142 · Tools: 207
```

Threshold copy:

```text
Claude: usage orange at 50%, red at 70%; turns/tools warn at 150/200 and 200/300. Codex: native formatting.
```

Token accounting must not count script or configuration file bytes as prompt tokens unless a harness actually injects them into model input.

## Compatibility

During implementation, confirm and record:

1. Minimum Claude Code version supporting `statusLine` and the required percentage fields.
2. Minimum Codex version supporting `tui.status_line` and selected identifiers.
3. Authentication modes that expose Claude rate-limit fields.

Degrade safely:

| Condition | Behavior |
| --- | --- |
| Claude supports all fields | Render all values |
| Claude lacks rate-limit values | Render their segments as `—` |
| Claude lacks status-line support | Report incompatibility; do not write unsupported config |
| Codex supports selected fields | Configure native footer |
| Codex lacks an optional field | Configure supported subset and report degradation |
| Codex lacks turn/tool fields | Omit session-pressure segments from Codex footer and keep telemetry warnings |
| Codex lacks configurable footer | Report incompatibility; do not write unsupported config |

Do not guess version gates. Verify them from official documentation/schema during implementation.

## Security and performance

- No model calls.
- No network access.
- No transcript, log, or private-state parsing.
- No input JSON logging.
- No filesystem scans.
- No Git commands.
- No persistent cache.
- One concise output line.
- Target below 100 visible characters.
- Target under 25 ms after Node startup.

Expose the installed formatter source through existing package inspection/portal mechanisms so users can audit it.

## Feature-specific tests

Use generic package lifecycle tests from the package-development infrastructure. Add these package-specific tests.

### Formatter fixtures

1. All metrics below 50%.
2. Exactly 50%.
3. Exactly 69%.
4. Exactly 70%.
5. Exactly 100%.
6. Decimal values.
7. Negative and above-100 values.
8. Missing `rate_limits`.
9. Missing five-hour only.
10. Missing seven-day only.
11. Null context.
12. All values missing.
13. Real zero values.
14. Invalid JSON.
15. `NO_COLOR` enabled.
16. Turns below, at, and above warning thresholds.
17. Tool calls below, at, and above warning thresholds.
18. Turns/tools unavailable.

Assertions:

- Segment order is stable.
- All three segments remain visible for valid JSON.
- Missing values render as `—`.
- Zero renders as `0%`.
- Threshold boundaries are correct.
- ANSI resets prevent color bleed.
- ANSI-stripped output matches expected plain text.
- Input JSON is never echoed.
- Session-pressure stages do not alter percentage semantics.

### Adapter tests

Claude:

- Generated command references the managed runtime asset.
- Settings JSON validates.
- Existing unmanaged singleton behavior follows generic conflict policy.

Codex:

- TOML validates.
- Fields are supported by the target compatibility version.
- Field order is stable.
- Confirmed aliases do not duplicate output.

### Portal tests

- Package appears under Token Optimization.
- It is default-selected for a new configuration.
- Explicit disable persists.
- Zero-token badge is correct.
- Capability difference is visible.
- Preview remains readable at narrow widths.

## Documentation

Document:

- Percentage-consumed semantics.
- `—` meaning unavailable/not yet supplied.
- Claude warning thresholds.
- Assistant-turn and tool-call warning thresholds.
- Codex native-format limitations.
- Zero prompt-token contribution.
- Default-enabled but disableable behavior.
- Compatibility requirements.
- Existing status-line conflict behavior.
- How to preview the formatter with fixture input.

Do not claim the package directly reduces token consumption. It improves usage awareness and removes the need for routine informational commands.

## Implementation sequence

### Phase 1: Confirm prerequisite infrastructure

1. Verify the package-development reference exists and is loaded.
2. Verify the scaffold supports both harness configs and a runtime script.
3. Verify explicit-disable provenance.
4. Verify automatic apply after enable/disable.
5. Verify singleton conflict handling.

Stop and complete the prerequisite plan if any item is missing.

### Phase 2: Scaffold and implement

1. Scaffold `usage-statusline`.
2. Add Claude configuration.
3. Implement the Claude formatter.
4. Add Codex native fields.
5. Add capability-gated session-pressure fields.
6. Add feature fixtures and tests.

### Phase 3: Register and expose

1. Add it to Token Optimization.
2. Add it to default selection.
3. Add portal metadata and preview.
4. Add compatibility metadata.

### Phase 4: Verify lifecycle

1. Fresh install.
2. Upgrade.
3. Explicit disable and automatic apply.
4. Re-enable and automatic apply.
5. Existing unmanaged Claude status line.
6. Existing Codex status field selection.
7. Missing/outdated harnesses.

### Phase 5: Full validation

1. Run formatter tests.
2. Run generic package lifecycle tests.
3. Run composition and installer tests.
4. Run portal tests.
5. Run repository-required full validation.
6. Inspect generated outputs for unrelated changes.

## Acceptance criteria

- Package ID and display name use `usage-statusline` / Usage Statusline.
- Package is default-selected and explicitly disableable.
- Enable/disable takes effect without a separate update command.
- Claude always displays Context, 5h, and Weekly segments.
- Unavailable Claude values display `—`.
- Claude colors 50–69% orange and 70%+ red.
- Claude displays turn/tool-count segments only when documented status-line input supplies them.
- Claude warns at 150+ turns or 200+ tool calls, and red-warns at 200+ turns or 300+ tool calls.
- Codex displays supported native context and rate-limit fields.
- Codex uses no undocumented formatting or data access.
- Codex does not synthesize unsupported turn/tool fields.
- Package adds zero prompt tokens and makes no model or network calls.
- Existing unmanaged status-line configuration is preserved or reported as a conflict.
- Generic package mechanics remain in the package-development reference, not duplicated here.
