---
id: cleanup-before-reinstall
priority: none
next_action:
blocked_by: []
depends_on: []
related: []
reviewed_commit:
---

# Cleanup Before Reinstall — Checklist

> **Status: obsolete historical checklist.** This was a one-machine cleanup note from the
> hand-wired telemetry/bootstrap period. It is archived so old references still resolve, but it is
> not current install guidance. Use `docs/user/guides/first-time-setup.md` and
> `docs/user/guides/install-workflows.md` for current setup behavior.

Quick reference for getting home dirs to a clean state before running the full
roborepo install. The "uninstall to test from scratch" left shim artifacts and
one stale skill behind. Do these steps **before** `main.sh` so the installer
writes onto clean state instead of fighting hand-made files.

## Background

Telemetry was wired up **without installing roborepo** to measure baseline token
traffic (read/grep activity) before the full CLI + default bundles were
reinstalled. This was a deliberate shoehorn: a symlinked `roborepo` command +
hand-written hook configs that fire only `telemetry capture`, with nothing else
(no jcodemunch, no skills, no rules, no MCP, no block-source-exploration guard,
no caveman).

`roborepo telemetry enable` calls `presetsApply(["telemetry"])`, which pulls in
the `hooks` preset — that installs the *full* hook set (jcodemunch nudges,
source-exploration guard, write-guard). For a clean baseline we needed capture
firing with none of those, so the state file was written by hand to bypass
`enable`'s preset side-effect. Once per-package install exists, that toggle is
first-class and this bypass is unnecessary.

## What's actually left in home dirs

| Path | What it is | Action |
|------|-----------|--------|
| `~/.claude/settings.json` | Grew beyond shim: has telemetry hooks + jcodemunch permissions/hooks + broad Bash allow/ask list | **review then remove** — installer re-renders full version; generic Bash allows and ask→deny shift for git push/rm won't survive (see step 2a) |
| `~/.codex/hooks.json` | Shim: 5 capture hooks only | **remove** — installer re-renders |
| `~/.codex/config.toml` | Got a `[features] hooks=true` block prepended | **edit** — drop the block (keep project/nux entries) |
| `~/.local/bin/roborepo` | Symlink → repo bin | leave (installer overwrites) or remove for clean slate |
| `~/.roborepo/telemetry/` | Hand-written `state.json` + captured baseline data | **decide**: keep (backup first) or purge |
| `~/.agents/skills/case-study/` | Stale repo skill (real dir, not symlink) — leftover, not a manual add | **remove** — installer re-links it |
| `~/.claude/settings.local.json` | Your 3 permissions (`find`, `docker system`, `open -a Docker`), untouched by shim | **leave** |
| `~/.claude/telemetry/*.json` | Anthropic's own `1p_failed_events` — not roborepo | leave (vendor) |
| `~/.codex/skills/.system/*` | Codex built-in skills — not roborepo | leave (vendor) |

## Steps

### 1. Decide fate of baseline telemetry data

Lives in `~/.roborepo/telemetry/spool/`.

- **Keep** (compare baseline vs post-install) — back up first; `purge --all` nukes the dir:
  ```bash
  roborepo telemetry backup   # snapshots to ~/.roborepo/telemetry-backups/ (outside purge target)
  ```
- **Discard**:
  ```bash
  roborepo telemetry purge --all
  ```

### 2a. Rescue any permissions from `settings.json` that should survive reinstall

The current `~/.claude/settings.json` has a broad `allow` list (generic `git add *`, `rm *`, etc.) and an `ask` list (`git push`, `git checkout`, etc.) that were added manually. The repo's version does **not** have these — it actively **denies** `rm`, `git push`, `git pull`, and `git rm`.

Before removing the file, decide what to keep and move it to `~/.claude/settings.local.json`:

```bash
# View what's currently allowed in the shim vs the repo version:
jq '.permissions' ~/.claude/settings.json
jq '.permissions' <repo>/globals/claude/settings.json

# Add any keepers to settings.local.json (already has 3 entries — append to the allow array)
```

Anything already in the repo's `settings.json` (jcodemunch tools, hooks) does not need to be rescued — the installer restores it.

### 2b. Remove shim harness configs

```bash
rm -f ~/.claude/settings.json     # shim-only; installer re-renders full version
rm -f ~/.codex/hooks.json         # shim-only; installer re-renders full version
```

Then edit `~/.codex/config.toml` — remove the prepended block, keep everything else:

```toml
[features]
hooks = true
```

### 3. Remove stale skill leftover

```bash
rm -rf ~/.agents/skills/blog      # repo ships this; installer re-links it
```

### 4. (Optional) Remove bin symlink

Skip if installing immediately — installer overwrites it.

```bash
rm -f ~/.local/bin/roborepo
```

### 5. Run full install

```bash
cd <repo>
./scripts/install/main.sh
```

## Verify clean → installed

```bash
ls ~/.roborepo/install-state.json     # should EXIST (proves real install ran)
roborepo telemetry status             # enabled + paths

# settings.json should match the repo's full rendered version:
diff <(cat ~/.claude/settings.json) <(cat <repo>/globals/claude/settings.json)
```

If `install-state.json` exists and `settings.json` carries the full hook set
(jcodemunch nudges, block-source-exploration, write-guard), the shim is gone and
the real install owns these files.

## After install — telemetry via the real path

```bash
roborepo telemetry enable    # writes state + applies telemetry/hooks preset
roborepo telemetry serve     # dashboard
roborepo telemetry report    # terminal report
```
