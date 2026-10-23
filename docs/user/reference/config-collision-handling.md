# Config Collision Handling

## Purpose

RoboRepo installs shared Claude Code and Codex defaults without silently replacing user-authored config. This reference documents the exact collision behavior for copied files, rendered rules, and root config.

For the user-facing walkthrough, start with [../guides/install-workflows.md](../guides/install-workflows.md).

## Concept Model

- **Managed copy**: a RoboRepo-owned home path copied from `globals/` or `manifests/`. Examples include commands, hooks, markers, and Codex rules.
- **Rendered rules**: `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`, generated from base rule fragments plus the enabled-package registry.
- **Root config baseline**: `generated/claude/settings.json` or `generated/codex/config.toml`. These are portable templates for mutable harness config.
- **User-owned config**: an existing regular file or non-roborepo symlink in a harness home.
- **Collision**: the installer finds a local path that differs from the repo source it would copy.

## Collision Policies

There is no managed/adopt install mode. The installer always copies or renders. Only the conflict policy varies:

| Policy | Behavior |
| --- | --- |
| `keep` | Leave the local file active and stage the repo candidate beside it as `*_update_TIMESTAMP`. |
| `overwrite` | Move the local file to `*_original_TIMESTAMP`, then copy the repo item into place. |
| `abort` | Stop before changing the conflicting path. |

