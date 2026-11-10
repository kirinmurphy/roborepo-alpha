---
id: root-config-layered-inheritance
priority: none
next_action:
blocked_by: []
depends_on: []
related: []
reviewed_commit:
---

# Root Config Drift Detection

> Status: core mechanism shipped and code-reviewed 2026-07-07. Earlier version of this doc proposed
> a baseline/overlay/generated merge system (three files auto-merged into an "active" config). That
> design is dropped — see "Why The Overlay Design Was Dropped" below. Current design: detect drift
> honestly, never silently merge, and stage conflicting versions the same way `roborepo install`
> already does (see
> [`config-collision-handling.md`](../../user/reference/config-collision-handling.md)) rather than
> inventing a second staging convention. Implementation steps 1–4 are done across all three install
> paths this repo has: the JS bundle-apply path (`presets.mjs`), the bash direct-installer path
> (`install-lib.sh`), and the PowerShell Windows installer (`install-windows.ps1`, added during
> review after the first pass shipped bash/JS only). `roborepo config root inspect` ships as a
> read-only report. Steps 5–7 (uninstall drift-awareness, portal drift visibility, Codex
> native-profile docs) all shipped 2026-07-07 — the full implementation-steps list is now complete.
>
> A post-implementation code review found and fixed one correctness bug: `install-lib.sh`'s
> `export_user_config` was recording a "clean" hash even when the user's conflict choice was
> `keep` (which leaves the active file untouched), silently erasing real drift the first time the
> check ran under that policy — see `test_root_config_keep_policy_does_not_record_false_clean` in
> `test-install-collisions.sh` for the regression test. The review also deduplicated the
> claude/codex home-path mapping (now `harnessHome`/`rootConfigBaseline`/`rootConfigActive` in
> `paths.mjs`, previously defined independently in three modules), wired the two dead
> `stageCandidate`/`backupOriginal` staging-lib functions into their intended call sites instead of
> leaving them unused beside inline duplicates, added a shared `readJsonState`/`writeJsonState` pair
> in `state-paths.mjs`, and narrowed (but did not fully close — no file locking) a latent
> read-modify-write race in the state sidecar for the case of manually parallelized installs.

## Problem

Roborepo currently exports root harness config (`~/.claude/settings.json`, `~/.codex/config.toml`)
as active local files. A repo update that changes permissions, hooks, MCP, or plugin defaults can
collide with user-owned edits to that same file.

Users are free to hand-edit these files directly, or use native harness flows (Claude/Codex
onboarding, IDE extensions, `claude config` commands, etc.) that touch the same file outside
roborepo entirely. Any design has to assume the user will **not** reliably go through a roborepo
command to make local changes — that's a guardrail we can't enforce, only a guideline that will
get bypassed.

## Why The Overlay Design Was Dropped

An earlier version of this doc proposed four layers: a repo baseline, a user-owned "machine
overlay" file, a generated "active" file merging the two, and project-local overrides. The idea
was that user customizations would live in the overlay file and survive `roborepo update`
untouched.

That design assumed user edits would flow through a channel roborepo controls (a `set-local`
command, or at minimum a dedicated overlay file the user edits by hand instead of the real
settings file). In practice, nothing stops a user from editing `~/.claude/settings.json` directly,
or letting a native harness flow write to it. Once that happens, roborepo can't tell which keys are
"safely separated" and which aren't — the overlay's whole promise (your customizations always
survive updates) becomes unreliable, and an unreliable promise is worse than no promise, because it
creates false confidence.

We also checked whether Claude Code or Codex CLI natively solve this (native `include`/`extends`
for root config). As of 2026-07, neither does at the user-config level:

- **Claude Code**: fixed scope tiers (managed > CLI args > project local > project > user), no
  native per-machine split file at the user level, no native profile mechanism.
- **Codex CLI**: has a real native **profile** system — named files at `~/.codex/<name>.config.toml`,
  selected via `--profile <name>` or `CODEX_PROFILE`, layered natively between project config and
  user config by Codex itself.

So Codex users who want a personal, permanently-separate config slice have a real native option
already (see "Codex Native Profiles" below). Claude has no equivalent, and roborepo should not
invent a userland substitute that can't keep its promise.

## Design: Detect Drift, Never Silently Merge

Instead of merging, roborepo tracks a fingerprint of the file it last wrote and compares it before
touching the file again.

