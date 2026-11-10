---
id: portable-install-relocation
priority: none
next_action:
blocked_by: []
depends_on: []
related: []
reviewed_commit:
---

# Portable Install: Surviving Repo Relocation

## Purpose

Today, moving or renaming the roborepo checkout breaks the entire install on that
machine. Every managed path under `~/.claude`, `~/.codex`, and `~/.agents` is an
absolute symlink into the checkout (e.g. `~/.claude/skills -> /Users/me/projects/roborepo/globals/claude/skills`).
Rename `roborepo` to anything else, move it to another directory, or check it out
at a different path on a second machine, and every one of those symlinks dangles.
The `roborepo` command itself disappears from `PATH` because `~/.local/bin/roborepo`
points at the old location.

This actually happened: the checkout was renamed `old_repo -> roborepo`,
which orphaned ~10 symlinks and removed `roborepo` from `PATH`. Recovery required a
manual walkthrough (delete the stale bin link by hand, re-run install with
`--on-conflict overwrite`) because the installer and uninstaller could not
recognize or reclaim links pointing at a prior checkout path.

The goal: make the install survive relocation, and make recovery a single command
on any machine — without the manual cleanup.

## Concept Model

- **Checkout** — the working copy of this repo at some absolute path. May differ
  per machine and may move over its lifetime.
- **Managed link** — a symlink under a harness home (`~/.claude`, `~/.codex`,
  `~/.agents`) created by the installer, listed in `manifests/platform/manifest.tsv`. Points
  into the checkout.
- **Bin link** — `~/.local/bin/roborepo`, the symlink that puts the command on
  `PATH`. Points at `<checkout>/bin/roborepo`.
- **Install state** — `~/.roborepo/install-state.json`. Already records the
  checkout's absolute path as `repo` plus the install `mode`. Today nothing reads
  `repo` back; it is write-only.
- **Stable root link (proposed)** — a single indirection symlink,
  `~/.roborepo/current -> <checkout>`. All managed links and the bin link point
  through this stable path instead of at the checkout directly.

Source of truth for _what_ is linked is `manifests/platform/manifest.tsv`. Source of truth
for _where the checkout is_ becomes the stable root link, with the recorded `repo`
in install state as the authoritative fallback for detection and repair.

## Current Behavior

- `scripts/install/main.sh` computes `repo_root` fresh from its own script location
  every run, so the installer always knows the _current_ checkout. The stale path
  only survives baked into existing home symlinks and the state file.
- Managed links are created absolute: home path -> `${repo_root}/${src_rel}`
  (`install-claude.sh:42`, via `install_link_item`).
- The bin link is created absolute: `~/.local/bin/roborepo -> ${repo_root}/bin/roborepo`
  (`install-global-commands.sh::link_command`).
- `scripts/doctor.sh --installed` resolves each link with `realpath` and compares
  against the expected current `repo_root` (`check_link`, lines 71-88). A moved
  checkout therefore makes doctor _fail_ — drift is already detected, just not
  repaired.
- `install-state.json` stores `repo` = absolute checkout path (`state-lib.sh::write_install_state`),
  but no consumer reads it.

### Known gaps

1. **`install-global-commands.sh` treats any non-matching bin link as a hard
   conflict.** Both `check_command_target` (preflight) and `link_command` (apply)
   compare the existing link's target only against the _current_ source path. A
   dangling link from a prior checkout — exactly the auto-healable case — blocks
   the install with a merge prompt, and ignores `--on-conflict`. This is why the
   bin link had to be removed by hand.

2. **`scripts/install/uninstall.sh` only removes links whose target starts with the
   _current_ `repo_root`** (lines 24-25, 40, 84). A link left by a prior checkout
   path is silently skipped, so uninstall cannot clean an install made before the
   checkout moved. This is the untested-until-now uninstall bug.

3. **No detection or repair surface.** A user whose checkout moved has no
   `roborepo`-native way to fix it; they must re-run the raw install script with the
   right conflict flag.

## Proposed Behavior

**Chosen scope: recorded root + doctor/repair, plus the two bug fixes.** Managed
links and the bin link stay as direct absolute symlinks into the checkout (no
indirection layer). Recovery after a move becomes a single command instead of a
manual cleanup.

- Install already writes the checkout path to `install-state.json` as `repo`; that
  value is now read back by uninstall and repair.
- `roborepo doctor` (already drift-aware via `realpath`) gains an explicit message
  when live links resolve to a path other than the current checkout, pointing the
  user at `roborepo repair`.
- New `roborepo repair` relinks the full managed tree (and bin link) to the current
  checkout. It reads the recorded root, removes stale managed links — including
  dangling ones — by matching manifest home paths, and recreates them against the
  current `repo_root`. Idempotent; a no-op when already consistent.
- `uninstall.sh` removes a managed/bin link if it is dangling **or** resolves to
  the recorded root — not only the current `repo_root` — closing gap #2.
- `install-global-commands.sh` auto-heals a dangling bin link instead of erroring —
  closing gap #1.

### Deferred — stable root indirection

