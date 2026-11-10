---
id: package-gated-install
priority: none
next_action:
blocked_by: []
depends_on: []
related: []
reviewed_commit:
---

# Copy-Everything Materialization

> **Status: completed.** Phases 1-5 shipped. This file is archived as the implementation record for
> the copy/render materialization model, package-gated optional behavior, rendered home rules, and
> `roborepo update` change report. Current behavior lives in the install and architecture guides.

## Purpose

The install model couples three unrelated decisions under one "managed vs adopt" mode,
and the mode only meaningfully governs one of them. That confusion surfaced while trying
to make optional behavior (jcodemunch, skills, telemetry) install only when onboarding
enables it: base install front-loads skills and MCP servers and bakes package policy into
base rules, so onboarding chooses among behaviors that are already live. Fixing that
cleanly requires settling how config is materialized onto a machine. This doc records the
decision and the phased plan to implement it.

## Decision

Materialize all config onto the machine by **copy or render — never symlink — and drop the
managed/adopt mode entirely.** The repo (or, later, an npx/brew package) is only the
source the installer reads to produce machine state; it does not need to persist, and no
home file points back into it.

Each layer materializes by its nature, unconditionally:

- **Skills** → copied into `~/.claude/skills/` and `~/.codex/skills/`.
- **Rules** (`CLAUDE.md` / `AGENTS.md`) → rendered into the home files from
  `base fragments + enabled-package fragments`.
- **Root config** (`settings.json` / `config.toml`) → copied, with conflict reconciliation
  (`--on-conflict keep|overwrite`, default `keep`) — the one layer a human authors on the
  machine, and the only one where a merge conflict can exist.

`roborepo update` re-reads source, re-materializes every layer, and **reports what
changed** so updates are explicit rather than silent.

## Why

- **The mode only ever governed root config.** Skills symlinked regardless of mode; rules
  are generated; only root config had a real copy/merge choice. A "mode" that changes one
  of three layers is a label stretched over things it does not govern.
- **Symlinks assume a permanent repo on the machine.** Their advantages (no drift, live
  edits, `git pull` updates) all depend on the source staying put. Under npx (ephemeral
  cache) or brew (versioned cellar replaced on upgrade), a symlink into the source becomes
  a dangling or broken link. Copy is the only materialization that behaves identically
  across clone, npx, brew, and tarball.
- **Copy is distribution-agnostic.** Choosing it now means a future repo-less distribution
  is a packaging change, not an architecture change.
- **One pattern emerges.** "Symlink pointers, render derivations, reconcile authored
  state" becomes simply "materialize source → machine; update is explicit." No per-mode
  branching, no symlink-vs-copy fork.

## Alternatives Considered

- **Per-artifact symlink/render/copy (keep managed/adopt).** Skills stay symlinks, rules
  render, root config copies. Rejected: keeps the mode, which only governs root config, and
  keeps symlinks that break under repo-less distribution.
- **Symlink home rules to a generated, gitignored in-repo file.** Preserves a literal
  symlink and avoids writing tracked source. Rejected: a symlink buys nothing for a
  generated file (no live-edit value), and it still depends on the repo persisting.
- **Two files via `@import` (Claude) / second rules path (Codex).** Base rules stay a fixed
  symlink; package rules live in a separate imported file. Rejected: depends on
  harness-specific import features that are asymmetric (Claude `@import` vs Codex's
  command-only `~/.codex/rules`) and unverified for Codex.
- **Append package rules into the live `CLAUDE.md` (current mechanism).** Rejected: in the
  managed symlink case it writes through to tracked repo source, and disable relies on
  fragile text-block removal (`unmergeRules` has a "block drifted — leaving in place"
  failure mode).

## Target Model

- The repo `globals/` tree and `manifests/` remain the **source**. Build-time render keeps
  the tracked baseline `globals/claude/CLAUDE.md` / `globals/codex/AGENTS.md` (drift-checked
  by `render-rules.sh --check`).
- An **enabled-packages registry** in machine state is the source of truth for which
  packages are on. The home rules files are a pure function of `base fragments + enabled
  registry`.
- Install / enable / disable / update all do the same things: copy skills for the enabled
  set, render home rules from base + enabled fragments, copy-reconcile root config.
- Base install lands only: rendered base rules, the `roborepo` CLI, root config, and the
  `roborepo-support` skill. Every other skill and every package (jcodemunch, jdocmunch,
  caveman, telemetry, optional skills) exists only when onboarding enables it.

## Consequences

- **Maintainer skill-edit loop costs one step.** Editing a skill body no longer shows up
  live; the maintainer runs `roborepo update` (or a dev watcher) to re-copy. End users
  never edit skill bodies, so they pay nothing. This is a dev-loop concern, not an install
  mode.
- **`CLAUDE.md` / `AGENTS.md` become generated home files.** The symlink-write-through risk
  (writing through a home symlink into tracked `globals/claude/CLAUDE.md`) disappears
  because the home files are owned copies. This matches the existing stated layering
  (`rules-parity-and-layering.md` already declares generated rule files outside root-config
  adoption).
