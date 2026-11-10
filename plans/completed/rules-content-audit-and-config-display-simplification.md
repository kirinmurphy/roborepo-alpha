---
id: rules-content-audit-and-config-display-simplification
priority: none
next_action:
blocked_by: []
depends_on: []
related: []
reviewed_commit:
---

# Rules Content Audit And Config Display Simplification

> Status: completed. The rules audit cleanup and `/config` live-rules display shipped.

## Purpose

`roborepo` now splits global rules across shared fragments, harness-specific fragments,
and package-gated rule packs. The current control-panel preview makes that layering visible,
but it is harder to read than the actual files the user lives with.

This plan keeps the audit findings in one place and describes the display change that should
follow: show the live `CLAUDE.md` / `AGENTS.md` files directly, then expose the baseline
slice views as optional drill-downs.

## Current State

The current rules source layout is:

- `globals/rules/shared/*.md` for shared baseline rules
- `globals/rules/claude/*.md` for Claude-only baseline rules
- `globals/rules/codex/*.md` for Codex-only baseline rules
- `globals/packages/*/rules.md` for package-gated rule content

There are two rendered output layers:

- Tracked baseline snapshots:
  - `globals/claude/CLAUDE.md`
  - `globals/codex/AGENTS.md`
- Live home files:
  - `~/.claude/CLAUDE.md` contains Claude's full rendered rules inline inside the
    `managed:roborepo-code-style` block.
  - `~/.codex/AGENTS.md` contains Codex's full rendered rules inline inside the
    `managed:roborepo-code-style` block.
  - `~/.codex/AGENTS.override.md`, when it already exists, receives the same Codex
    managed block because Codex gives it precedence over `AGENTS.md`.

This means both harnesses use the same mental model: shared snippets are source-shared at
render time, while the live `CLAUDE.md` and `AGENTS.md` outputs are harness-specific inline
managed blocks.

The `/config` portal currently shows the rules content as split previews:

- shared baseline
- Claude baseline
- Codex baseline
- enabled package rules

That view is useful for auditing the render pipeline, but it hides the actual live file
shape, including managed markers and user-authored edits.

## Audit Findings

### Shared baseline

`globals/rules/shared/05-skill-loading.md`, `20-verification.md`, and
`40-temp-files.md` are baseline behavior and belong in the generated harness files.
They are short, cross-harness, and not tied to an optional package.

`globals/rules/shared/00-communication.md` was deleted. The caveman default lives with
the caveman package rules, leaving no shared communication baseline unless a non-package
default is needed later.

Project Context orientation is correctly package-gated with `/inventory` in
`globals/packages/project-context/rules.md`; it should not move back into the shared
baseline.

### Harness-specific baseline

`globals/rules/claude/90-claude-specific.md` currently says:

- optional package hooks can redirect broad tools;
- direct TypeScript compiler runs should use `tsc --noEmit --pretty false`;
- long command logs should be summarized.

Only the hook-redirect guidance is a true Claude baseline difference, because Claude has
package hooks that can block tool calls. The TypeScript and log-summary guidance is
general behavior and is already better covered by skills and verification rules. Those two
Claude-only bullets should be removed.

`globals/rules/codex/90-codex-specific.md` currently says:

- stable global Codex config is version-controlled in this repo;
- prefer tracked repo files over ad hoc `~/.codex` files;
- if useful config is added under `~/.codex`, capture it in the repo or update sync/install
  scripts.

This is still useful because Codex config has a real repo-backed source-of-truth story.
It should remain Codex-only.

### Package-gated rules

Package rule content belongs in `globals/packages/*/rules.md`, not in the baseline shared or
harness-specific fragments. The package-controlled behaviors are the right place for output
style add-ons and other optional behavior.

Current package verdicts:

