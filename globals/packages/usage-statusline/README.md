# Usage Statusline

Shows harness-provided usage signals in terminal footers without adding prompt context. The
formatter makes **zero model calls** and contributes **zero prompt tokens** — it only reads the
status payload the harness already hands it.

## What the numbers mean

**Every displayed percentage means _used_, not remaining.** Claude Code uses its documented
command-based `statusLine` setting; the formatter reads the JSON payload from stdin and prints one
line:

```text
Context: 42% used · 5h: 18% used · Weekly: 15% surplus (70% used / 85% elapsed)
```

- **Context** — how much of the current session's context window is used.
- **5h** — used percentage of the rolling five-hour allowance.
- **Weekly** — used percentage of the rolling seven-day allowance, plus _pacing_ (below).

`—` means **unavailable** (the source did not supply enough data), never zero. A real zero displays
as `0%`.

## Weekly pacing: debt, surplus, balanced

When the harness supplies a reset time for the weekly window, the line compares **used** against
**elapsed** (how far through the window you are):

| Situation | Output |
| --- | --- |
| Used ahead of elapsed | `Weekly: 15% debt (85% used / 70% elapsed)` |
| Elapsed ahead of used | `Weekly: 15% surplus (70% used / 85% elapsed)` |
| Within tolerance | `Weekly: Balanced (68% used / 72% elapsed)` |
| No reset time supplied | `Weekly: 85% used` (usage-only fallback) |
| Nothing available | `Weekly: —` |

"Percentage points": `85% used − 70% elapsed = 15 points`. The compact UI says `15% debt` for
readability, but the arithmetic is in points.

## Thresholds

**Balance** — the difference is measured on display-rounded whole percentages so the visible math
always matches the label:

- absolute difference `< 5 points` → **Balanced**;
- exactly `5 points` is **not** balanced (it is a 5% debt or surplus).

**Debt severity** (styles the `## debt` value):

- `5–19 points` → orange;
- `≥ 20 points` → red.

**Usage severity** (styles any `## used` value, independently of pacing):

- `0–29%` → white (normal); `30–49%` → yellow (caution); `50–59%` → orange (warning); `60–100%` → red (critical).
- Inclusive lower bounds: each threshold percent belongs to its tier (`30%` is caution, not normal;
  `60%` is critical, not warning).

**Surplus is never orange or red** for being large. A high total-used value may still color the
`## used` text on its own — debt/surplus severity and total-used severity are computed and styled
independently, so one weekly segment can carry two differently colored values:

```text
Weekly: 20% debt (90% used / 70% elapsed)
        ^^^^^^^^  ^^^^^^^^   ^^^^^^^^^^^
        red       red        white (elapsed is always white)
```

Normal percentages are rendered **explicit white**, never left terminal-muted. `NO_COLOR` disables
all ANSI and prints the exact same text.

## Claude desktop app

The desktop app has no status line to draw into, so the package installs a small Claude plugin
(`claude/context-row/`) that draws one row above the prompt once context reaches 20%:

```text
Context 42%
```

The figure is yellow up to 30%, orange up to 40%, and red above that. The close button at the right
of the row hides it until context reaches the next color, or until it comes back after dropping to a
lower color (a compaction or a cleared session).

The row is desktop-only, because the terminal already has this figure in its status line. It reads
the same free usage figures, refreshed after each tool call, each turn, and each compaction, and stays
blank until a session's first response. Sessions started after the package is enabled pick it up.

The plugin is copied to `~/.roborepo/package-runtime/usage-statusline/context-row/` and named in
`env.CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`. To test it:

```sh
claude plugin test globals/packages/usage-statusline/claude/context-row
```

## Codex

Codex uses its **native** `tui.status_line` fields, **unchanged** by this package. Codex has no
command-backed footer hook (Claude's extension point), so there is no supported way to render the
used-direction, pacing-aware line in the Codex footer. Rather than ship a mixed footer (some values
"used", some native "remaining"), the package leaves the Codex footer fully native until such a hook
exists.

> **Codex footer parity is intentionally deferred, not partially applied.** When Codex gains a
> footer-command hook (or an equivalent capability), roborepo can render the exact same line there
> using the Codex adapter and shared rules already in this package. Until then the `/api/usage`
> portal endpoint reports Codex as `not-collected`. See
> `docs/plans/archived/usage-statusline-codex-parity.md`.

## Portal data surface

The Claude formatter writes a normalized snapshot (best-effort, atomic, user-only) to
`~/.roborepo/usage/latest/claude.json`. The read-only portal route `GET /api/usage` serves the
assessed snapshot with per-harness availability and freshness for the future homepage — structured
data only, never parsed terminal text. `POST /api/usage/refresh` is reserved for the (blocked) Codex
collector.

RoboRepo never parses `/status`, `/usage`, transcripts, or footer text, and never calls account
endpoints or stores raw provider payloads or credentials.

## Turns and tool calls

Turns/tool-call counts are intentionally **not** here. Neither status-line surface supplies them
cleanly across harnesses, and they are session-pressure signals rather than account-allowance
signals. They remain a separate follow-up feature.

## Minimum harness versions

- **Claude Code** — any version whose command `statusLine` payload includes `context_window` and
  `rate_limits` (`five_hour`, `seven_day`) with `used_percentage`; `resets_at` enables weekly
  pacing (usage-only fallback without it). Claude sends `resets_at` as Unix epoch **seconds**
  (a bare number); ISO strings are also accepted.
- **Codex** — no minimum; the Codex footer is left native. Parity depends on a future upstream
  footer-command hook, tracked separately.

## Preview

```sh
echo '{"context_window":{"used_percentage":42},"rate_limits":{"five_hour":{"used_percentage":18},"seven_day":{"used_percentage":85,"resets_at":"2026-07-23T22:24:00.000Z"}}}' \
  | node globals/packages/usage-statusline/scripts/claude-statusline.mjs
```

Each shared conformance case in `fixtures/usage-cases.json` carries the exact expected `weeklyText`;
the same fixtures drive the Node tests and (when it lands) the Codex Rust footer tests, keeping both
implementations in agreement.