- **Uninstall simplifies.** Home skills, rules, commands, hooks, and markers are
  roborepo-generated copies → delete on uninstall, with the existing pre-install backup
  restoring any genuine pre-roborepo user files.
- **Drift surfaces differently.** `render --check` still guards the tracked baseline. The
  home rules file needs its own health check (`home == base + enabled registry`) in
  `doctor`.

## Discovered Constraints

- **Manifest `link` rows to convert** (`manifests/platform/manifest.tsv`): `claude:CLAUDE.md`,
  `claude:MANAGED_BY_ROBOREPO.md`, `claude:commands`, `claude:hooks`; `codex:AGENTS.md`,
  `codex:commands`, `codex:MANAGED_BY_ROBOREPO.md`, `codex:hooks.json`, `codex:hooks`,
  `codex:rules`. All become copies. (`settings.json` / `config.toml` are already
  `root_config`.)
- **Skill linking is mode-independent today** (`link_global_skills` always symlinks) — it
  becomes a copy operation in `install-lib.sh` and `config-mutate.mjs` (`setSkillInstalled`).
- **Copying skills loses the symlink ownership signal.** Today `link_skill_item` and the
  prune loop identify a roborepo-managed skill by its symlink target resolving inside the
  repo — that is how a user's native skill of the same name is skipped, and how a managed
  skill is pruned when its source is removed (`install-lib.sh:778`). A copied dir carries
  no such signal. Fix: stamp each copied skill with a `.roborepo-managed` marker; prune,
  overwrite, and native-skill detection key off the marker. Self-contained; no central
  registry needed.
- **Base and package block grep differently.** Base `settings.json` blocks `Grep`/`Glob` via
  a `block-source-exploration.mjs` hook; the jcodemunch package's `hooks-claude.json` uses
  an inline `echo`. The base copy must be removed and the package version made canonical.
- **jcodemunch policy is duplicated** in base (`globals/rules/shared/10-exploration.md` +
  base `settings.json` hooks) and the package (`globals/packages/jcodemunch/rules.md` +
  `hooks-claude.json`). Base copies are deleted; the package becomes the single source.
- **"Enabled" is currently derived from the file** (`config.mjs:55`, "enabled iff its block
  is present"). The registry replaces this; `config.mjs` reads the registry instead.

## Implementation Status

**Phase 1 (manifest rows):** Done. All 10 `link` manifest rows converted to `managed_copy`.
Install/uninstall/repair/sync/Windows/doctor/verify chain updated. `paths_equivalent_for_copy`
extended to handle directories. `savePreInstallBackup` poisoned-backup guard added (prevents
saving a fake pre-install backup when content already matches repo source). Both test suites
pass (194 passed, 0 failed).

**Known regression from Phase 1 → Phase 3:** `mergeRules` appended package rules to
the live Claude rules file instead of rendering from fragments. A `roborepo update`
re-rendered from repo source and wiped those appended rules. Phase 3 (render-from-fragments)
was required before package rule injection became durable across updates.

**Phase 1 remainder (skills copy):** Done. `link_skill_item` / `link_global_skills` in
`install-lib.sh` converted to copy + `.roborepo-managed` marker. `config-mutate.mjs`
`setSkillInstalled` uses `fs.cpSync` + marker. `doctor.sh` adds `check_managed_skill` (marker
check, not symlink check); `--installed` loop uses it. `uninstall.sh` `remove_skill_links`
removes marker-bearing dirs. Tests updated: symlink asserts → marker + diff asserts.
Both test suites pass.

**Phase 2:** Done. Install state now records `repo`, `onConflict`, harness metadata, and timestamps
without an install `mode`. Bash and Node install paths treat copy/conflict reconciliation as the only
path.

**Phase 3:** Done. Home rules are `rendered_rules` manifest rows, generated by
`scripts/cli/rules-render.mjs` from base fragments plus `~/.roborepo/enabled-packages.json`. Package
enable/disable updates the registry and re-renders instead of appending/removing text blocks.

**Phase 4:** Done for the jcodemunch split. Base install renders only base rules, installs CLI/root
config, and copies `roborepo-support`; jcodemunch rules, hooks, permissions, and MCP registration are
package-gated.

**Phase 5:** Done. Core docs and tests were updated for copy/render and package rule registry.
`roborepo update` now prints a concise change report for rendered rules, root config, managed
copies, skills, package registry state, hooks, and permission-bearing files.

---

## Implementation Phases

Each phase leaves the system working and verifiable (`doctor.sh`, `test-roborepo.sh`).

### Phase 1 — Materialization: copy everything, no symlinks
- [x] Convert all `link` rows in `manifests/platform/manifest.tsv` to `managed_copy` kind.
- [x] Route `managed_copy` through copy in `presets.mjs` (`applyRow`/`bundleApplied`) and
  `install-lib.sh` (`install_copy_item`). Extend `paths_equivalent_for_copy` to dirs.
  Add poisoned-backup guard in `savePreInstallBackup`.
- [x] Update install/uninstall/repair/sync/Windows/doctor/verify for `managed_copy` rows.
- [x] Skills copy instead of symlink: `install-lib.sh` `link_global_skills` /
  `link_skill_item`, `config-mutate.mjs` `setSkillInstalled`,
  `scripts/build/link-global-skills.sh`. Stamp copied skills with a `.roborepo-managed`
  marker; switch prune / native-skill detection from symlink-target to the marker.
- [x] Update `doctor.sh` / `verify-install.sh` link checks to copy checks (including the
  marker for skills).

### Phase 2 — Remove the managed/adopt gate (always adopt)
Remove only the managed-vs-adopt choice. The system is always adopt: copy everything, and
keep adopt's two conflict sub-modes unchanged — **overwrite** (back up existing as
`*_original_*`, install repo items) and **keep-originals** (leave existing active, stage
repo items as `*_update_*`). The managed branch (symlink + forced overwrite) is what gets
deleted.
- [x] `main.sh`: delete `choose_install_mode` (the managed-vs-adopt prompt) and
  `ROBOREPO_INSTALL_MODE`; **keep** `choose_adopt_conflict_policy`'s overwrite/keep-originals
  prompt — that is adopt's conflict sub-mode, unchanged.
