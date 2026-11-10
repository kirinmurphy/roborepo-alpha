---
id: config-panel-behavior-sections
priority: none
next_action:
blocked_by: []
depends_on: []
related: []
reviewed_commit:
---

# Config Panel Behavior Sections — Plan

> **Status: implemented.** Both additions below shipped — the Commands section and the
> default-on, toggleable Chat-Time Output section (convention capture, impact awareness,
> skill visibility) merged into both harnesses. Current behavior is documented in
> [config-control-panel.md](../../user/reference/config-control-panel.md); this plan is
> retained for the design rationale and the superseded-wizard history.

## Purpose

`roborepo` exposes harness configuration through one inspectable, editable surface: the
web dashboard (`/config`) and the terminal `roborepo onboard` flow. Both render the same
snapshot and write through the same mutate primitives. The surface is organized into
user-facing **behavior sections** (Token Optimization, Commands, Code Conventions,
Chat-Time Output, Permissions) rather than the internal install machinery.

This plan covered two additions to that section model:

1. **Commands as their own section.** Slash commands currently appear inside the
   "Workflows" section framed as skills. Surface them as commands.
2. **A "Chat-Time Output" section.** The three inline chat-note behaviors
   (convention capture, impact awareness, skill visibility) are always-on global rules
   today. Group them in one section so a user can toggle each on or off.

This document supersedes an earlier multi-step item-selection wizard plan for the same
file; see Superseded Approach at the end for what changed and why.

## Concept Model

The config panel is built from a few nouns. Source of truth differs per noun — some live
in the user's live harness config, some in repo manifests, some in roborepo state. Full
detail lives in [`docs/user/reference/config-control-panel.md`](../../user/reference/config-control-panel.md);
the essentials:

- **Package** — a named feature made of typed components, defined in
  `manifests/inventory/packages.json`. Enabling it dispatches on each `component.type`
  (`mcp`, `rules`, `hooks`, `permissions`, `plugin`, `service`, `skill`). The `rules`
  component merges a rules block into the user's live `~/.claude/CLAUDE.md` keyed by its
  unique first line, and removes it on disable (`scripts/cli/packages.mjs`).
- **Skill** — a shared skill linked into harness skill dirs. Enabled state = the symlink
  exists. Toggled per-skill through `setSkillInstalled()`.
- **Snapshot** — the assembled current state, produced by `readConfigSnapshot()`
  (`scripts/cli/config.mjs`). `buildBehaviorView()` maps it onto the named sections both
  the web view and terminal flow render.
- **Behavior section** — one user-facing group in the panel. Each section's `items` are
  derived from the snapshot; each item carries `id`, `label`, `description`, `active`, and
  optional `badges`/`hint`.
- **Rule fragment** — a markdown file under `globals/rules/shared/` that
  `scripts/build/render-rules.sh` renders into the generated base `globals/claude/CLAUDE.md`
  and `globals/codex/AGENTS.md`. These ship as part of the base install. The three
  Chat-Time Output behaviors are rule fragments today: `06-skill-visibility.md`,
  `30-session-capture.md`, `35-impact-awareness.md`.

The distinction that drives the Chat-Time Output work: a **package `rules` component**
merges into the user's *live* config and is reversible per package; a **rule fragment** is
baked into the *generated base* rules and is always-on. Making the three behaviors
toggleable means moving them from the always-on fragment path onto a reversible toggle.

## Current Behavior

`buildBehaviorView()` (`scripts/cli/config.mjs`) returns these sections:

- **Token Optimization** — `jcodemunch`, `jdocmunch`, the Caveman plugin, and Telemetry,
  each a package toggle. (Caveman stays here; it is a token-reduction tool, not a
  chat-note behavior.)
- **Workflows** — skills that have a paired slash command, filtered as
  `snap.tools.filter((t) => t.command ...)`. Each item shows `badges: ["skill", "/<cmd>"]`
  and toggles via the skill link. This is where the five commands
  (`case-study`, `frontend-design`, `plan-docs`, `inventory`, `tighten`) surface today —
  framed as skills that happen to carry a command.
- **Code Conventions** — auto-loaded skills with no command
  (`snap.tools.filter((t) => !t.command ...)`).
- **Permissions** — the active permission profile with a global/project scope switch.

The three Chat-Time Output behaviors do not appear in the panel at all. They render into the
base `CLAUDE.md`/`AGENTS.md` from their rule fragments and are always active.