1. Every time roborepo writes `~/.claude/settings.json` or `~/.codex/config.toml`, it records a
   content hash in a state sidecar: `~/.roborepo/config-state/root-config.json`.
2. On the next `update` or `repair`, roborepo re-hashes the current file:
   - **Hash matches** → file is unchanged since roborepo last wrote it. Safe to regenerate from
     the current repo baseline and overwrite.
   - **Hash differs** → something else touched the file (user hand-edit, native harness flow,
     manual merge). Roborepo does **not** guess which parts are safe. It stops and shows an honest
     diff: what the repo baseline wants to change vs. what's currently on disk.
3. The user (or an agent acting for them) decides: keep the current file as-is, overwrite with the
   new baseline, or manually reconcile specific lines. This is the same `onConflict` shape roborepo
   already uses at install (`keep` / `abort` / `overwrite`), just without any pretense of automatic
   merging.

This is deliberately less convenient than silent auto-merge on every update. That's the trade: it
never lies about what happened, and it never loses an edit without telling you.

Rather than inventing a new archive location, drift handling reuses the timestamped-sibling
convention `roborepo install` already uses for collisions (`*_original_TIMESTAMP` when the
baseline wins, `*_update_TIMESTAMP` when the current file is kept) — see
[`config-collision-handling.md`](../../user/reference/config-collision-handling.md). One staging
mechanism covers both first install and every later drifted update, instead of two separate ones.

## Update

`roborepo update` should:

1. Load the repo baseline for the harness.
2. Hash the current active file and compare to the sidecar.
3. If it matches: regenerate the active file from the current baseline, update the sidecar hash.
4. If it has drifted:
   - `onConflict=keep`: leave the active file untouched, stage the new baseline beside it as
     `*_update_TIMESTAMP` (same convention as install), report that root config is out of sync.
   - `onConflict=abort`: stop before writing anything.
   - `onConflict=overwrite`: move the current file to `*_original_TIMESTAMP`, then write the new
     baseline into place, update the sidecar.
5. Never attempt to auto-merge drifted content into the new baseline.

## Repair

`roborepo repair` should re-hash and, if the active file still matches the sidecar, refresh it
against the current baseline (e.g. after a checkout move changes absolute paths). If the file has
drifted, `repair` follows the same `onConflict` handling as `update` rather than silently
overwriting.

## Uninstall

`roborepo uninstall` should remove only active files that still match the sidecar hash. If the user
edited the file after roborepo last wrote it, uninstall leaves it in place and reports the path
instead of deleting user-modified content.

## Project-Local Config

Project-local config (`.claude/settings.json`, `.codex/config.toml`, `CLAUDE.md`, `AGENTS.md`,
project skills) is a separate, harness-native layer that already works today — both harnesses
layer project config over global/user config natively. This doc's drift detection applies only to
the global/user-level file; project-local config is untouched by it and should stay that way.

## Codex Native Profiles

Codex CLI supports named profile files (`~/.codex/<name>.config.toml`) selected via `--profile
<name>` or the `CODEX_PROFILE` env var, layered natively by Codex between project config and the
main user config. This is a real, reliable mechanism Codex already owns — roborepo doesn't need to
build anything to support it.

For Codex users who want a permanent personal config slice that survives roborepo updates cleanly,
point them at native profiles rather than a roborepo-built equivalent. Claude has no equivalent
native mechanism; there is no drop-in substitute proposed here.

## onConflict

Applies only to writing the active root config file, reusing the same install-time staging
convention rather than a separate one:

- `keep`: leave the active file untouched, stage the new baseline as `*_update_TIMESTAMP`, do not
  regenerate, report pending drift.
- `abort`: exit non-zero before writing.
- `overwrite`: move the active file to `*_original_TIMESTAMP`, then write the new baseline into
  place.

## Implementation Steps

1. [x] Parsers/serializers for Claude JSON and Codex TOML — not needed after all: drift detection
   only requires a raw content hash, not a parsed structure, so both harnesses are handled as bytes
   (`scripts/cli/root-config-state.mjs::hashFile`). Structured parsing remains open only if semantic
   diffing (see Open Decisions) is picked up later.
2. [x] Root-config state sidecar — `scripts/cli/root-config-state.mjs`, hash of last-written content
   per harness at `~/.roborepo/config-state/root-config.json` (path in `state-paths.mjs`).
3. [x] `roborepo config root inspect` — read-only report of baseline vs. active file vs. drift
   state, in `scripts/cli/config.mjs::configRootInspect`.
