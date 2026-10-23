---
id: usage-statusline-codex-hook-parity
priority: low
next_action: Revalidate current upstream command-backed footer availability; retain the request as a draft unless separately authorized to file it.
blocked_by: ["upstream: Codex has no footer-command hook (or equivalent extension point)"]
depends_on: []
related: ["usage-statusline-enhancement-plan", "usage-statusline-claude-refresh"]
reviewed_commit: 57f8f2199b6db87d829af8d41e387800518024c9
---

# Usage Statusline — Codex Footer Parity via an Upstream Hook

## Summary

Bring the Codex terminal footer to the same used-direction, pacing-aware, warning-colored line the
Claude `usage-statusline` already produces — **without patching or forking Codex ourselves**. The
RoboRepo side (normalized model, pacing/severity rules, Codex adapter, shared fixtures) is already
built in `usage-statusline-enhancement-plan`. The one missing piece is an **extension point in
Codex** that lets an external command render the footer, the way Claude Code's command-backed
`statusLine` does.

This plan has two parts:

1. **Request the capability upstream.** File a feature request (drafted below) on `openai/codex`
   asking for a command-backed footer hook. If accepted and released, every Codex user gets it
   through a normal Codex update and RoboRepo maintains no Codex source.
2. **Wire RoboRepo to the hook once it exists.** A short, JavaScript-only task that reuses the
   adapter and renderer already shipped.

## Why not just patch Codex

The Codex binary is compiled from Rust (`openai/codex`, `codex-rs/`). Codex's footer items are
hardcoded native variants; there is no supported command/formatter extension point. Reaching parity
by editing Codex source means either:

- **an upstream PR** — legitimate, travels with official releases, no ongoing maintenance for us, but
  acceptance and timing are the maintainers' call; or
- **a private fork** — we compile and distribute our own patched `codex`, then re-apply the patch on
  every Codex release. The footer internals are unstable and high-churn, so this is a permanent
  maintenance tax and is explicitly out of scope.

Asking for a **generic footer-command hook** (rather than a bespoke pacing widget) is the cleanest,
most mergeable request: it is a small, general extension point, it mirrors prior art in Claude Code,
and it unlocks our already-built JavaScript with zero Rust maintenance on our side.