All five shipped commands are skill-backed: each `globals/claude/commands/<name>.md`
pairs with a shared skill of the same id. There are no standalone (skill-less) commands.

## Proposed Behavior

### 1. Commands section (presentation only)

Split the command-backed skills out of "Workflows" into their own **Commands** section so
they read as commands, not skills. No new install mechanism: the toggle still links/unlinks
the backing skill through `setSkillInstalled()`, exactly as today. The section is a
relabel + regroup of the existing `snap.tools.filter((t) => t.command ...)` items.

Because every command is skill-backed and the toggle stays the skill link, this change
touches only `buildBehaviorView()` and the renderers (web dashboard + terminal labels). It
adds no package, no state shape, and no new component type.

### 2. Chat-Time Output section (new togglable behaviors)

Add a **Chat-Time Output** section with three items: convention capture, impact awareness,
skill visibility. Each item is independently toggleable and writes the corresponding rule
block into the user's live config when on, removes it when off.

This requires moving each behavior from the always-on rule-fragment path onto the
reversible package `rules` path:

- The behavior text moves from `globals/rules/shared/{06,30,35}-*.md` into per-behavior
  rules sources the package `rules` component can merge (e.g.
  `globals/packages/<behavior>/rules.md`), and stops rendering into the base
  `CLAUDE.md`/`AGENTS.md`.
- Each behavior becomes a package (or one package with three independently-toggleable
  rules components) so `enable`/`disable` and the panel toggle add/remove the block by its
  unique first line, reusing the existing `mergeRules`/`unmergeRules` primitives.
- `buildBehaviorView()` gains the section, reading each behavior's enabled state from the
  snapshot the same way the Token Optimization packages are read.

The default install should keep all three on, matching today's always-on behavior, so the
move is presentation/reversibility without a behavior change on a fresh install.

## Happy Path

1. User opens `/config` (or runs `roborepo onboard`).
2. The panel renders Token Optimization, **Commands**, Code Conventions,
   **Chat-Time Output**, and Permissions.
3. Under **Commands**, the user unchecks `/tighten`; the client POSTs, the skill link is
   removed, the snapshot re-renders with `/tighten` off.
4. Under **Chat-Time Output**, the user unchecks "Impact awareness"; the impact-awareness
   rules block is removed from the live `~/.claude/CLAUDE.md`; the snapshot re-renders.
5. Changes take effect the next time the agent harness starts a session.

## Required Rules

- Toggling a command links/unlinks only its backing skill; it does not introduce a separate
  command-install mechanism while every command remains skill-backed.
- Chat-Time Output toggles mutate the user's live config only; the generated base rules
  under `globals/` are changed only by the render pipeline.
- Each Chat-Time Output behavior must be independently toggleable — disabling one must not
  remove the others' rule blocks.
- Rules blocks merge and unmerge by their unique first line (existing `mergeRules` /
  `unmergeRules` contract); each behavior's source must keep a stable, unique first line.
- A fresh install keeps all three Chat-Time Output behaviors on, preserving today's
  always-on default.
- `doctor.sh` must stay green: the three behaviors are generated content today, so removing
  them from base rendering and re-homing them as package rules sources must keep
  `render-rules.sh` output and its drift check consistent.

## Data Integrity And Validation

- **Rule-block identity.** Each Chat-Time Output behavior's rules source needs a unique
  first line so merge/unmerge target the right block. Validate that the three first lines
  are distinct and stable.
- **No double-source.** Once a behavior moves to a package rules component, it must no
  longer render into the base `CLAUDE.md`/`AGENTS.md`, or the block would appear twice and
  unmerge would leave the baked-in copy behind.
- **Snapshot reflects live state.** The panel must read each behavior's enabled state from
  the live config (block present/absent), not from a separate flag that could drift from the
  actual rules file.
- **Commands stay skill-derived.** The Commands section must keep deriving its items from
  the command-backed skills, so a newly added command-backed skill appears automatically.

## Edge Cases

- **User hand-edited CLAUDE.md.** If a user edited or moved a Chat-Time Output block,
  `unmergeRules` already falls back to a first-line anchor and warns rather than corrupting
  the file. Preserve that behavior.
- **Standalone (skill-less) command, future.** No command lacks a backing skill today. If
  one is added later, the Commands section would need a command-only install path (link the
  command file without a skill). Out of scope until such a command exists; note it so the
  section's skill-derived assumption is revisited then.