A future option (not in this scope) is a single `~/.roborepo/current -> <checkout>`
indirection link that all managed links route through, so a move requires updating
one link instead of relinking the tree. Rejected for now: it adds a single point of
failure, an extra hop when reading links, a one-time migration of existing installs,
and Windows-junction parity work — complexity not justified while the checkout path
is mostly stable. `roborepo repair` already gives one-command recovery without it.
Revisit if multi-machine / frequent-relocation use grows.

## Happy Path

Fresh install on any machine:

1. User clones the repo to any path and runs `scripts/install/main.sh`.
2. Installer creates all managed links and the bin link pointing at the checkout.
3. Installer records the checkout path and mode in `install-state.json`.
4. `roborepo doctor --installed` passes.

Relocating the checkout later:

1. User moves or renames the checkout.
2. `roborepo doctor` reports drift and tells the user to run `roborepo repair`.
3. User runs `roborepo repair`. It removes the stale managed + bin links (now
   dangling) and recreates them against the current checkout, then updates the
   recorded root.
4. `roborepo` resolves on `PATH` again; doctor passes.

## Required Rules

- The recorded `repo` in install state must always reflect the checkout that
  performed the most recent install/repair.
- A dangling managed or bin link at a manifest-managed home path is always safe for
  the installer/uninstaller/repair to reclaim — a missing target proves it is not a
  live user file.
- Repair and uninstall must be idempotent: safe to run repeatedly, and a no-op when
  already consistent.
- Manual install and any future update/repair must share one linking code path
  (the existing `install_link_item` helpers), not a parallel implementation.

## Operational Workflow

| Command                        | When                              | Gives                                          | Does not do                       |
| ------------------------------ | --------------------------------- | ---------------------------------------------- | --------------------------------- |
| `scripts/install/main.sh`      | first install, or full reinstall  | full link tree + state + stable root           | minimal targeted repair           |
| `roborepo doctor --installed`  | verify, or after a suspected move | pass/fail + drift diagnosis pointing at repair | change anything                   |
| `roborepo repair`              | checkout moved/renamed            | re-point stable root, reclaim stale links      | re-export mutable root config     |
| `scripts/install/uninstall.sh` | remove install                    | remove managed + bin links (incl. stale)       | delete adopted/copied root config |

## Edge Cases

- **Checkout moved, all managed links now dangle.** Repair recreates each managed
  link (matched by manifest home path) against the current `repo_root` and updates
  the recorded root.
- **Two checkouts on one machine.** Repair run from a checkout relinks everything to
  that checkout and records it as `repo`. Recorded root disambiguates which install
  is active.
- **Dangling bin link from a prior checkout name.** `install-global-commands.sh` and
  repair remove it and recreate against the current checkout instead of erroring.
- **Stale link whose target still exists but is a different (old) checkout.** Repair
  removes it when its resolved target equals the recorded root or any non-current
  checkout it manages, then recreates against the current checkout. Live user files
  (non-symlinks) at managed paths are never touched.

## Implementation Checklist

- [ ] Add a recorded-root reader to `state-lib.sh`: `read_install_repo` (echo the
      `repo` field from `install-state.json`, mirroring `read_install_mode`).
- [ ] `install-global-commands.sh`: in `check_command_target` and `link_command`,
      treat a dangling bin link as auto-healable (remove + recreate) instead of a
      hard conflict.
- [ ] `uninstall.sh`: remove a managed/bin link when it is dangling OR resolves to
      the recorded root, not only the current `repo_root`.
- [ ] Add `roborepo repair`: a `scripts/install/repair.sh` that reclaims stale
      managed + bin links (dangling, or resolving to recorded/non-current root) by
      manifest home path and recreates them against the current `repo_root`, then
      rewrites the recorded root. Wire a `repair` subcommand in the CLI.
- [ ] `doctor.sh`: when `check_link` finds drift, emit an explicit "run
      `roborepo repair`" hint.
- [ ] Tests in `scripts/test/test-roborepo.sh`: relocate-and-repair, uninstall of a
      stale install, dangling-bin-link heal, dry-run parity.
- [ ] Docs: update `README.md` and `docs/user/reference/architecture.md` with
      the repair command and recovery flow.

## Open Decisions

- **Repair vs. reinstall:** should `roborepo repair` be a distinct
  `scripts/install/repair.sh`, or a targeted mode of `main.sh`? A distinct script
  keeps repair fast and side-effect-light (relink only, no root-config re-export);
  reusing `main.sh` avoids a parallel linking code path. Leaning distinct script
  that reuses the shared `install_link_item` helpers.
- **Should repair re-export mutable root config?** Default no — repair fixes links
  only; root config (`settings.json`, `config.toml`) is user-owned and untouched.
- **Windows parity:** mirror the bin-link heal + repair in `install-windows.ps1`?
  Track as follow-up if Windows is not actively used.

## Success Criteria

- Renaming or moving the checkout, then running one command (`roborepo repair`),
  fully restores the install and the `roborepo` command — no manual link deletion.
- A second machine with the checkout at a different absolute path installs and
  passes `doctor --installed` with no path edits.
- `uninstall.sh` removes a stale install (one made before the checkout moved),
  leaving no dangling managed or bin links.
- Installing over a dangling bin link succeeds without a conflict prompt.
- All new paths exercised by `scripts/test/test-roborepo.sh`, including dry-run.
