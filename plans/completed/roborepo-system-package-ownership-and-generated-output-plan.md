---
id: system-package-ownership-and-generated-output
priority: high
next_action:
blocked_by: []
depends_on: []
related: []
reviewed_commit: 61cf3df
---

## Completion summary

All 8 phases landed in one session on top of the Phase 0 characterization baseline:

- **Phase 1** — moved authored source into `globals/system/`, `globals/harnesses/`, and derived
  output into `generated/`; updated every path-literal consumer (paths.mjs, doctor.sh, manifests,
  installers, tests).
- **Phase 2** — built `scripts/cli/hook-composition.mjs`, a harness-parametrized hook merge/unmerge
  module, wired into `packages.mjs`'s enable/disable switch (previously Claude-only).
- **Phase 3** — moved Caveman's and JDocMunch's Codex `SessionStart` hooks into
  `globals/packages/{caveman,jdocmunch}/hooks-codex.json`; removed the stale
  `caveman@caveman-repo` plugin entry from the Codex baseline.
- **Phase 4** — removed hardcoded JCodeMunch/JDocMunch Codex MCP servers and tool-approval tables
  from the baseline; extended jcodemunch's `codex_tool_approvals` from 1 declared tool to its real
  16-tool set and added a new 16-tool component for jdocmunch (verified byte-for-byte against the
  pre-removal baseline via live enable before deleting it).
- **Phase 5** — moved JCodeMunch's Bash-exploration blocker into
  `globals/packages/jcodemunch/hooks/`, removed its `~/.claude/settings.json` MCP-presence gate
  entirely (redundant once enable/disable controls installation), and added script-file
  install/removal (`installHookScripts`/`removeHookScripts` in hook-composition.mjs).
- **Phase 6** — telemetry now declares `hooks/claude` and `hooks/codex` components; capture hooks
  removed from the committed baseline; `wireCaptureHooks` is a thin wrapper over the shared composer.
- **Phase 7** — slash commands generate per-package
  (`generated/packages/<pkg>/{claude,codex}/commands/`) and compose into live harness dirs only for
  enabled packages; `probeSkill` now verifies command-wrapper presence, not just registry state.
- **Phase 8** — confirmed zero remaining old-path references outside historical docs; updated 16
  current-guidance docs plus 2 active top-level plan docs; repurposed the characterization test file
  in place as a permanent regression suite (every assertion now confirms a fix holds, not a leak).