- **Codex parity.** The three behaviors render into both `CLAUDE.md` and `AGENTS.md` today.
  The `rules` component currently merges into Claude's `CLAUDE.md` only. Re-homing the
  behaviors must decide whether Codex keeps them in base rules or also gets a toggle path,
  so the two harnesses do not silently diverge.
- **Non-TTY onboard.** The terminal flow already falls back to applying defaults headlessly
  when not a TTY; the new section must respect that fallback.

## Implementation Checklist

1. **Commands section.** In `buildBehaviorView()`, split command-backed skills out of
   "Workflows" into a new "Commands" section (relabel + regroup; same skill-link toggle).
   Update the web dashboard and terminal renderers to show the section.
2. **Re-home the three behaviors.** Move the text of `06-skill-visibility.md`,
   `30-session-capture.md`, `35-impact-awareness.md` into per-behavior package rules sources
   under `globals/packages/<behavior>/`, each with a stable unique first line. Stop rendering
   them into the base rules; re-run `render-rules.sh` and confirm `doctor.sh` drift check
   passes.
3. **Define the packages.** Add the three behaviors to `manifests/inventory/packages.json`
   as `rules` components (one package each, or one package with three rules components,
   per Open Decisions).
4. **Chat-Time Output section.** Add the section to `buildBehaviorView()`, reading each
   behavior's enabled state from the snapshot, and render it in both surfaces.
5. **Default-on.** Ensure a fresh install enables all three so behavior is unchanged on
   install.
6. **Decide Codex handling.** Resolve the Codex parity edge case (keep in base vs toggle).
7. **Tests.** Extend `scripts/test/test-roborepo.sh`: Commands section lists command-backed
   skills and the toggle links/unlinks the skill; each Chat-Time Output behavior toggles its
   own rules block independently; disabling one leaves the others; a fresh install has all
   three on; re-render/doctor stays green. Use throwaway temp HOME dirs.
8. **Docs.** Update `docs/user/reference/config-control-panel.md` (the four-section list
   becomes five-plus) and the README behavior sections if the section names change.

## Open Decisions

- **One package or three.** Group the three Chat-Time Output behaviors under one package
  with three independently-toggleable rules components, or three separate packages. Three
  packages give the simplest per-behavior `enable/disable`; one package needs the toggle to
  target a single component, which the current `enable/disable` does not do per-component.
  Leaning three packages.
- **Codex toggle parity.** Whether Codex's copies of the three behaviors also become
  toggleable, or stay in Codex base rules. Affects whether the `rules` component grows a
  Codex/`AGENTS.md` target.
- **Forced refresh.** A future `update --force` could re-assert default-on behaviors if a
  user's live config drifts; not needed for the first cut.

## Success Criteria

- The config panel renders a **Commands** section listing the command-backed skills, each
  toggling its skill link; commands read as commands, not as skills.
- The config panel renders a **Chat-Time Output** section with convention capture, impact
  awareness, and skill visibility, each independently toggleable.
- Toggling a Chat-Time Output behavior adds/removes only that behavior's rules block in the
  user's live config, by its unique first line.
- A fresh install has all three Chat-Time Output behaviors on, matching today's always-on
  default.
- `render-rules.sh` output and `doctor.sh` stay green after the behaviors move off the base
  rules path.
- `scripts/test/test-roborepo.sh` covers the Commands section toggle and per-behavior
  Chat-Time Output toggles against throwaway homes.

## Superseded Approach

This file previously held a five-step numbered onboarding wizard plan: materialize a
user-chosen subset of skills and commands as per-item symlinks, with a new per-category
`items` state map and a multi-select stepper UI. That plan was written before the package
model and config control panel shipped. Three capabilities it set out to build now exist by
other means:

- **Per-item skill links** — `scripts/build/link-skills.sh` links each shared skill
  individually, and `setSkillInstalled()` toggles one skill at a time. The whole-folder
  skills symlink the wizard meant to replace is already gone (`manifest.tsv` carries skill
  `cleanup` rows, not a whole-dir `link`).
- **Per-feature install** — `roborepo enable/disable` installs named features as typed
  components with `requires` composition.
- **One editable surface** — the config control panel renders and mutates from both the web
  dashboard and terminal flow through shared primitives.

The wizard's goal (choose individual behaviors, not whole categories) is therefore met. The
two items in this plan are what genuinely remained.
