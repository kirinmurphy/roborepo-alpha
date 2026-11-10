---
id: sync-from-home-manifest
priority: none
next_action:
blocked_by: []
depends_on: []
related: []
reviewed_commit:
---

# sync-from-home Manifest Migration Plan

## Context

`manifests/platform/manifest.tsv` is now the single source of truth for managed home<->repo paths,
read by the bash scripts via `scripts/lib/manifests-data.sh` (`manifest_rows`) and by the
Windows installer via its PowerShell TSV reader.

`scripts/sync-from-home.sh` (the reverse direction: pull live home config back into the
repo) now also consumes the manifest. This doc records the migration decisions and the
interactive shell gotcha that made the implementation non-obvious.

## Why sync needed extra manifest semantics

1. **sync skips skills.** Install links `globals/claude/skills` and `globals/agents/skills`.
   sync intentionally skips these rows because skills are maintained in-repo and symlinked
   outward, never pulled back from the home dirs. The manifest marks these rows with
   `nosync`.

2. **`plugins/blocklist.json` was dead state.** Before the migration, sync had:

       sync_item "${HOME}/.claude/plugins/blocklist.json" "globals/claude/plugins/blocklist.json"

   but install treated the same path as retired cleanup:

       remove_repo_link "${HOME}/.claude/plugins/blocklist.json"

   The repo had no real `globals/claude/plugins/blocklist.json` source, so sync could write
   a path that no installer managed. The migration resolved this by dropping blocklist
   management completely: no sync row and no cleanup row.

3. **Install-only cleanup rows** (`MANAGED_BY_HARNESS_CONFIGS.md`, `plugins/known_marketplaces.json`,
   `plugins/installed_plugins.json`) have no sync counterpart and must never be synced.

## Implemented manifest mapping

sync maps manifest rows like this:

  - `link`        -> `sync_item home repo`
  - `root_config` -> `sync_item home repo user_config`
  - `cleanup`     -> not synced (skip)

Rows flagged `nosync` are skipped before this mapping.

## Status — DONE

- [x] blocklist decision made — option (a): dropped. `plugins/blocklist.json` is no longer
      synced; its manifest `cleanup` row was also removed (install no longer prunes it either).
- [x] manifest `nosync` flag added — on the `skills` rows so sync skips them.
- [x] sync-from-home.sh migrated — loops `manifest_rows` (link → `sync_item`, root_config →
      `sync_item … user_config`), reading the manifest on **FD 3** so interactive `read`
      prompts keep the terminal as stdin.
- [x] parity proven — `test-install-collisions.sh` sync tests pass (keep/overwrite/agent
      choices), full suite green.
- [x] Windows installer migrated — `install-windows.ps1` now parses `manifests/platform/manifest.tsv`
      directly instead of hand-listing managed home paths.

> Implementation note: the manifest loop MUST read on a non-stdin FD (`done 3< <(manifest_rows)`
> with `read … <&3`). Using `< <(manifest_rows)` hijacks stdin with the process-substitution
> pipe and breaks every interactive prompt — sync would wrongly report "stdin is not
> interactive" even under a PTY.