Bugs found and fixed along the way (all outside the plan doc's original anticipated scope):

- `installHookScripts` was writing through a legacy dir-level symlink straight into the tracked repo
  tree; added a `resolvesIntoRepo` guard.
- `readHooksMap` treated Codex's `{"hooks": []}` empty-array sentinel as a valid map, silently
  dropping writes; normalized to `{}`.
- Telemetry's capture hooks were declared as package components but never actually removed from the
  committed baseline, causing `adoptLivePackages` to false-positive-adopt telemetry on every fresh
  install; removed from baseline.
- `probeSkill`'s new command-wrapper check initially used `observed = cache && commandsPresent`,
  which broke `adoptLivePackages`'s external-package detection; split into `observed` (cache only)
  plus a `blocked` flag for command-wrapper drift on already-desired packages.

Four pre-existing bugs (confirmed via `git stash` comparison against unmodified code, unrelated to
this refactor) remain and were left visible rather than fixed: `--on-conflict keep`/`abort` root-config
handling, and malformed-JSON collision detection in `install-claude.sh`.

Verification: `npm test` (289/289), `npm run test:packages`, `npm run test:plans`,
`npm run pack:dry-run`, `test-install-collisions.sh` (1 known pre-existing failure, unrelated),
fresh-install `verify-install.sh`, `roborepo rules/permissions/skill render-commands --check` all pass.

# RoboRepo System/Package Ownership and Generated Output Refactor

## Status

- **Type:** Architecture and implementation plan
- **Repository:** `kirinmurphy/roborepo`
- **Primary objective:** Separate authored system resources, authored configurable package resources, and generated harness artifacts while ensuring that disabling a package removes all behavior owned by that package.
- **Secondary objective:** Remove optional-package behavior from general Claude and Codex baselines.

## Executive summary

RoboRepo began with individually installed configuration elements. Packages were added later as a user-facing way to select and compose related elements. A package can now contain a skill, rules, hooks, MCP configuration, permissions, plugins, services, CLI commands, and slash-command entrypoints.

The package model should remain user-facing. Mandatory RoboRepo resources should not be wrapped in ceremonial `system` packages merely to make every resource use the same container. Instead, the repository should distinguish three concepts explicitly:

1. **System source** — mandatory behavior RoboRepo always installs.
2. **Package source** — configurable behavior owned completely by a user-selectable package.
3. **Generated output** — native Claude and Codex artifacts composed from system source plus selected package source.

The central architectural rule is:

> Every configurable behavior must be authored entirely within its owning package. System directories may contain only always-installed behavior and generic composition infrastructure.

The related filesystem rule is:

> Authored source and generated harness output must occupy different directory trees.

This plan preserves tracked generated artifacts for now because the Bash, PowerShell, npm, and development-checkout installation paths currently benefit from installation-ready snapshots. Generated files should remain committed and drift-checked, but move out of `globals/` into an unmistakable `generated/` tree.

### Verified against current repo

A codebase pass confirmed most of this plan's factual premises and corrected a few:

- `globals/packages/` **already exists** today, with 17 packages (caveman, jcodemunch, jdocmunch, telemetry, code-style, react, and others), each with `package.config.json` plus resource files. This plan reorganizes an existing directory; it does not create one.
- Installers (`scripts/install/main.sh`, `scripts/install/install-windows.ps1`) are **already manifest-driven** via `manifests/platform/manifest.tsv`. Only two spots hardcode a `globals/` path directly: `install-lib.sh`'s `list_global_skill_sources()` and the equivalent glob in `install-windows.ps1`, both referencing `globals/agents/skills`. These are the only installer edits Phase 1 needs beyond manifest-row updates.
- CI check-mode drift enforcement **already exists**: `scripts/doctor.sh` already runs `render-agent-permissions.mjs --check`, `render-slash-commands.mjs --check`, `render-rules.sh --check`, and `link-skills.sh --check`, and `.github/workflows/ci.yml` already calls `doctor.sh --quiet` on every push/PR. Phase 1 needs to keep these checks pointed at the new `generated/` paths, not build new CI infrastructure.
- Slash-command generation (`scripts/cli/slash-commands.mjs`) **already does marker-based selective install**: it injects a generated marker, refuses to overwrite non-generated files, and prunes only marker-carrying stale files. Phase 7 scopes this per-package; it does not need to build selective generation from scratch.
- Hook ownership has **no existing identity/signature mechanism**: today's merge/unmerge and probing rely on exact string-equality of a hook's literal `command` field, with no package-ID or composite signature. Phase 2's hook-identity work is genuinely new infrastructure, not a refactor of an existing scheme.
- Codex hook composition **does not exist at all** today — `globals/codex/hooks.json` is one static committed file, and the only per-resource writer is telemetry's hardcoded `wireCaptureHooks`. Phase 2/3 build this from scratch.

## Goals

- Make ownership obvious from the filesystem.
- Keep packages as user-facing composition and desired-state units.
- Keep mandatory system resources outside the package catalog and enabled-package registry.
- Ensure one optional package owns its complete implementation across both harnesses.
- Ensure disabled packages do not leave active hooks, MCP servers, plugins, commands, or other behavior behind.
- Separate editable source from generated installation candidates.
- Retain installation-ready generated snapshots until a deliberate release-build migration replaces them.
- Preserve existing local-user configuration, backups, managed blocks, and drift detection.
- Keep development-checkout and npm package modes working.
- Keep Windows structurally supported even though macOS/Linux remain the primary tested platforms.

## Non-goals

- Do not turn mandatory resources into `roborepo-core` or other system packages.
- Do not redesign the user-facing package catalog or configuration portal except where ownership and live-state visibility require changes.
- Do not migrate the portal to React/Vite.
- Do not replace the existing root-config merge and collision system.
- Do not make package enable/disable fully transactional beyond what is necessary for this refactor.
- Do not remove tracked generated output in this implementation. A later `prepack`/release-build change can reconsider that choice.
- Do not combine unrelated user-facing behaviors merely because they share a resource type.

## Definitions

### System resource

A resource RoboRepo requires for baseline operation, safety, installation, or cross-harness management. It is always installed and has no meaningful user-facing enabled/disabled state.

Examples:

- baseline verification guidance
- skill-loading guidance
- temporary-file safety guidance
- the `roborepo-support` skill
- the RoboRepo managed-config write guard
- Codex permission enforcement required to represent the system permission policy
- managed markers and native harness templates

### Package resource

A resource belonging to a behavior the user can select. The package is the unit of composition, desired state, enable/disable, inspection, probing, and repair.

Examples:

- JCodeMunch MCP + rules + hooks + permissions + CLI commands
- JDocMunch MCP + rules + hooks + CLI command
- Caveman rules + Claude plugin + Codex implementation
- Telemetry state + capture hooks + storage/service behavior
- Plan Docs skill + slash-command entrypoint

### Harness template

Authored native configuration structure required to produce a valid Claude or Codex output. Templates contain no optional-package behavior.

Examples:

- stable Codex model/features defaults
- empty/native hook object shape
- Claude settings structure
- managed markers

### Generated artifact

A derived, installation-ready file or directory. It is not edited directly. It is regenerated from system source, harness templates, package source, and platform manifests.

Examples:

- generated Claude/Codex slash-command wrappers
- generated base rules snapshots
- generated permission rules
- generated root-config candidates
- generated hook candidates

## Ownership boundary

Use this decision test for every resource:

1. Can the user disable the behavior?
   - **Yes:** it belongs to a package.
   - **No:** continue.
2. Does RoboRepo need it to install, preserve configuration, enforce baseline safety, or expose system support?
   - **Yes:** it belongs to system source or harness templates.
   - **No:** reconsider whether it should exist or become configurable.
3. Is it derived from another source?
   - **Yes:** it belongs under generated output, regardless of whether the source is system or package-owned.

Rules, hooks, skills, MCP definitions, permissions, plugins, services, and commands are resource types. They do not each warrant their own package. A package exists when the user benefits from selecting the composed behavior as one unit.

## Target repository structure

```text
globals/
  system/
    rules/
      shared/
      claude/
      codex/
    skills/
      roborepo-support/
    hooks/
      claude/
      codex/

  packages/
    caveman/
    jcodemunch/
    jdocmunch/
    telemetry/
    code-style/
    react/
    ...

  harnesses/
    claude/
      settings.template.json
      MANAGED_BY_ROBOREPO.md
    codex/
      config.template.toml
      hooks.template.json
      MANAGED_BY_ROBOREPO.md

generated/
  claude/
    CLAUDE.md
    settings.json
    hooks/
    commands/
  codex/
    AGENTS.md
    config.toml
    hooks.json
    hooks/
    commands/
    rules/
```

Exact filenames can change during implementation, but these boundaries must remain clear:

- `globals/system/` is authored and mandatory.
- `globals/packages/` is authored and configurable.
- `globals/harnesses/` is authored and native-format-specific.
- `generated/` is derived and installation-ready.

## Generated artifact policy

### Initial policy

Generated artifacts remain committed to Git.

Reasons:

- npm packages remain installation-ready without generating on the destination machine
- Bash and PowerShell installers can copy deterministic artifacts
- generated diffs remain reviewable
- CI can prove generated output matches authored source
- package contents remain testable before publishing
- a generator failure cannot produce a partially installed release on the user's machine

### Enforcement

- Every generated file must contain a generated marker where its format permits.
- Documentation must say which command regenerates each artifact.
- CI must run all generators in check mode.
- CI must fail when committed output is stale.
- Application code must not treat generated files as authored sources.
- Tests must not mutate committed generated artifacts without restoring them.

### Future option

A later release-build project may generate artifacts during `npm prepack`, omit them from Git, and include them only in the published tarball. That change is out of scope until release tooling provides equivalent reliability for npm, direct checkout, and Windows installation.

## Current leakage inventory and migration proposals

“Leakage” means optional behavior is authored or verified as part of a general harness baseline rather than being owned completely by its selectable package. Merely having generic package-engine code outside a package is not leakage.

### 1. Caveman Codex SessionStart hook

**Current location**

```text
globals/codex/hooks.json
```

The baseline always contains `CAVEMAN MODE ACTIVE` behavior.

**Concrete problem**

Disabling Caveman does not remove the Codex startup behavior because the package does not own that hook.

**Migration**

- Add `globals/packages/caveman/hooks-codex.json`.
- Declare it as a Codex hook resource in `package.config.json`.
- Extend hook composition to support Codex package hooks.
- Remove Caveman from the authored Codex system hook template.
- Add enable/disable/probe tests proving the hook follows desired package state.

### 2. Caveman Codex plugin entry

**Current location**

```text
globals/codex/config.toml
```

The baseline contains an enabled `caveman@caveman-repo` plugin, while the package declares `caveman@caveman` and the current package plugin path primarily mutates Claude settings.

**Concrete problems**

- Codex Caveman state can remain enabled after package disable.
- The baseline and package use different plugin identifiers.
- Reapplying baseline configuration can restore behavior independently of package state.

**Resolved: hook only.**

The `caveman@caveman-repo` plugin ID in `globals/codex/config.toml` does not even match the package's own declared ID (`caveman@caveman` in `package.config.json`) — it is a stale, broken entry. The Codex SessionStart hook (moved into the package per item 1) is the sole intended Codex-side Caveman mechanism.

**Migration**

- Remove the `caveman@caveman-repo` plugin entry from `globals/codex/config.toml` completely.
- Do not introduce a Codex plugin resource for Caveman.

### 3. JDocMunch Codex SessionStart hook

**Current location**

```text
globals/codex/hooks.json
```

The package declares only a Claude hook fragment.

**Concrete problem**

Codex can continue instructing the user to use JDocMunch after the package is disabled or unavailable.

**Migration**

- Add `globals/packages/jdocmunch/hooks-codex.json`.
- Add a Codex hook resource to the package config.
- Remove the JDocMunch hook from the system Codex hook template.
- Verify enable, disable, reapply, and package probe behavior.

### 4. JDocMunch Codex MCP and tool approvals

**Current location**

```text
globals/codex/config.toml
```

The baseline contains the JDocMunch server and its tool approval sections.

**Concrete problems**

- JDocMunch can be observed live while its package is not desired.
- Disabling it can be reversed by a later baseline merge/apply.
- Package probes can report `external` or partial state immediately after installation.

**Migration**

- Remove all JDocMunch MCP/tool sections from the Codex harness template.
- Ensure the JDocMunch MCP preset owns the complete Codex server and tool-approval configuration.
- Ensure package enable applies it to active Codex config.
- Ensure package disable removes only package-owned entries.
- Ensure root-config merging does not reintroduce removed optional entries.

### 5. JCodeMunch Codex MCP and tool approvals

**Current location**

```text
globals/codex/config.toml
```

**Concrete problems**

- Package-disabled desired state can coexist with an installed MCP server.
- Package enable can become a misleading no-op because the baseline already contains the server.
- Package disable followed by update/apply can restore the server.

**Migration**

- Remove all JCodeMunch MCP/tool sections from the Codex harness template.
- Keep the MCP preset, permissions, approvals, CLI commands, rules, and hooks under the JCodeMunch package.
- Add round-trip tests: disabled baseline → enable → apply → disable → apply remains disabled.

### 5a. Codex config.toml MCP/approval hardcoding duplicates package components

**Current location**

```text
globals/codex/config.toml
```

Verified directly: this file hardcodes full `[mcp_servers.jcodemunch]` and `[mcp_servers.jdocmunch]` server blocks, plus every individual `[mcp_servers.*.tools.*]` approval-mode table for both servers. This exactly duplicates what the package-driven `mcp` and `codex_tool_approvals` component types (`scripts/cli/mcp-codex.mjs`, `scripts/cli/packages.mjs`) already generate at enable-time.

**Concrete problem**

For a fresh install, JCodeMunch's and JDocMunch's MCP server and tool approvals appear in `~/.codex/config.toml` regardless of whether either package is ever enabled through the package registry, making the package-driven `mcp`/`codex_tool_approvals` components largely redundant for these two packages on the Codex side.

**Migration**

- Delete the hardcoded `[mcp_servers.jcodemunch]` / `[mcp_servers.jdocmunch]` blocks and their tool-approval tables from the Codex harness template as part of item 4/5's removal work.
- Confirm the package-driven `mcp` and `codex_tool_approvals` components are the sole source of this configuration after removal.

### 6. JCodeMunch Claude Bash exploration blocker

**Current locations**

```text
globals/claude/hooks/block-source-exploration.mjs
globals/claude/settings.json
```

The system baseline installs and wires a JCodeMunch-specific hook. The hook attempts to no-op when JCodeMunch is unavailable by reading `mcpServers.jcodemunch` from `~/.claude/settings.json`, while RoboRepo otherwise identifies Claude's native MCP live store as `~/.claude.json`.

**Concrete problems**

- The package does not own one of its enforcement mechanisms.
- The availability check may inspect the wrong native configuration location and leave the blocker inactive when JCodeMunch is enabled.

**Migration**

- Move the script to `globals/packages/jcodemunch/hooks/`.
- Make the package hook resource install both the existing `Grep|Glob` blocker and the Bash blocker.
- Remove unconditional wiring from the Claude system template.
- Eliminate the MCP-presence gate if the hook exists only while the package is enabled.
- Add a test showing Bash exploration is blocked when enabled and unaffected when disabled.

### 7. Claude telemetry capture hooks

**Current location**

```text
globals/claude/settings.json
```

Five capture commands are wired regardless of package desired state.

**Concrete problems**

- Disabled telemetry still launches a capture process for configured events.
- Every affected tool call pays process-start/state-check overhead.
- “Disabled” does not mean telemetry hook resources are removed.
- Package probes cannot represent ownership accurately.

**Migration**

Use package-owned hook resources unless measurements justify permanent system instrumentation:

- Add a Claude telemetry hook fragment under the telemetry package.
- Have the telemetry service handler coordinate state/storage while the generic hook-resource path handles hook installation.
- Remove capture hooks on package disable.
- Retain the telemetry-only installation path by invoking the same package-owned hook composer without installing unrelated system resources.

### 8. Codex telemetry capture hooks

**Current location**

```text
globals/codex/hooks.json
```

**Concrete problems**

Same as Claude: capture processes remain wired when telemetry is disabled, and package ownership is ambiguous.

**Migration**

- Add a Codex telemetry hook fragment.
- Install/remove it through Codex hook composition.
- Preserve the telemetry-only installation workflow.
- Verify no capture command remains after package disable unless a separately documented instrumentation mode is selected.

### 9. Dense Bash capture hook — out of scope

**Current location**

```text
globals/claude/hooks/capture-dense-bash.mjs
```

Verified: this file exists but is **not wired** into `globals/claude/settings.json` today — it is dead code, not an active leak.

**Decision**

Treat this file as user-owned configuration outside RoboRepo's authority. This refactor does not move it, wire it, claim ownership of it, or reference it from any package. It is excluded from the leakage inventory and from all migration phases.

### 10. Optional slash commands generated and installed as one directory

**Current locations**

```text
globals/claude/commands/
globals/codex/commands/
```

The generator produces wrappers for every package command, while the installer copies the command directory as a unit.

**Concrete problems**

- A command can remain visible while its package skill is disabled or absent.
- A wrapper may instruct the harness to read a missing `SKILL.md`.
- Package disable does not remove an individual native command wrapper.

**Migration**

Generate package-scoped command candidates:

```text
generated/packages/<package>/claude/commands/<name>.md
generated/packages/<package>/codex/commands/<name>.md
```

During apply, compose only enabled command resources into the live harness command directories. System commands, if any, should be generated separately.

Alternative implementation: retain one all-package validation snapshot but never install it directly. Generate the enabled live command set during apply.

### 11. Platform verification asserts optional-package content unconditionally

**Current location**

```text
manifests/platform/verify-content.tsv
```

**Correction:** every package's `package.config.json` declares `lifecycle: "optional"` — Caveman is not modeled as mandatory anywhere in the package system. The actual bug is narrower: `verify-content.tsv` contains fixed content-match rows (`CAVEMAN MODE ACTIVE` in `hooks.json`/`AGENTS.md`, jcodemunch MCP strings in `config.toml`) that assert unconditionally, with no check of whether the corresponding package is actually enabled in desired state.

**Concrete problem**

A correctly disabled Caveman (or JCodeMunch) package can cause platform verification to report failure, because the verifier has no notion of "only assert this string when package X is enabled."

**Migration**

- Remove unconditional optional-package content assertions from `verify-content.tsv`.
- Any Caveman-specific (or other optional-package-specific) content check must run only when that package is enabled in the desired-state registry.
- Place these checks in package probes or package-specific validation fixtures instead of static content-match rows.
- Audit platform manifests for JCodeMunch, JDocMunch, telemetry, and other optional-package signatures for the same unconditional-assertion pattern.

## Items that are not leakage

Do not move generic implementation merely because it references resource types or delegates to package-specific handlers.

Legitimate platform code includes:

- package catalog parsing and validation
- enable/disable orchestration
- resource-type handlers
- package probes
- MCP native adapters
- rules and command generators
- workspace override validation
- root-config merge and drift machinery
- service-handler registration
- the enabled-package desired-state registry

This code implements package mechanics. It does not independently activate optional behavior.

## Proposed composition architecture

### Source layers

```text
system authored resources
+ native harness templates
+ resources from desired/enabled packages
+ preserved user-owned native configuration
= generated or live native harness configuration
```

### Output distinction

Two generated forms are needed:

1. **Release/base artifacts** — deterministic snapshots that contain system behavior and empty package insertion points. These are committed and shipped.
2. **Machine live artifacts** — base artifacts composed with that machine's enabled package registry and preserved local configuration.

Release/base artifacts must contain no optional-package behavior.

### Root configuration

Root config is shared ownership. Do not replace the existing merge model. Instead:

- Generate a clean system-only candidate.
- Apply enabled package mutations to the active machine configuration through owned sections/resources.
- Record ownership sufficiently to remove package-owned entries without removing user-owned entries.
- Ensure later application of the system candidate cannot restore disabled optional entries.

### Hooks

Introduce one hook composition interface for both harnesses, even though hook bodies remain harness-specific.

Required operations:

- read system hook template
- collect hook resources from enabled packages
- preserve unrelated user hook entries
- deduplicate owned commands deterministically
- write active hook configuration
- remove disabled package hooks by ownership/signature
- probe desired versus observed hook state

Do not attempt to share Claude and Codex hook bodies. Share the ownership/composition lifecycle only.

### Commands

Treat slash commands as package-owned installed resources, not one platform-wide bundle.

- Command definitions remain in package configs.
- Wrapper templates remain generated.
- Only enabled package commands are installed live.
- Disable removes only wrappers marked as generated and owned by that package.
- User-authored native commands remain untouched.

## Implementation phases

## Phase 0 — Record invariants and add characterization tests

Before moving files, capture current behavior and desired corrections.

### Work

- Add tests that demonstrate current leakage cases without immediately changing implementation.
- Add explicit ownership expectations for every system and package resource.
- Add a machine-readable or test-local inventory mapping current paths to intended owners.
- Confirm current behavior in both development and package mode.

### Required characterization tests

- Caveman disabled but Codex hook currently present.
- JDocMunch disabled but Codex hook currently present.
- JCodeMunch/JDocMunch disabled but Codex baseline MCP entries present (including the hardcoded tool-approval tables, item 5a).
- Telemetry disabled but capture hooks present.
- Disabled command package but wrapper installed.
- JCodeMunch Bash hook checks the actual Claude MCP location.
- Caveman disabled but `verify-content.tsv` still asserts `CAVEMAN MODE ACTIVE` unconditionally (item 11).

Not in scope for characterization: `capture-dense-bash.mjs` (item 9) is out of scope entirely — do not write a test asserting its wiring state.

### Exit criteria

- Each confirmed issue has a failing test or a documented intentional exception.
- No migration begins with uncertain ownership.

## Phase 1 — Introduce source and generated directories

This phase is structural and should not intentionally change live behavior.

### Work

- Create `globals/system/`.
- Move base rule fragments into `globals/system/rules/`.
- Move `roborepo-support` into `globals/system/skills/`.
- Create `globals/harnesses/` and move native authored templates/markers there.
- Create `generated/claude/` and `generated/codex/`.
- Move tracked generated rules, commands, permission outputs, and native candidates under `generated/`.
- Update manifest paths, package file allowlists, installers, doctor, verify, and documentation.
- Update all generators to write only under `generated/` or explicit live home paths.
- Update generated headers to point to their actual authored source.

### Compatibility

- Add cleanup/migration rows for stale paths only where live installations reference old repository paths.
- Preserve existing home files and collision behavior.
- Ensure npm package contents include both authored runtime sources and generated release artifacts.

### Exit criteria

- `globals/` contains authored source only.
- `generated/` contains derived output only.
- Development and package installers pass without feature behavior changes.
- Generated drift checks pass.

## Phase 2 — Build cross-harness hook composition

### Work

- Generalize current Claude hook merge/unmerge behavior into a harness-aware module.
- Support package hook resources for Codex.
- Define stable hook identity based on package ID plus event/matcher/command signature.
- Preserve unrelated native user hooks.
- Add dry-run output and package probes.
- Ensure repeated apply is idempotent.

### Exit criteria

- A test package can install and remove Claude and Codex hooks independently.
- Reapply produces no duplicates.
- User hooks survive enable, disable, and update.

## Phase 3 — Move Caveman and JDocMunch Codex hooks

### Work

- Move Caveman Codex SessionStart behavior into its package.
- Resolve the Caveman Codex plugin-versus-hook decision.
- Move JDocMunch Codex SessionStart behavior into its package.
- Remove both from the system hook template.
- Move their verification assertions into package probes.

### Exit criteria

- Disabled Caveman produces no Caveman Codex startup behavior.
- Disabled JDocMunch produces no JDocMunch Codex startup behavior.
- Enable/disable/reapply round trips remain stable.

## Phase 4 — Remove optional MCP configuration from Codex baseline

### Work

- Remove JCodeMunch and JDocMunch servers/tool approvals from the system Codex template.
- Confirm MCP presets contain the complete desired native configuration.
- Ensure package enable applies server and approval state.
- Ensure package disable removes only package-owned MCP configuration.
- Ensure baseline/root-config merge cannot restore disabled servers.
- Update package probes and portal reporting.

### Exit criteria

- Clean base installation contains neither optional MCP server.
- Each package independently round-trips through enable, apply, disable, apply.
- `external`, `missing`, and `present` probe states are accurate.

## Phase 5 — Complete JCodeMunch hook ownership

### Work

- Move the Bash exploration blocker into the JCodeMunch package.
- Compose it with the existing Claude JCodeMunch hooks.
- Remove system wiring.
- Remove the questionable settings-based MCP gate.
- Confirm behavior with real native Claude MCP registration shape.

### Exit criteria

- No JCodeMunch-specific hook source or wiring remains in system directories.
- Enabled package enforces intended exploration policy.
- Disabled package leaves ordinary Bash exploration unaffected.

## Phase 6 — Make telemetry ownership explicit

### Decision gate

Measure disabled telemetry hook overhead before finalizing the implementation. Unless permanent instrumentation has a demonstrated benefit that outweighs the cost, use package-owned hooks.

### Preferred work

- Move Claude and Codex capture hook declarations into the telemetry package.
- Make telemetry enable install hooks and enable state/storage.
- Make telemetry disable remove hooks and disable collection.
- Preserve `roborepo telemetry install` by using the same telemetry-owned source and composer.
- Do not move `capture-dense-bash.mjs` — it is out of scope (item 9) and stays as user-owned configuration untouched by this refactor.

### Exit criteria

- Disabled telemetry executes no capture process.
- Enabled telemetry captures all intended events.
- Telemetry-only install and full install use one canonical hook definition.
- Portal and CLI report hook and service state accurately.

## Phase 7 — Make commands package-scoped

### Work

- Generate wrappers with package ownership metadata.
- Stop installing the complete all-package command directory.
- Compose live command directories from system commands plus enabled packages.
- Remove disabled generated wrappers while preserving user-native commands.
- Update `skill render-commands --check` to validate package-scoped generated outputs.
- Update package probes to inspect actual native wrapper presence.

### Exit criteria

- Disabled packages expose no native slash command.
- Enabled package commands always resolve to an installed skill or standalone source.
- Disabling one package does not remove another package's or the user's commands.

## Phase 8 — Remove compatibility paths and reconcile documentation

### Work

- Remove obsolete `globals/agents/`, `globals/rules/`, and old harness-output paths after all consumers move.
- Retain explicit cleanup handling only for existing live installations that need it.
- Update architecture, harness anatomy, collision handling, hook docs, package docs, and distribution docs.
- Mark older completed plans as historical where their paths no longer describe current behavior.
- Update README maintenance guidance.

### Exit criteria

- Repository search finds no active code or current docs pointing to obsolete paths.
- Historical documents are clearly labeled and are not used as current source of truth.
- Installation, update, repair, uninstall, doctor, verify, and npm smoke tests pass.

## Detailed file migration map

| Current path | Target classification | Proposed target |
|---|---|---|
| `globals/rules/shared/*` | System source | `globals/system/rules/shared/*` |
| `globals/rules/claude/*` | System source | `globals/system/rules/claude/*` |
| `globals/rules/codex/*` | System source, after content review | `globals/system/rules/codex/*` |
| `globals/agents/skills/roborepo-support` | System source | `globals/system/skills/roborepo-support` |
| `globals/claude/MANAGED_BY_ROBOREPO.md` | Harness source | `globals/harnesses/claude/MANAGED_BY_ROBOREPO.md` |
| `globals/codex/MANAGED_BY_ROBOREPO.md` | Harness source | `globals/harnesses/codex/MANAGED_BY_ROBOREPO.md` |
| `globals/claude/settings.starter.json` | Harness source | `globals/harnesses/claude/settings.starter.json` |
| `globals/codex/config.starter.toml` | Harness source | `globals/harnesses/codex/config.starter.toml` |
| `globals/claude/CLAUDE.md` | Generated | `generated/claude/CLAUDE.md` |
| `globals/codex/AGENTS.md` | Generated | `generated/codex/AGENTS.md` |
| `globals/claude/commands/*` | Generated package output | `generated/packages/<owner>/claude/commands/*` |
| `globals/codex/commands/*` | Generated package output | `generated/packages/<owner>/codex/commands/*` |
| `globals/claude/settings.json` | Generated system candidate | `generated/claude/settings.json` |
| `globals/codex/config.toml` | Generated system candidate | `generated/codex/config.toml` |
| `globals/codex/hooks.json` | Generated system candidate | `generated/codex/hooks.json` |
| `globals/codex/rules/default.rules` | Generated permission output | `generated/codex/rules/default.rules` |
| `globals/claude/hooks/roborepo-write-guard.mjs` | System source | `globals/system/hooks/claude/roborepo-write-guard.mjs` |
| `globals/codex/hooks/permission-check.mjs` | System source | `globals/system/hooks/codex/permission-check.mjs` |
| `globals/*/hooks/minimize-bash-output.mjs` | System or package source, explicit decision | `globals/system/hooks/<harness>/` if mandatory |
| `globals/claude/hooks/block-source-exploration.mjs` | JCodeMunch package source | `globals/packages/jcodemunch/hooks/` |
| `globals/claude/hooks/capture-dense-bash.mjs` | Out of scope — user-owned, unwired today | unchanged; not moved by this refactor |

## Manifest and installer changes

### `manifests/platform/source-files.tsv`

- Replace old `globals/` generated paths with `generated/` paths.
- Add required authored system/harness directories.
- Keep package discovery dynamic rather than listing every package file.

### `manifests/platform/manifest.tsv`

- Point managed copies and root-config candidates at `generated/`.
- Keep `rendered_rules` behavior for live managed blocks if live rules continue to be generated directly.
- Add cleanup rows only for stale live symlinks/copies from older versions.

### `manifests/platform/verify-content.tsv`

- Keep only system assertions.
- Remove Caveman and other optional-package signatures.
- Route optional checks through package probes.

### `package.json`

- Include `generated/`, `globals/system/`, `globals/packages/`, and `globals/harnesses/`.
- Remove obsolete authored/output paths after migration.
- Keep `pack:dry-run` and packed-install smoke coverage.

### Bash and PowerShell installers

- Consume generated release artifacts through manifest paths rather than hard-coded directories.
- Preserve collision, backup, root-config merge, and drift behavior.
- Confirm Windows path parsing supports the new tree.

## Backward compatibility and migration

### Existing repository-mode users

- `roborepo update` must migrate installed managed copies without replacing user-owned native files.
- Old repo-backed symlinks should be reclaimed when their targets match known old generated paths.
- Existing package registry desired state remains authoritative.

### Existing package-mode users

- npm upgrade changes `appRoot`, but `workspaceRoot` and `stateRoot` remain stable.
- Applying the new release should remove optional behavior no longer desired, not adopt it merely because it existed in the previous baseline.
- Migration may need a one-time ownership reconciliation for optional baseline entries.

### One-time reconciliation policy

For each previously leaked resource:

- If its package is enabled in desired state, preserve/recompose it as package-owned.
- If its package is disabled or absent from desired state, remove it only when it exactly matches the old RoboRepo baseline signature.
- Preserve modified or ambiguous entries and report them as external/drifted rather than deleting them.

This prevents migration from deleting user-authored configuration that resembles an old built-in.

## Testing plan

## Unit tests

- source classification and path resolution
- generated output destinations
- package hook merge/unmerge for both harnesses
- hook identity and deduplication
- system-only root candidate generation
- package-owned MCP insertion/removal
- command wrapper ownership and pruning
- optional verification checks excluded from platform verification

## Integration tests

For Caveman, JCodeMunch, JDocMunch, and telemetry:

1. Start with clean system-only generated candidates.
2. Assert package resources are absent.
3. Enable the package.
4. Assert all declared resources are present.
5. Reapply and assert no duplication.
6. Disable the package.
7. Assert all owned resources are absent.
8. Reapply and assert they remain absent.
9. Assert unrelated user config remains unchanged.

## Command tests

- Disabled skill-backed package has no wrapper.
- Enabled package has wrapper and skill.
- Disabling removes only its generated wrapper.
- User-authored command with a different name survives.
- Collision handling prevents overwriting a non-generated command.

## Migration tests

- Old Caveman baseline hook + enabled registry becomes package-owned.
- Old Caveman baseline hook + disabled registry is removed when unchanged.
- Modified old hook is preserved and reported external.
- Old MCP entries follow the same exact-match policy.
- Existing root-config hashes and backups remain valid or migrate deterministically.

## Installer matrix

- macOS development checkout
- macOS npm/package mode
- Linux development checkout
- Linux npm/package mode
- Windows structural installer checks
- isolated `HOME`, `stateRoot`, and `workspaceRoot`
- fresh install
- update from previous layout
- repair
- uninstall
- npm packed-tarball install

## Required verification commands

Use repository-native commands as they exist after the refactor:

```sh
npm test
npm run test:packages
npm run pack:dry-run
./scripts/test/test-install-collisions.sh
./scripts/doctor.sh
./scripts/verify-install.sh
```

Add focused generator checks if they are not covered by `npm test`:

```sh
roborepo rules --check
roborepo permissions --check
roborepo skill render-commands --check
```

## Portal and CLI implications

### Config portal

- System sections should read from `globals/system/` and generated system previews.
- Package cards should enumerate complete package-owned resources across both harnesses.
- Package observed state should no longer count system-baseline leakage as enabled.
- Drift states should distinguish `present`, `missing`, `external`, and `blocked` consistently.

### CLI

- `roborepo package inspect` should show every owned native resource.
- `roborepo package enable/disable` should compose/remove complete package behavior.
- `roborepo config status` should not infer enabled state from leaked baseline content.
- `roborepo doctor --installed` should verify system resources plus desired packages.
- `roborepo verify` should not require optional packages.

## Documentation updates

Update these current documents after implementation:

- `README.md`
- `docs/user/reference/architecture.md`
- `docs/internal/harness-anatomy.md`
- `docs/internal/harnesses-explained.md`
- `docs/internal/rules-parity-and-layering.md`
- `docs/user/reference/config-collision-handling.md`
- `docs/user/reference/claude-hooks.md`
- `docs/user/reference/codex-hooks.md`
- `docs/user/reference/jcodemunch.md`
- `docs/user/reference/jdocmunch.md`
- `docs/user/reference/roborepo.md`
- `docs/user/guides/install-workflows.md`
- `docs/architecture/config-code-separation.md`
- `docs/architecture/manifest-and-symlinks.md`

Documentation must clearly state:

- packages are user-facing configurable composition units
- system resources are mandatory but not packages
- package resources are authored only inside their owning package
- generated repository artifacts are tracked installation candidates, not sources of truth
- live harness files are composed from system source, enabled packages, and preserved user config

## Risks and controls

### Risk: moving paths breaks installers

**Control:** update manifest-driven paths first, retain compatibility cleanup, and test all install modes before removing old paths.

### Risk: migration deletes user configuration

**Control:** remove old leaked resources only on exact known-signature matches. Preserve ambiguous changes as external/drifted.

### Risk: generated files become stale

**Control:** committed generated artifacts plus mandatory CI check mode.

### Risk: package disable removes shared hook entries

**Control:** stable package ownership metadata/signatures and exact entry-level removal, never event-level replacement.

### Risk: package state and native state diverge during partial failure

**Control:** improve probes first, report partial state, and keep operations idempotent. Full transactions remain a later project.

### Risk: telemetry-only installation forks behavior

**Control:** make standalone telemetry installation call the same canonical telemetry hook composer and source files.

### Risk: system/package distinction becomes subjective

**Control:** enforce the ownership decision test and require every new resource to declare whether the user can disable its behavior.

## Recommended implementation order

1. Add characterization tests and confirm the listed concrete failures.
2. Separate authored and generated paths without changing behavior.
3. Add Codex package-hook composition.
4. Move Caveman and JDocMunch Codex hooks into packages.
5. remove optional MCP entries from the Codex baseline.
6. Move all JCodeMunch enforcement under its package.
7. Make telemetry hook ownership explicit and remove disabled overhead.
8. Make slash-command installation package-scoped.
9. Add one-time migration/reconciliation for old leaked resources.
10. Remove obsolete paths and update current documentation.

This order addresses confirmed user-facing state errors before lower-risk organizational cleanup, while establishing the source/generated boundary early enough that later migrations land in the final structure.

## Definition of done

- `globals/system/` contains only mandatory authored behavior.
- `globals/packages/` contains the complete authored implementation of every configurable behavior.
- `globals/harnesses/` contains native templates with no optional-package behavior.
- `generated/` contains all tracked derived installation candidates.
- No optional MCP server, plugin, hook, command, rule, permission, or service wiring exists in a system baseline.
- Disabling Caveman, JCodeMunch, JDocMunch, or telemetry removes all package-owned active behavior from both harnesses.
- Reapplying configuration does not restore disabled packages.
- Disabled skill-backed workflows expose no broken slash commands.
- Platform verification passes with every optional package disabled.
- Package probes accurately report desired and observed state.
- User-owned hooks, root config, commands, profiles, and unrelated MCP servers survive enable, disable, update, repair, and migration.
- Generated artifacts are current and CI drift checks pass.
- Development checkout, npm/package mode, packed-install smoke tests, and Windows structural checks pass.
- Current documentation reflects the new ownership and filesystem model.