4. [x] Hash-check wired into all three write paths: `presets.mjs::copyItem` (the JS bundle-apply
   path used by `roborepo update`), `install-lib.sh::export_user_config` (the direct
   `install-claude.sh`/`install-codex.sh` path), and `install-windows.ps1::Export-UserConfig` (the
   PowerShell path, added during code review — it has its own independent implementation of
   root_config handling and was initially missed). All three consult drift state before treating a
   byte mismatch as a collision, and the non-JS paths shell out to
   `node root-config-state.mjs check|record <harness> <path>` so the hash logic isn't duplicated in
   bash or PowerShell. Each write path only records a write on the branch where it actually wrote
   the active file — critically, `keep`/`adopt` branches that leave the file untouched must NOT
   record, since doing so falsely marks a possibly-drifted file as clean (this was found as a real
   bug in `install-lib.sh` during review and fixed; see status note above).
   - Follow-up (2026-07-07): the Windows path had drift-awareness only in `Export-UserConfig`, but
     that function runs *after* `Invoke-RootConfigPreflight` has already resolved (and adopted)
     collisions — so a routine baseline change (`drift == clean`) was wrongly prompting in the
     preflight and blocking the update. Added the same `drift == clean → not a collision` check to
     `Resolve-UserConfigCollision` (the preflight resolver), and extracted the duplicated adopt/
     merge/quit menu shared by both functions into one `Invoke-RootConfigCollisionPrompt` helper.
     Static test: `test_windows_installer_root_collision_dedup_and_drift` in `test-install-collisions.sh`
     (no PowerShell on the CI/dev host, so the Windows path is covered by structural assertions).
5. [x] Teach `uninstall` to remove only sidecar-matching active files — `uninstall.sh`'s
   `remove_root_config` now gates on `root_config_drift_status`: a `drifted` root_config (edited
   after roborepo's last recorded write) is left in place with its path reported, rather than
   deleted, even though `is_roborepo_authored` still matches the markers underneath the edit. Only
   `clean`/`unwritten`/`missing` fall through to the existing content-based removal. The
   `check_no_active_remnants` root_config branch was split from `rendered_rules` so a deliberately
   kept drifted file is not flagged as a remnant (it requires `clean` drift status to count). Tests:
   `test_uninstall_preserves_drifted_root_config` and
   `test_uninstall_check_clean_tolerates_drifted_root_config` in `test-install-collisions.sh`.
6. [x] Add portal visibility for drift state — `config.mjs` now exposes `buildRootConfigView()`, the
   single per-harness drift-state producer shared by the terminal `roborepo config root inspect`
   report (refactored to consume it) and the web portal (snapshot ships it under `rootConfig`).
   States: `not-installed` / `unwritten` / `in-sync` / `drifted` / `staged-pending` (a
   `*_update_TIMESTAMP` sibling beside the active file wins over plain drift, since a pending staged
   update is the actionable signal). The `/config` "Generated Files" panel renders a status chip
   beside settings.json / config.toml for the drifted / staged / untracked states (in-sync and
   not-installed stay quiet — no chip). Tests: `scripts/test/root-config-view-check.mjs` (wired into
   `test-roborepo.sh`) exercises all five states against a throwaway HOME.
7. [x] Document the Codex native profile option as the recommended path for a permanent personal
   config slice — added a "Codex Native Profiles (permanent personal config)" section to
   `docs/user/reference/config-collision-handling.md` (put personal config in
   `~/.codex/<name>.config.toml`, select via `--profile <name>` / `CODEX_PROFILE`, layered natively
   by Codex; roborepo never writes profile files so updates leave them untouched; Claude has no
   equivalent). The terminal `roborepo config root inspect` report now also prints a Codex-only
   pointer to profiles when a Codex root config is drifted. No code beyond that CLI hint — Codex
   already owns the mechanism.

## Open Decisions

- Should the drift diff shown to the user be raw file diff, or a semantic key-level diff
  (permissions added/removed, hooks changed, etc.)? Semantic is more readable but more work to
  build correctly for both JSON and TOML.
- Should `roborepo config root inspect` proactively suggest Codex native profiles when it detects
  a Codex user has drifted the same keys repeatedly?
- Does Claude's `CLAUDE_CONFIG_DIR` env var (undocumented, full config-dir isolation rather than
  layering) deserve a mention as a power-user escape hatch, given it's not a supported feature?