Root config files follow their own rules, described in
[Root Config Drift Detection](#root-config-drift-detection).

Use:

```sh
./scripts/install/main.sh --on-conflict keep
./scripts/install/main.sh --on-conflict overwrite
./scripts/install/main.sh --on-conflict abort
```

If no flag is supplied, the installer reuses the saved `onConflict` from `~/.roborepo/install-state.json`. First noninteractive installs default to `keep`.

## Root Config Drift Detection

Root config rows (`~/.claude/settings.json`, `~/.codex/config.toml`) are shared ownership files: the
harness and user can write local settings, while RoboRepo contributes portable defaults. A byte
mismatch against the current repo baseline does not by itself prove the user touched the file — the
repo baseline itself is expected to change between installs (new permissions, hooks, MCP entries).
RoboRepo tracks a content hash of what it last wrote per harness
(`~/.roborepo/config-state/root-config.json`) and classifies the active file before applying a
policy:

| Active file | `keep` | `overwrite` | `abort` |
| --- | --- | --- | --- |
| Missing | Copy the baseline | Copy the baseline | Copy the baseline |
| Clean — matches RoboRepo's last write | Merge the new baseline in | Merge the new baseline in | Merge the new baseline in |
| Unwritten — a file RoboRepo has never written | Merge: local settings kept, repo additions layered on | Same as `keep` | Stop before writing, if the merge would change the file |
| Drifted — changed since RoboRepo's last write | Back up to `*_original_TIMESTAMP`, then merge | Same as `keep` | Stop before writing, if the merge would change the file |

The merge never discards local settings: it keeps every local value and adds repo-only entries.
That is why `keep` merges a drifted file instead of leaving it alone. Drift is routine for these
files, because Claude Code and Codex write their own settings into them (a model choice, plugin
toggles, desktop preferences), so a file can drift without you editing it. The backup is kept only
when the merge actually changed something; when the file already contains every repo entry, it is
simply recorded as current. Earlier releases staged a `*_update_TIMESTAMP` copy beside a drifted
root config instead; update now removes any such leftover.

The merge also removes a top-level `model` key from Claude's global `settings.json`, so global
harness config never overrides the harness default or your per-session model choice.

The installer records the merged active file after it writes it, so later drift reports are based on
the current state of the file.

**Uninstall.** The same drift signal governs removal. Uninstall deletes a root config only when it
still matches RoboRepo's last write, or when RoboRepo never recorded a write and the file's contents
show it is RoboRepo's. A drifted file — one you edited after RoboRepo's last write — is left in place
and its path is reported, never deleted.

**Seeing drift.** `roborepo config root inspect` and the drift chip on the `/agents` page report one
state per harness: `not-installed`, `unwritten`, `in-sync`, or `drifted`. A drifted file needs nothing
from you: your settings are kept, and the next `roborepo update` only adds roborepo's own entries.
The `/agents` page therefore shows no chip for it; it marks only an `unwritten` (untracked) file.

**Isolated runs.** A roborepo command whose state directory (`ROBOREPO_STATE_DIR` or
`ROBOREPO_STATE_ROOT`) is in a temporary directory while `HOME` is your real home refuses to write
harness config. Such a run would otherwise write your real `settings.json` with paths into scratch
state that disappear when it is cleaned up. Set `HOME` to an isolated directory as well when you
isolate the state directory.

**Write log.** Every write RoboRepo makes to your harness config (`settings.json`, `config.toml`,
`CLAUDE.md`, `AGENTS.md`, hooks files, and the enabled-packages list) adds one line to
`~/.roborepo/logs/config-writes.jsonl`: the time, the file, and what triggered it, either the
`roborepo` command you ran (a `roborepo update` names itself even for writes its installer makes) or
the portal request, such as `portal POST /api/config/packages`. `roborepo config root inspect` shows
the last logged write for each root config. The log rotates to a single `.1` file past 512 KB.

## Codex Native Profiles (permanent personal config)

Drift detection tells you when your root config has diverged from RoboRepo's baseline, but it gives
you no place for personal settings that survive every `roborepo update` untouched. **Codex** has a
native answer — profiles:

- Put personal settings in a named profile file at `~/.codex/<name>.config.toml`.
- Select it with `--profile <name>` on the CLI, or set `CODEX_PROFILE=<name>` in the environment.
- Codex layers the profile natively between project config and the main user config
  (`~/.codex/config.toml`). RoboRepo never writes profile files, so `roborepo update` leaves them
  untouched — no drift, no collision, no staged candidate.

So keep `~/.codex/config.toml` as RoboRepo's managed baseline, and put your personal overrides in a
profile.

**Claude** has no equivalent native profile mechanism at the user-config level (fixed scope tiers:
managed > CLI args > project local > project > user). There is no RoboRepo-provided substitute;
Claude users keep personal changes in `~/.claude/settings.json` directly, and drift detection shows
when an update would collide with them.

## Merge Prompt Behavior

When a collision creates a staged candidate or backup, RoboRepo prints a merge review prompt. The prompt lists the repo and local paths, but it is not an exhaustive diff. The agent or human doing the merge must inspect both paths directly, using recursive directory diffs for directories and structured parsers for JSON/TOML where practical.

Default stance: preserve local behavior unless the user explicitly chooses replacement.

## Rendered Rules

Rules files are RoboRepo-generated home files. They are identified by the `# Generated Harness Rules` header and are written as a managed block inside the existing `CLAUDE.md` / `AGENTS.md` file, so user text outside the managed block can stay in place.

On first render, if a genuine user-authored `CLAUDE.md` or `AGENTS.md` already exists, RoboRepo saves it once under:

```text
~/.roborepo/backups/pre-install/<harness>/<filename>
```

Then it injects or updates the rendered managed block in the existing file. Uninstall removes rendered files it owns and restores the pre-install backup when present.

## Pre-Install Backups

Before RoboRepo first replaces a genuine user file, it writes a durable backup of the original file:

```text
~/.roborepo/backups/pre-install/claude/settings.json
~/.roborepo/backups/pre-install/codex/config.toml
~/.roborepo/backups/pre-install/claude/CLAUDE.md
~/.roborepo/backups/pre-install/codex/AGENTS.md
```

Backups are written only once. RoboRepo-authored files and byte-identical repo copies are not captured as "originals", which prevents reinstall cycles from poisoning the backup. The backup is for the user's original file, not for the managed block that RoboRepo later injects into that file.

For root config rows, the installer may create a timestamped `*_original_*` file during a collision-resolution pass and then delete that file again if the post-merge live file ends up byte-identical to it. That keeps the safety snapshot available while the merge is in flight, but avoids leaving behind redundant originals after a no-op resolution.

## Per-Element Persistence

For each harness element, what survives a first install and what survives a `roborepo update`:

| Element | On install | On update |
| --- | --- | --- |
| **Rules** (`CLAUDE.md` / `AGENTS.md`) | Genuine user file backed up once under `~/.roborepo/backups/pre-install/<harness>/`; managed block injected, user text outside the block preserved. See [Rendered Rules](#rendered-rules). | Managed block re-rendered in place; text outside it untouched. A wholly user-replaced file is handled by [collision policy](#collision-policies), not by rule rendering. |
| **Root config** (`settings.json` / `config.toml`) | Never-written file captured as original before first write. See [Pre-Install Backups](#pre-install-backups). | Clean baseline change merged silently; a drifted file follows the policy (`keep` stages, `overwrite` backs up then merges, `abort` stops). See [Root Config Drift Detection](#root-config-drift-detection). Codex users keep permanent personal config in a [native profile](#codex-native-profiles-permanent-personal-config) RoboRepo never touches; Claude has no equivalent and relies on drift detection. |
| **Permissions** | Personal overrides preserved in `~/.roborepo/command-overrides.json`; drifted config kept and repo version staged rather than replaced. | Baseline re-rendered from the manifest without erasing overrides; root-config hash distinguishes "baseline changed" from "user changed". Codex runtime `ask` hook fills the gap static rules cannot. |
| **Skills / commands** | Unrecognized native skills left alone — RoboRepo owns only the names it manages. Generated commands are authoritative on owned paths; existing files preserved only under collision handling. | Owned skills re-linked from `~/.roborepo/skills/`, owned commands re-rendered. Out-of-band skills stay visible as adoptable drift, never deleted. |
| **MCP servers** | Desired server recorded in manifest state and applied natively to every harness declaring the `mcp` capability; unrelated user MCP entries in root config preserved. Each provider writes its own native store: Claude its live CLI store, Codex the active `~/.codex/config.toml` (not the repo baseline), Gemini the `mcpServers` key in `~/.gemini/settings.json`. | Manifest state re-applied rather than reconstructed from the live machine; manually added servers stay as machine state, local profile overlays not flattened. |
| **Plugins** | Plugin state added only to the active user config; no plugin payload written into repo source; unrelated user config untouched. | User's plugin choice re-applied from config state; marketplace registrations kept unless the plugin is being disabled; "enabled but not yet installed" state preserved. |
| **Hooks** | Genuine user-authored hook/config files backed up before first replacement; managed hook blocks kept separate from user-added settings. | Managed hook definitions updated, user-added config outside the managed block preserved. Some hook behavior is intentionally duplicated by hand — the harness protocols differ too much to round-trip. See [Rendered Rules](#rendered-rules) for the managed-block model that also governs hook wiring. |