- [x] `presets.mjs` `readInstallPolicy`: drop `mode` (always adopt); keep `onConflict` (default
  `keep`). Delete the **managed** branches in `applyRow` / `bundleApplied` so the
  copy/conflict-reconcile path is the only path.
- [x] `state-lib.sh` + `install-state.json`: drop `mode`; keep `onConflict`.
- [x] Sweep `repair.sh`, `uninstall.sh`, `sync-from-home.sh`, `install-*.sh`,
  `manifests-data.sh`, `install-windows.ps1` for the managed/adopt gate (not the conflict
  sub-modes).

### Phase 3 — Rules render-from-fragments + enabled-packages registry
- [x] Add the enabled-packages registry (new state file + read/write helpers).
- [x] Render home `CLAUDE.md` / `AGENTS.md` from `base + enabled-package fragments` (Node core,
  reusing the concatenation logic) on install/enable/disable/update.
- [x] Package `rules` component contributes a fragment to the render; delete the
  `mergeRules`/`unmergeRules` append path.
- [x] `config.mjs`: compute package "active" from the registry.
- [x] Onboarding (`presets.mjs`): write the registry, then re-render once.

### Phase 4 — Base = minimal; package-gate the rest
- [x] Rewrite `globals/rules/shared/05-skill-loading.md` to one skill-agnostic line; re-render.
- [x] Base links only `roborepo-support`; all other skills gated by onboarding.
- [x] Remove the unconditional `roborepo mcp apply` from `main.sh`; MCP registers only on
  package enable.
- [x] Delete `globals/rules/shared/10-exploration.md`; package `rules.md` is the single source.
- [x] Remove the jcodemunch SessionStart message + Grep/Glob hook from base `settings.json`;
  package `hooks-claude.json` is canonical.

### Phase 5 — Explicit update, docs, tests
- [x] `roborepo update` reports what changed (new/changed skills, rules, packages).
- [x] Docs sweep: rewrite `architecture.md`, `harness-anatomy.md`, `harnesses-explained.md`,
  `setup-and-daily-use.md`, `install-workflows.md`, `config-collision-handling.md`,
  `rules-parity-and-layering.md`, `manifest-and-symlinks.md`, and `README.md`. Remove current
  managed/adopt/symlink language throughout.
- [x] Tests: rewrite `test-install-collisions.sh` (symlink asserts → copy asserts) and
  `test-roborepo.sh`; add registry + render-on-toggle coverage.

## Open Decisions

1. **Headless/CI default set.** Minimal (rules + CLI + `roborepo-support`) vs also including
   jcodemunch for unattended installs.
2. ~~**`update` change-report format.**~~ Resolved: concise per-layer summary lines.
3. ~~**Copy kind naming.**~~ Resolved: added `managed_copy` kind. `root_config` = mutable user
   state (settings.json / config.toml); `managed_copy` = roborepo-owned content we always
   overwrite (CLAUDE.md, AGENTS.md, hooks, rules, commands).

## Success Criteria

- No symlinks created by install; `~/.claude` and `~/.codex` contain only copies and
  generated files.
- No `managed`/`adopt` references remain in code, tests, or docs.
- Base install with no packages enabled: rendered base rules, CLI, root config, and
  `roborepo-support` only — no other skills, no MCP servers, no package rules/hooks.
- Enabling a package through onboarding makes exactly its components appear; disabling
  removes exactly them; the home rules file always equals base + enabled registry.
- Install works identically whether source is a clone or a repo-less package.
</content>