Until such a hook ships, the Codex footer stays **fully native** — no partial/mixed footer is shipped
(see the parent plan's completion note).

## Current state

Already built and shipped in `usage-statusline-enhancement-plan` (RoboRepo JavaScript boundary):

- `usage-adapters.mjs` — `adaptCodexRateLimitSnapshot()` maps Codex `RateLimitSnapshot`
  (`used_percent`, `window_duration_mins`, `resets_at`) into the normalized model; windows selected
  by duration, not position.
- `usage-domain.mjs` / `usage-render.mjs` — harness-agnostic pacing, severity, and fragment-level
  styling. The exact line Codex should show is already producible from a normalized snapshot.
- `fixtures/usage-cases.json` — language-neutral conformance cases the Codex output must match.
- Owned-scalar lifecycle machinery (`owned-scalars-state.mjs` + scalar merge/preserve/restore/probe
  in `package-harness-config.mjs`) — retained, currently unused, ready to disable Codex's decorative
  colors safely when the hook lands.

Not present (this plan):

- Any Codex-side footer change. `codex/status-line.json` remains the native item list.
- A `codex-statusline` entrypoint (there is nothing to invoke it yet).

## Upstream feature request draft

> **Where:** `openai/codex` GitHub → Issues → Feature request. Adjust naming/labels to that repo's
> current issue template before posting.

---

**Title:** Command-backed status-line/footer hook (parity with Claude Code's `statusLine`)

**Problem**

Codex's TUI footer (`tui.status_line`) can only display a fixed set of native items. There is no way
to render a custom footer segment from an external command. This blocks tools that want to present
account usage consistently across agents.

Concretely: the native rate-limit items render **remaining** allowance (e.g. "30% left") and apply
category/theme colors, while other agents (and our own tooling) present usage as **percentage used**
with pacing (am I ahead of or behind the elapsed window?) and warning-based colors. Users running
multiple agents must mentally translate between opposite conventions, and there is no supported way
to close that gap in Codex.

**Requested capability**

A command-backed footer hook, mirroring Claude Code's `statusLine`: Codex invokes a user-configured
command, passes the current status/usage state to it (e.g. as JSON on stdin), and renders the
command's stdout as a footer segment.

Minimal shape:

```toml
[tui]
status_line = ["model-with-reasoning", { command = "my-formatter" }, "git-branch"]
# or a dedicated key:
status_line_command = "my-formatter"
```

Behavior we would rely on:

- Codex passes the data it already has to the command — at minimum context usage and, for each
  rate-limit window, `used_percent`, `window_duration_mins`, and `resets_at`. (These already exist
  internally as `RateLimitWindow`.)
- The command's stdout (a single line, ANSI allowed) is rendered in the footer.
- A timed/idle refresh so a purely time-based value (e.g. elapsed-window percentage) keeps updating
  while the session is idle.
- Respect `NO_COLOR` / the existing color toggle.
- A short timeout and graceful fallback if the command fails, so a broken command never blocks the
  TUI.

**Why a generic hook (not a specific widget)**

A general command hook is smaller and more broadly useful than any one built-in metric, keeps
usage/formatting policy out of Codex, and matches an existing, proven design in Claude Code. It lets
external tooling render arbitrary footer content without further Codex changes.

**Prior art**

Claude Code's command-backed `statusLine`: Claude invokes a command, passes status JSON on stdin,
and renders stdout in the footer. We already ship a formatter for it; the identical formatter could
serve Codex through this hook.

---

## Proposed design

### RoboRepo wiring once a supported hook exists (JavaScript only)

Do this only after the hook lands in a released Codex version. Confirm the hook's exact
configuration shape, the payload it passes, and the refresh mechanism against Codex's released docs
before implementing.

- [ ] Confirm the released hook's config key, invocation contract (how usage data is passed), refresh
      behavior, and minimum supported Codex version.
- [ ] Add a `codex-statusline` entrypoint that reads the hook's payload, calls
      `adaptCodexRateLimitSnapshot()` → `assessUsage()` → `renderStatusLine()` (reusing the exact
      modules the Claude entrypoint uses), and writes a best-effort normalized snapshot to
      `~/.roborepo/usage/latest/codex.json` (so `/api/usage` reports Codex as collected).
- [ ] Register the entrypoint as a runtime asset in `package.config.json`.
- [ ] Update `codex/status-line.json` to select the command hook, replacing the native
      `context-remaining` / `five-hour-limit` / `weekly-limit` items — all at once, so the footer
      never shows a mixed used/remaining line.
- [ ] Disable Codex's decorative colors via the existing owned-scalar lifecycle
      (`status_line_use_colors = false`, recorded/preserved/restored/probed).
- [ ] Extend `package-probes.mjs` to verify the hook selection and owned scalar; gate on the minimum
      Codex version so older versions fail compatibility rather than silently installing the hook.
- [ ] Run the shared fixtures through the Codex path and confirm the produced line matches Claude's
      byte-for-byte; extend the lifecycle test for the Codex hook migration.
- [ ] Update the package README: Codex now renders the same used/pacing line; document the minimum
      Codex version.

## Validation

- The upstream feature request is filed (link recorded here).
- (After the hook lands) Codex footer shows used-direction context and rate limits, weekly
  debt/surplus/balanced, independent debt/used coloring, and white normal percentages — matching the
  shared fixtures exactly.
- `/api/usage` reports Codex as available with freshness once the Codex entrypoint runs.
- Enable/disable remains idempotent; the Codex footer is never left in a mixed used/remaining state
  at any point during migration.
- RoboRepo maintains no Codex (Rust) source and runs no self-built Codex binary.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Upstream declines or delays the hook | Nothing ships broken — Codex stays fully native; the parent enhancement is already complete and released for Claude. This plan simply waits. |
| Hook ships with a different contract than assumed | Part 2 begins by confirming the real released contract before any wiring. |
| Temptation to fork Codex to move faster | Out of scope by decision — private fork is a permanent maintenance tax; only an upstream-merged hook is acceptable. |
| Mixed used/remaining footer during migration | Replace all Codex rate-limit items in a single change; gate on minimum version. |

## Upstream revalidation before action

The shipped Codex fragment still selects native footer fields. Current command-hook availability
was not verified in this review, so revalidate the blocker against supported versions before
choosing implementation or an upstream request. The feature-request text is a draft; filing it or
contacting maintainers requires a separate explicit instruction. Existing native footer selections
do not by themselves satisfy command-rendered pacing parity.

## Goals

- Reach command-rendered usage/pacing parity through a supported native extension point.
- Keep native footer selections until a released, verified command contract exists.
- Preserve the shared normalization/fixtures and avoid maintaining a patched native harness.
