---
id: harness-parity-todo
priority: low
next_action:
blocked_by: []
depends_on: []
related: [skills-vs-commands-invocation-policy, o9zwxuav]
reviewed_commit: b8684ef
---

# Harness Parity Across Providers

Backlog of cross-harness parity work. Revised 2026-07-16 after native-alignment,
portable-install/repair, telemetry lifecycle, unified package configuration, and the
skills-vs-commands package resource model landed — several original items are now done or have
moved to dedicated plans. What remains here is the parity work those efforts did **not** cover.

## Resolved Since This Doc Was Written

These were open items here and are now shipped — kept as a short ledger so the
backlog reads honestly.

- **Per-repo skill installer — DONE.** Exposed as `roborepo skill link-project`
  (`scripts/cli/skills.mjs::skillLink` → `linkLocalSkills` in `skill-lib.mjs`).
  Links a target repo's `.codex/skills` into `.claude/skills` without losing global
  skill parity. (Originally listed under the stale name `skill symlink-local`.)
- **Skill / plugin / MCP / memory native alignment — DONE** (see
  [`native-alignment.md`](../completed/native-alignment.md)).
  Skills now use each harness's native dir (`~/.claude/skills`, `~/.codex/skills`)
  instead of the invented `~/.agents` path; package-gated global skills are copied into
  those dirs by install/update, while project-local skills still use repo-local symlinks.
  Claude MCP servers are version-controlled in `manifests/inventory/mcp-servers.json` and
  re-applied by `update`, symmetric with Codex; plugins are documented Claude-only; native
  memory is a documented Defer surface. This closed most of the "two source-of-truth stores"
  parity gaps that motivated this backlog.
- **Relocation / repair — DONE** (see
  [`completed/portable-install-relocation.md`](../completed/portable-install-relocation.md)).
  `roborepo repair` relinks a moved checkout; uninstall and the bin-link heal handle
  stale prior-checkout links. This was part of the original "redesign the
  managed/adopt/update installer" item.
- **Copy/render materialization + package-gated install — DONE** (see
  [`completed/package-gated-install.md`](../completed/package-gated-install.md)).
  Home rules are rendered from fragments plus the enabled package registry; shared skills are copied
  with `.roborepo-managed` markers; optional packages gate rules/hooks/permissions/MCP/skills.
- **Placement of global coding conventions — RESOLVED.** Decision: conventions live
  in auto-invokable **helper skills** (`code-style`, `javascript-typescript`,
  `react`), not in always-on global rules. The candidate rule topics from the
  original item (named exports, helpers at file bottom, `function` for pure utilities,
  no procedural comments, constants over loose status strings, no emoji in UI) are
  covered by package-owned `code-style` and language skills. The
  auto-vs-manual policy for these is governed by
  [`agent-config-skills-vs-commands-policy.md`](agent-config-skills-vs-commands-policy.md)
  and recorded on package `skill` resources.

## Open Parity Work

### Recommended Next Pick

For immediate product value, start with
[`package-desired-state-and-dependencies.md`](package-desired-state-and-dependencies.md):
it resolves the portal's ambiguous enabled/installed/partial states across rules,
plugins, services, skills, MCP, and permissions.

Start with
[`agent-config-skills-vs-commands-policy.md`](agent-config-skills-vs-commands-policy.md)
if the next work should improve agent behavior predictability with smaller,
testable pieces.

### 1. Root-config drift detection (shipped 2026-07-07)

Was the largest remaining parity gap: native-alignment aligned the *runtime stores*
(skills, MCP, plugins, memory) but not how `~/.claude/settings.json` and
`~/.codex/config.toml` themselves are handled across installs.

The proposed *overlay* design (repo baseline + machine overlay + generated active
file + project-local override) was **dropped** — an overlay can't keep its promise
once a user hand-edits the real file or a native harness flow writes to it. What
shipped instead is honest **drift detection**: roborepo records a content hash of what
it last wrote per harness and, on the next install/update/repair/uninstall, compares
the on-disk file to that hash. A clean file (baseline moved on, no local edit) updates
silently; a drifted file (edited since roborepo's last write) is never silently merged
or deleted — it is surfaced and staged using the same collision convention install
already uses. See [`completed/root-config-layered-inheritance.md`](../completed/root-config-layered-inheritance.md)
(full design + implementation status) and
[`../user/reference/config-collision-handling.md`](../../user/reference/config-collision-handling.md).

Delivered across all three install paths (`presets.mjs`, `install-lib.sh`,
`install-windows.ps1`), plus `roborepo config root inspect`, uninstall drift-awareness,
a `/config` portal drift chip, and Codex native-profile docs as the recommended path
for a permanent personal config slice (Claude has no native equivalent).

### 2. Local-vs-global override policy (open decision)

How much should repo-local config override global behavior automatically versus by
explicit user opt-in? This also overlaps the per-repo skill story
(`skill link-project`), which already lets a repo add skills without overriding
global ones.

### 3. Stack-specific context shape (largely decided — confirm and close)

Original open question: should stack-specific context be skills, rules, or rules that
trigger skills? The de-facto answer is now **auto-invokable helper skills, gated by
description** (react, javascript-typescript, supabase-integration-testing, …), with
always-on rules reserved for short cross-cutting guidance. This is the operating
model of [`agent-config-skills-vs-commands-policy.md`](agent-config-skills-vs-commands-policy.md).
Remaining work is to *finish* that policy's control plane (trigger tests, the
skill-audit generator, and any manual-only rendering) rather than re-decide the
shape — track it there, not here.

## Cross-References

- [`native-alignment.md`](../completed/native-alignment.md) — runtime-store parity (skills, MCP,
  plugins, memory); complete.
- [`completed/package-gated-install.md`](../completed/package-gated-install.md) —
  copy/render materialization, package-gated optional behavior, rendered home rules, and update
  reporting; complete.
- [`agent-config-skills-vs-commands-policy.md`](agent-config-skills-vs-commands-policy.md)
  — how context (rules / skills / commands) enters each harness; owns item 3.
- [`completed/portable-install-relocation.md`](../completed/portable-install-relocation.md)
  — relocation/repair, shipped.

## Archived

2026-10-22: Superseded as an umbrella: package-state work is owned by o9zwxuav; native invocation and the preserved unresolved repository/global override decision are owned by skills-vs-commands-invocation-policy. Shipped parity history remains here.
