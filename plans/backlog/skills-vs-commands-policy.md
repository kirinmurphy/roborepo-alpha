---
id: skills-vs-commands-invocation-policy
next_action: Check whether current Codex loads anything from ~/.codex/commands, then choose how each provider exposes manual workflows and stop generating Codex wrappers that nothing loads.
blocked_by: []
depends_on: []
related: ["harness-parity-todo", "0jped168", "o9zwxuav", "plans-portal-live-refresh-and-static-preflight"]
reviewed_commit: 57f8f2199b6db87d829af8d41e387800518024c9
---

# Skills vs. Commands: Invocation & Risk Policy

## Summary

Finish skill activation and native invocation policy using the shipped package/resource control
plane. Settle command presentation, expand trigger evidence, and define the remaining local/global
precedence boundary before changing how users invoke workflows.

This plan also owns the cross-package Codex correction: RoboRepo generates and installs Codex
slash-command wrappers into a directory that current Codex may not read. The Plans portal's static
command help ([[plans-portal-live-refresh-and-static-preflight]]) waits on this decision.

## Context

Skill/slash-command resources, invocation/risk metadata, command rendering, `roborepo skill audit`,
`roborepo skill triggers`, and manual-entrypoint validation already exist. Their implementation is
in `scripts/cli/package-catalog.mjs`, `skill-trigger-check.mjs`, `skill-trigger-fixtures.mjs`, and
`slash-commands.mjs`. Current behavior is documented in `docs/internal/skills-and-commands.md`.

Static trigger fixtures establish description/phrase consistency, not actual model selection.
[[0jped168]] owns repeatable live-agent evals. Codex's declared commands directory and the old
assumption that it lacks skill discovery need native verification; generating wrappers does not
prove discoverability.

### Codex command wrappers

Every package with a skill-backed slash command also gets a Codex wrapper:

| Fact | Source |
| --- | --- |
| The Codex provider declares a commands directory, `~/.codex/commands` | `globals/harnesses/codex/provider.json` |
| Wrappers are generated and tracked for Codex as well as Claude | `generated/packages/plan-suite/codex/commands/` (7 files), `generated/packages/case-study-pack/codex/commands/case-study.md` |
| Rendering and install paths come from the command renderer | `scripts/cli/slash-commands.mjs`, `scripts/cli/skill-command-config.mjs` |

Tests prove only that these files are generated and copied. An earlier investigation reported that
Codex does not scan `~/.codex/commands`, and that manual skill invocation in Codex is `$<skill>` or
`/skills`. It also reported that `~/.codex/prompts` is deprecated and shows entries as
`/prompts:<name>`, so moving wrappers there is not a fix. None of this has been rechecked against
a current Codex version.

## Goals

- Make activation conditions precise and backed by representative examples.
- Give manual entry points a provider-correct, discoverable native representation.
- Preserve the distinction between safe helper activation and explicit high-impact workflows.
- Give repository/global precedence one explicit policy owner.

## Proposed design

Keep package resources as the source for invocation intent and risk; use provider adapters for
native delivery and metadata. Keep auto helpers scoped by description. A workflow that requires
an explicit request must not be made auto-invokable merely to fix command visibility.

### Command presentation decision

Reproduce current skill-backed command listing and invocation with supported native versions before
choosing among these alternatives; the old package counts and “Codex-only shim” rationale are stale.

| Option | Benefit | Tradeoff to verify |
| --- | --- | --- |
| Accept native duplication | Preserves current entry paths | Users may see two descriptions for one workflow |
| Align descriptions | Makes duplicate entries recognizable | Trigger conditions and workflow summaries serve different purposes |
| Label aliases | Preserves distinct descriptions | Adds presentation noise; provider support may differ |
| Deliver only the required native entry | Removes redundant wrappers | Must prove manual invocation remains available on each provider |

For Codex, the last option is forced if Codex is confirmed not to read `~/.codex/commands`: Codex
gets no wrappers, and its manual entry is the installed skill, invoked as `$<skill>`. The
`slash-command` entrypoint then accepts only harnesses with a verified command directory, and a
skill that must not run implicitly sets `policy.allow_implicit_invocation: false` in its
`agents/openai.yaml`. The table's choice stays open for Claude.

### Repository and global precedence

This plan owns the unresolved decision formerly tracked by [[harness-parity-todo]]. Determine how
native repository resources supplement/override global ones and which managed changes need user
opt-in. `roborepo skill link-project` does not establish a universal override policy. Inventory
precedence per provider, compare automatic overrides with explicit opt-in, and present the real
tradeoff before selecting product behavior.

## Implementation plan

- [ ] Reproduce listing/manual invocation on supported provider versions, including whether Codex
      reads `~/.codex/commands`, and choose command presentation.
- [ ] If Codex does not read it: stop rendering Codex wrappers, and stop package status from
      reporting a Codex wrapper as installed. Codex's provider declares the `slash-commands`
      capability, and `roborepo package dev create` gives a new command to every harness that has
      it, so removing that capability from Codex may be the whole fix; otherwise reject or warn on a
      `codex` `slash-command` entrypoint in package validation.
- [ ] On update and repair, remove only RoboRepo-generated wrappers from `~/.codex/commands`
      (files carrying the generated marker), report other files there as unmanaged, and never
      delete the directory.
- [ ] Correct docs and portal labels that imply Codex command parity, showing `/<name>` for Claude
      and `$<name>` for Codex.
- [ ] Expand trigger fixtures beyond the initial risk set and tune descriptions when real
      examples expose over-broad or missing conditions; keep sibling-workflow near misses.
- [ ] Audit risk and activation classifications for security-sensitive and persistent workflows.
      Preserve native plugin/MCP/memory ownership rather than forcing every feature into a skill.
- [ ] Add native manual-only metadata only for deliberately converted workflows and only after
      each provider's actual support is verified.
- [ ] Inventory repository/global loading with versioned evidence and choose an explicit policy
      for managed overrides, preserving unknown behavior as unknown.
- [ ] Document provider-specific invocation and override boundaries, then remove redundant wrappers
      only when installed-runtime tests prove the surviving entry point works.

## Validation

Codex wrapper checks, written to fail before the change: no Codex wrapper is generated or
installed for a skill-backed command; the Claude wrapper still is; package status shows `/<name>`
for Claude and `$<name>` for Codex; repair removes only marked wrappers and leaves a user file in
place. Run
`roborepo skill audit --check`, `roborepo skill triggers --check`,
`roborepo skill render-commands --check`, and the relevant package/skill checks. Validate runtime
manual discovery separately from generated-file existence. Compare representative auto matches,
near misses, explicit workflows, native metadata, and repository/global resources. Implemented
shared provider/package changes require `npm run check` before handoff.

## Documentation impact

Update `docs/internal/skills-and-commands.md`, `docs/internal/skill-invocation-audit.md`, and
`docs/user/reference/roborepo-skills.md` with chosen invocation and precedence behavior.

## Open questions

- Which duplicate-listing option preserves native discovery with the least user confusion?
- Which skills need deliberate risk/invocation changes rather than description improvements?
- How much repository override is automatic versus explicitly opted into?