| Source | Verdict | Reason |
| --- | --- | --- |
| `globals/packages/caveman/rules.md` | Keep package-gated | Output style preference, not a universal baseline. |
| `globals/packages/convention-capture/rules.md` | Keep package-gated | Chat-time behavior with visible output. |
| `globals/packages/impact-awareness/rules.md` | Keep package-gated | Chat-time behavior with visible output. |
| `globals/packages/skill-visibility/rules.md` | Keep package-gated | Chat-time behavior with visible output. |
| `globals/packages/jcodemunch/rules.md` | Keep package-gated | Depends on optional MCP availability and hooks. |
| `globals/packages/jdocmunch/rules.md` | Keep Claude-only for now | Manifest wires this to Claude only; expand to Codex only after Codex doc MCP support is verified. |
| `globals/packages/project-context/rules.md` | Keep package-gated | Useful only when `/inventory` support is installed/enabled. |

### Renderer model

The live rendering model is now symmetrical:

- Claude receives inline rules in `~/.claude/CLAUDE.md`.
- Codex receives inline rules in `~/.codex/AGENTS.md`.
- Harness-specific fragments stay inside the harness render target. Do not make Claude import
  Codex's rendered `AGENTS.md`, because that would either lose Claude-specific fragments or
  force Codex-specific guidance into Claude's context.

The previous Claude `roborepo-agents-import` block is treated as a legacy marker. The renderer
replaces it with the inline `roborepo-code-style` block while preserving user-authored text
outside managed blocks.

## Recommended Cleanup

1. Delete `globals/rules/shared/00-communication.md` or make the renderer skip empty/comment-only
   fragments.
2. Reduce `globals/rules/claude/90-claude-specific.md` to the hook-redirect bullet.
3. Keep `globals/rules/codex/90-codex-specific.md` unchanged.
4. Keep package rules in `globals/packages/*/rules.md`; do not merge visible chat-time output
   behaviors back into baseline.
5. Keep `/config` focused on the live file output so users can inspect the inline Claude and
   Codex managed blocks directly.

## Proposed State

The `/config` portal should switch from a fragment-by-fragment rules preview to the live
on-disk files.

The main rules area should:

1. Show the actual live `CLAUDE.md` and `AGENTS.md` file content from the user's machine.
2. Preserve visible boundary markers and any user-authored text already in those files.
3. Show only Claude and Codex selectors at the top, and only when both harnesses are present.
4. Show a short `Roborepo defaults` line below the scrollable file view with drill-down
   buttons for:
   - Global baseline
   - Claude baseline
   - Codex baseline
   - Tool Add-Ons
5. Render those drill-down popups, the live file view, and skill source popups with a markdown
   renderer instead of plain text.

## Happy Path

1. A user opens `/config`.
2. The portal shows the live `CLAUDE.md` or `AGENTS.md` file as rendered markdown.
3. If both harnesses exist, the user can switch between them with a small Claude/Codex control.
4. The file view shows managed markers, generated rules, and any user text that already lives
   in the file.
5. The `Roborepo defaults` buttons open rendered snippet popups for the shared baseline,
   harness-specific baseline, and enabled package rule slices.

## Edge Cases

- If only one harness exists, the portal should show that file without any harness toggle.
- If a live rules file does not exist yet, the portal should show a clear empty-state message
  rather than a fake preview.
- If a snippet is empty, its drill-down button should be disabled or hidden.
- Markdown content should render safely in the portal; raw HTML should not be trusted.

## Implementation Checklist

1. Add or reuse a markdown renderer for the config portal source popup and live rules view.
2. Replace the split rules-preview panel with a live-file panel backed by the on-disk home files.
3. Keep the shared/harness/package slice data available for the drill-down buttons.
4. Only show the Claude/Codex selector when both live files are present.
5. Update the config-panel reference docs after the portal shape settles.

## Open Decisions

- Whether the live rules view should poll the live files separately or keep reading them as part
  of the existing config snapshot.
- Whether the `Roborepo defaults` buttons should stay inline text buttons or become a compact
  segmented control.
