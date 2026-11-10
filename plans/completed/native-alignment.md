---
id: native-alignment
priority: none
next_action:
blocked_by: []
depends_on: []
related: []
reviewed_commit:
---

# Native Alignment Completed Record

## Purpose

This record explains the completed native-alignment migration: roborepo's
under-the-hood mechanics were moved into alignment with the native skill,
plugin, MCP, and memory behaviors of Claude Code and Codex, so that native
tools and roborepo's wrapped CLI describe the **same** state instead of two
competing states.

The user-facing promise stayed unchanged:

- **Parity:** one item, fanned out to both harnesses.
- **Single action:** one `roborepo` command applies a change to both.

Only the implementation changed: where it makes sense, the wrapped CLI command
**calls the native command under the hood** and treats the native store as the
source of truth, instead of maintaining a parallel store the native tools cannot
see.

This doc also records the surfaces where **no logistical sync is possible**, so
those are documented stances rather than silent drift.

## Current State

roborepo authors items once under `globals/` and fans them out to both
harnesses by copy, render, native wrapping, or managed per-skill links. The
right mechanism depends on who owns the live store:

- **Owned files** such as rules, hooks, commands, and root config baselines are
  driven by `manifests/platform/manifest.tsv` plus render/copy helpers.
- **Shared skills** are sourced from `globals/agents/skills/<name>`,
  materialized into `~/.roborepo/skills/<name>`, then linked per-skill into each
  harness's native skill dir: `~/.claude/skills/<name>` and
  `~/.codex/skills/<name>`.
- **Native-wrapped stores** such as Claude MCP use roborepo-owned intent in the
  repo, then native commands to apply live state.
- **Deferred stores** such as memory, transcripts, logs, plugin install caches,
  and machine trust state stay machine-local.

The original failure this plan fixed was **two source-of-truth stores for one
concept**: roborepo wrote one place, the native tool wrote another, neither
observed the other.

## Original Context

- Codex ships system skills under `~/.codex/skills/.system/`: `skill-installer`,
  `skill-creator`, `plugin-creator`. The installer/creator write user skills into
  `$CODEX_HOME/skills/<name>` (= `~/.codex/skills`).
- Before this migration, roborepo published shared skills into `~/.agents/skills`
  and relied on Codex *also* scanning that dir; Claude did not observe it. That
  runtime target is now removed. Shared skills now fan into each harness's
  native skill dir via the `~/.roborepo/skills` cache.
- Claude manages plugins via `~/.claude/plugins/installed_plugins.json` and
  `~/.claude/plugins/known_marketplaces.json`, written by the native plugin
  system.
- Claude MCP servers live in Claude's live store, written by `claude mcp add`.
  Codex MCP servers live in `config.toml`.
- Both harnesses have native persistent memory (Codex `~/.codex/memories/` +
  `memories_*.sqlite`; Claude `/memory` under `~/.claude/projects/*/memory/`).

## Important Files

- `manifests/platform/manifest.tsv` — the managed home↔repo row table
- `manifests/platform/harnesses.tsv` — harness presence/topology (`claude`, `codex`)
- `scripts/lib/manifests-data.sh` — bash reader for manifest home-root tokens
- `scripts/install/install-codex.sh`, `install-claude.sh`, `install-lib.sh`
- `scripts/install/install-windows.ps1` — PowerShell installer/manifest reader
- `scripts/doctor.sh`, `scripts/verify-install.sh`, `scripts/sync-from-home.sh` — manifest consumers
- `scripts/cli/mcp.mjs`, `scripts/cli/mcp-claude.mjs`, `scripts/cli/mcp-codex.mjs`
- `scripts/cli/skill-new.mjs`, `scripts/cli/skill-links.mjs`, `scripts/cli/slash-commands.mjs`
- `scripts/cli/skill-lib.mjs`, `scripts/build/skill-lib.sh` — skill enumeration (parity-checked)
- `globals/claude/settings.json`, `globals/codex/config.toml`
- `~/.roborepo/skills/<name>` — machine-local cache for roborepo-managed shared skills
- `globals/agents/skills/.system/` (vendored copies of native system skills — deleted, item 1.1)
- `docs/internal/skills-and-commands.md`
- `docs/internal/harness-anatomy.md`

## Design Principle

For each managed concept, classify it into one of three relationships with the
native system, and align the implementation accordingly:

| Relationship | Meaning | Implementation |
| ------------ | ------- | -------------- |
| **Own** | Native has no competing store; roborepo is the only writer. | Keep the symlink/manifest model as-is. |
| **Wrap** | Native owns the live store; roborepo provides parity + single-action by calling the native command on each harness and recording intent in version control. | CLI calls native under the hood; repo holds a declarative manifest, not a shadow copy. |
| **Defer** | Native store is inherently machine-local or per-session; no logistical sync exists. | Document the stance; do not manage. Surface it in `doctor` as informational, not drift. |

The migration moved skills, plugins, and MCP away from "roborepo maintains a
parallel store" and toward **Wrap** where native stores exist. Memory is
formally **Defer**.

## Status Tracker

All design items below are decided, built, and verified. This table is the
completed status record.

| Item | Topic | Design status | Implemented? |
| ---- | ----- | ------------- | ------------ |
| 0 | Remove `~/.agents/*` runtime target; fan into native dirs | ✅ decided | ✅ yes |
| 1 | Skills — wrap native creation, one universal output | ✅ decided | ✅ yes (1.1 .system removed; 1.2/1.3 native-backed new + openai.yaml; 1.4 adopt) |
| 2 | Plugins (Claude) — already aligned; keep as-is | ✅ decided (no behavior change; add comment + No-Sync note) | ✅ manifest comments added |
| 3 | MCP — version-control Claude MCP, symmetric w/ Codex | ✅ decided (`mcp-servers.json` = state; presets = catalog) | ✅ yes (`mcp-servers.json` + `mcp apply`) |
| 4 | Slash commands — collision detection | ✅ decided (warn-only in `--check`) | ✅ yes (`reserved-commands.json` + warn in renderSlashCommands) |
| 5 | Out-of-band skill drift — hook nudge + doctor | ✅ decided | ✅ yes (SessionStart nudge + doctor drift report) |
| 6 | Memory — formally Defer + document | ✅ decided | ✅ yes (documented in harness-anatomy.md + skills-and-commands.md) |

**All design items are decided, built, and verified.** Both gating spikes passed. The
per-skill link mechanism (Open Question 2) was resolved: enumerate-step (option b) was
chosen over generated manifest rows. Skills are linked at install time by
`scripts/install/install-lib.sh:link_global_skills`, called from both bash installers
and `scripts/build/link-global-skills.sh` (post-`skill new`). `skill new` uses native
`init_skill.py` when present, roborepo template otherwise.

## Resolved — old `~/.agents/skills` teardown (item 0.5 migration)

**Status: done (2026-06-20).** The last gap — migrating machines off the legacy
`~/.agents/skills` location — is now implemented (option 1 below).

- **Already handled:** the old dir-level `~/.claude/skills` and `~/.codex/skills`
  symlinks are torn down via the `cleanup` rows in `manifests/platform/manifest.tsv`
  (lines 38, 49 — `remove_repo_link`), and per-skill links are created by
  `link_global_skills`.
- **Now handled:** `remove_legacy_agents_skills` in `scripts/install/install-lib.sh`
  reclaims a `~/.agents/skills` symlink **when it points into the repo** (the old
  dir-level managed link), backs it up via `unique_backup_path` mirroring
  `remove_repo_link`, and `rmdir`s an emptied `~/.agents`. It is called at the top of
  `link_global_skills`, so every install/update/post-`skill new` run migrates the
  machine. It is self-contained (defaults `backup_root`/`dry_run`) and idempotent —
  the redundant per-harness second call is a no-op.
- **Safety:** a real `~/.agents/skills` directory (user content) and any symlink that
  does *not* point into the repo are left untouched — only the roborepo-managed
  dir-level link is reclaimed.
- **Why option 1:** smallest and self-cleaning; no need to reintroduce the `agents`
  home-root token this plan deleted (rejected option 2), and it heals automatically
  rather than leaving cleanup to the user (rejected option 3 — surface-only).

**Tests:** `scripts/test/test-roborepo.sh` covers the upgrade fixture (pre-seed
`~/.agents/skills` as a managed link → install → assert it is gone and per-skill links
exist) and the preservation case (a real `~/.agents/skills` user dir survives install).
Verified directly: managed link reclaimed + backed up, empty `~/.agents` removed,
per-skill links created, second run no-op, real dirs and foreign symlinks preserved.

## Decisions Locked

These are settled and drive the work items below.

1. **`~/.agents/skills` is removed everywhere as a live target.** It is **not** a
   cross-harness standard — verified: every native Codex tool (skill-installer,
   skill-creator, init_skill.py) writes/reads `$CODEX_HOME/skills` (= `~/.codex/skills`),
   not `~/.agents/skills`. Codex merely *also scans* `~/.agents/skills`; Claude
   does not observe it at all. roborepo no longer relies on any `~/.agents/*`
   path being globally observed.

2. **`globals/agents/skills/` stays as the canonical version-controlled source.**
   Only the *source* keeps the neutral `agents` name (it is just a repo folder).
   The fan-out **pointers changed**: each skill is linked into **both**
   `~/.claude/skills/<name>` and `~/.codex/skills/<name>` — each harness's real
   native skill dir — instead of into `~/.agents/skills`.

3. **`roborepo skill new` is native-backed on Codex, roborepo-native on Claude.**
   Not a "fallback" — two first-class paths chosen by what is installed:
   - Codex's `init_skill.py` present → call it to scaffold.
   - Otherwise (Claude-only) → roborepo's own template is the primary path.
   Either way the skill is created **once** in `globals/agents/skills/<name>` and
   fanned to both harnesses. The result is universal; only the *scaffolder* differs.

4. **The back-half always ensures `agents/openai.yaml`** (via native
   `generate_openai_yaml.py` when present, else a small built-in), so the only
   remaining creation-time difference between the two scaffold paths is the
   `SKILL.md` body text (native = TODO placeholders; roborepo = pre-filled minimal
   workflow). No functional or metadata divergence.

5. **Out-of-band skill creation is detected, not prevented.** An agent can call
   native `init_skill.py` / `skill-installer` directly; roborepo cannot intercept a
   raw file write. Mitigation is a **SessionStart hook nudge** (push) plus a
   **`doctor` drift report** (pull), both pointing at `roborepo skill adopt`.

## Work Items

The work-item sections below preserve the implementation plan and evidence. Their
"Problem" language describes the state at the time of the migration unless a
section explicitly says otherwise.

### 0. Remove `~/.agents/*` as a runtime target (precondition)

**Original problem.** roborepo fanned skills into `~/.agents/skills` and relied on
Codex scanning it. Claude did not read it; Codex's own native tooling did not
write it. It was roborepo-invented plumbing mis-documented as a "universal
standard" (`harness-anatomy.md` overstated this).

**Pre-migration state (verified — corrected earlier assumptions).**

- Claude skills are linked **dir-level**, not per-skill:
  `claude link globals/claude/skills → ~/.claude/skills` (one symlink to a repo dir
  that itself contains per-skill symlinks into `../../agents/skills`).
- Codex skills reach the harness **only via `~/.agents`**:
  `agents link globals/agents/skills → ~/.agents/skills`, and Codex scans `~/.agents`.
  **There was no `codex link skills` row** — roborepo had never populated
  `~/.codex/skills` (the `codex cleanup skills` row only *prunes* a stale link there).
- So removing `~/.agents` is not a one-row change: it **changes how Codex gets
  skills at all**, and changes Claude from dir-level to (the new) per-skill model.

**Implemented model.**

1. **Drop the `agents` harness entirely.** `manifest.tsv`, `harnesses.tsv`, and
   `scripts/lib/manifests-data.sh` now know only `claude` and `codex` home-root
   tokens. Codex presence is detected through `~/.codex`, not `~/.agents`.
2. **Link skills per-skill for BOTH harnesses.** A dedicated installer step,
   `install-lib.sh:link_global_skills`, enumerates `globals/agents/skills/*`,
   materializes each enabled skill into `~/.roborepo/skills/<name>`, then links the
   harness view at `~/.claude/skills/<name>` or `~/.codex/skills/<name>`.
3. **Keep `globals/agents/skills/` as the source name.** Only the *source folder*
   keeps `agents`; nothing at runtime points at `~/.agents`.
4. **Keep cleanup rows as migration guards.** The `claude cleanup skills` and
   `codex cleanup skills` rows remove old dir-level managed links only. They do not
   manage the live skills directory wholesale.
5. **Migrate existing installs.** `remove_legacy_agents_skills` tears down a
   roborepo-managed `~/.agents/skills` symlink, backs it up, and leaves real user
   content or foreign symlinks untouched.
6. **Fix the docs.** Reference docs now describe `globals/agents/skills` as
   roborepo's version-controlled source fanned per-skill into each harness's native
   dir.

> Caveat now in scope: roborepo writes into `~/.codex/skills/<name>`, the same dir
> native `skill-installer` writes. Manage strictly per-skill (only roborepo-owned
> names); never clear the whole dir. This is the collision the old `~/.agents`
> detour avoided, now handled by precise per-skill ownership instead.

### 1. Skills — wrap native creation; one universal output (highest priority)

**Problem.** Competing skill stores and a vendored duplicate:

- `~/.codex/skills/<name>` — where native `skill-installer` / `init_skill.py` write.
- `globals/agents/skills/.system/` — roborepo's **vendored duplicate** of the
  native `skill-creator` / `skill-installer` / `plugin-creator`, scanned alongside
  the real ones in `~/.codex/skills/.system/`. Duplicate names → ambiguous activation.
- roborepo's own `skillTemplate()` produces a *different* starter than native
  `init_skill.py`, so skills look different depending on how they were made.

**Implemented model.**

1. **Stop vendoring the native system skills.** Delete
   `globals/agents/skills/.system/`. Codex's own `~/.codex/skills/.system/` is the
   single copy. roborepo's render/link paths do not depend on the vendored copy.

2. **`roborepo skill new` wraps the native scaffolder when present.** When
   `~/.codex/skills/.system/skill-creator/scripts/init_skill.py` exists, call it to
   scaffold into `globals/agents/skills/<name>`. When absent (Claude-only machine),
   use roborepo's own template as the primary path. Either way, run the roborepo
   back-half: version-control the result, update manifests, README, command links,
   and fan out to both harnesses (item 0).

3. **Back-half always ensures `agents/openai.yaml`.** Generate it (native
   `generate_openai_yaml.py` when present, else built-in) regardless of scaffolder,
   so Codex's skill-chip UI is consistent no matter where the skill was authored.
   Claude ignores the file; it is harmless there.

4. **`roborepo skill adopt <name>`** ingests a skill created out-of-band in
   `~/.codex/skills/<name>` (or `~/.claude/skills/<name>`): move it into
   `globals/agents/skills/<name>`, register manifests, fan out. This is
   **remediation, not a routine step** — the user is pointed at it by the drift
   nudge/report (item 5), never expected to remember it.

5. **Per-skill ownership in the native dirs.** roborepo manages only the skill
   names it owns. It must never clear `~/.codex/skills` or `~/.claude/skills`
   wholesale; native-installed skills it does not own are left untouched and shown
   as adoptable drift.

**User-facing implications (record in user docs):**

- Creating a skill is **one action → one universal skill** that works identically
  in both harnesses. There is no per-harness skill.
- The *resulting skill content is the same* across harnesses (plain `SKILL.md`
  both read identically). The only creation-time difference is the starter body:
  native gives TODO placeholders to fill; roborepo gives a pre-filled minimal
  workflow. Both are edited before use; the distinction disappears after authoring.
- The *authoring conversation* differs by harness: native `skill-creator` is a
  guided multi-step interview (asks for examples, resources); the roborepo template
  path is one-shot. Same artifact, different authoring texture.
- `agents/openai.yaml` is always written. It only affects Codex's skill UI; Claude
  ignores it.

**Net:** one canonical, version-controlled, universal skill per name; native
scaffolder used when available; one copy of the system skills; out-of-band creation
surfaced and adoptable.

### 2. Plugins (Claude) — already aligned; keep as-is, document the why

**Investigation result (corrected).** An earlier read suggested the
`plugins/*.json` cleanup rows were destructive. They are not. Verified against the
code and git history:

- The two `claude cleanup plugins/known_marketplaces.json` /
  `plugins/installed_plugins.json` rows only act on a path that is a
  **roborepo-managed symlink** (`remove_repo_link` checks `-L` + points-into-repo;
  uninstall's `remove_repo_symlink` checks `is_managed_link`). They **never touch a
  native real file.** The live registry (caveman + user's `vercel`) is a native
  real file, so the rows are correctly inert today.
- Origin (`074f643`): the first installer symlinked `plugins/` dir contents
  (`blocklist.json`) into the repo and **gitignored** the two registry files, with
  these rows as the **guard** ensuring the registry files were never captured by
  that dir-linking. The `blocklist.json` linking was later removed; the guard rows
  (and the `.gitignore` entries) stayed.
- The rows still serve two live flows: **uninstall** (remove orphaned managed
  links) and **relocation/rename** (reclaim a stale managed link at the old path).

**So the plugin model already matches native alignment:**

- Enablement → declarative in `globals/claude/settings.json` (`enabledPlugins`,
  `extraKnownMarketplaces`). roborepo owns the declaration. ✅
- Install records → native, gitignored, never tracked by the repo. ✅
- Uninstall / relocation → guarded cleanup rows handle managed-link teardown. ✅

**Decision (locked): leave plugin behavior unchanged.** No row removal, no new
`plugins.json` manifest, no install-on-update.

**Cross-harness note (No-Sync):** plugins are a **Claude-only** concept; Codex has
no equivalent enable surface roborepo can mirror. Plugin parity is therefore not
achievable and is not a goal — recorded in No-Sync Surfaces.

**Only change — documentation:** add a comment to the two cleanup rows in
`manifest.tsv` explaining they are legacy plugin-dir-linking guards that also serve
uninstall/relocation, so a future reader does not mistake them for active registry
management.

### 3. MCP — make Claude symmetric with Codex (version-control the servers)

**Problem.** `roborepo mcp add` is split-brain:

- Codex: writes the server block into `globals/codex/config.toml` (version-controlled). ✅
- Claude: shells out to `claude mcp add`, which writes Claude's **live store**;
  only the `mcp__<name>` permission lands in `globals/claude/settings.json`. The
  server definition itself is **not** in the repo.

So "reproduce same config across machines" fails for Claude MCP: a fresh machine
gets Codex servers back from the repo but not Claude servers.

**Decision (locked):** one neutral, version-controlled manifest is the canonical
MCP set for **both** harnesses; `mcp add` records intent there and applies live to
each harness in its native dialect; `mcp apply` re-applies on any machine. Chosen
against four criteria — cross-harness consistency, simplest abstraction, adapts to
each harness's internals, clearest user expectation — over (a) a Claude-only
`mcpServers` block in `settings.json` (asymmetric, fails consistency/adaptation)
and (b) reusing `mcp-presets.json` (conflates "available to add" with "installed").

**Implemented model.**

1. **`manifests/inventory/mcp-servers.json` — the recorded set.** Holds the
   actual servers and which harnesses each targets:
   ```json
   { "servers": [
       { "name": "jcodemunch", "commandOrUrl": "uvx", "args": ["jcodemunch-mcp"],
         "harnesses": ["claude", "codex"] }
   ] }
   ```
   This is *state* ("what is installed"), distinct from `mcp-presets.json`, which
   stays as the *catalog* ("what you can add" — named aliases/shortcuts). Do not
   merge them; the catalog-vs-state split is itself what keeps user expectations
   clear.

2. **`roborepo mcp add` writes the manifest, then applies live to each harness in
   its native dialect:**
   - Claude → `claude mcp add` (native owns Claude's live store).
   - Codex → server block in `globals/codex/config.toml`.
   This is the **Wrap** pattern: neutral intent in the repo, native execution per
   harness. roborepo never hand-writes Claude's internal MCP store format.

3. **`roborepo mcp apply` re-applies** the recorded set to whichever harnesses are
   present on the current machine, making the MCP set portable. Codex already reads
   its servers from the repo; this brings Claude to the same reproducibility.

4. **User expectation (record in user docs):** "`roborepo mcp add X` records X and
   installs it on both harnesses; `roborepo mcp apply` restores it on any machine."
   One sentence, symmetric, no "template vs installed" ambiguity.

5. **Permission handling.** `mcp add` today also inserts the `mcp__<name>`
   permission into `globals/claude/settings.json` (`ensureClaudeMcpPermission`).
   Keep that, and make `mcp apply`'s re-apply **idempotent** on the permission
   (already guarded: it no-ops if present). The permission stays repo-tracked in
   `settings.json`; the server definition moves to `mcp-servers.json`. Document that
   these are two separate records for one server (permission = allow-list entry;
   server = connection spec).

6. **Migration stance:** `mcp-servers.json` records roborepo-managed MCP intent.
   Native user MCP servers that were added outside roborepo are not claimed unless
   explicitly added through `roborepo mcp add`.

### 4. Slash commands — collision detection against native + plugin commands

**Problem.** roborepo renders commands into `~/.claude/commands` and
`~/.codex/commands`. Native harnesses and plugins (caveman ships `/caveman`,
`/commit`, etc.) also expose `/` commands. Nothing reconciles roborepo's command
names against native/plugin names → silent shadowing.

**Decision (locked): warn, do not fail.** Only 5 roborepo commands exist today,
all skill-backed, zero collisions. A hard-fail gate is premature for a problem that
does not exist; warn surfaces the signal now and can be promoted to fail later if
the command set grows and collisions become real.

**Implemented model.**

1. Add a `manifests/inventory/reserved-commands.json` list seeded from caveman +
   harness built-in commands (the names roborepo must not shadow).

2. `roborepo skill render-commands --check` reports any rendered command name that
   collides with the reserved list as a **warning** — it does not block the render.
   Same check runs for both harnesses' rendered commands (symmetric).

3. This is **Own** (roborepo controls its command source) plus a low-friction
   guardrail. Keeping it warn-only also bounds the cost of a stale reserved list: a
   missed warning, never a wrongful build break.

4. Promotion path: if commands grow or a real collision lands, flip `--check` to
   hard-fail. Recorded as a future option, not done now.

### 5. Out-of-band skill drift — detect via hook nudge + doctor report

**Problem.** roborepo cannot prevent an agent or user from calling native
`init_skill.py` / `skill-installer` directly, which writes an untracked skill into
`~/.codex/skills/<name>` (or a hand-dropped `~/.claude/skills/<name>`). These are
invisible to version control, parity, and a fresh machine.

**Implemented model — detect, don't prevent.**

1. **SessionStart hook nudge (push).** A hook counts skill dirs under
   `~/.codex/skills/` and `~/.claude/skills/` that are not roborepo-managed
   symlinks, and prints a one-line nudge when any exist:
   `unmanaged skills: <n> — run \`roborepo skill adopt <name>\` to version-control`.
   Keep it to one line; do not block.
2. **`doctor` drift report (pull).** `roborepo doctor` lists each unmanaged skill
   and prints the exact `roborepo skill adopt <name>` remediation. This is how the
   user finds `adopt` without memorizing it.
3. Detection only counts skills **not owned** by roborepo; managed symlinks are not
   drift.

### 6. Memory — formally Defer, document the boundary

**Problem.** Codex (`~/.codex/memories/`, `memories_*.sqlite`) and Claude
(`/memory`) both have native persistent memory. roborepo's session-capture
convention deliberately writes nothing and flags candidates instead. Users may
wrongly assume `roborepo update` carries memory across machines.

**Resolution — this is a Defer surface (see "No-Sync Surfaces").** No action
beyond documentation:

1. Add a short section to `harness-anatomy.md` stating memory is machine-local
   native state, not managed by roborepo, and not carried by `update`.
2. `doctor` may *list* native memory presence as informational, never as drift.

## No-Sync Surfaces (no logistical way to stay in sync)

Record these explicitly so they are documented stances, not bugs:

| Surface | Why no sync | Stance |
| ------- | ----------- | ------ |
| **Native memory** (Codex `memories_*.sqlite`, Claude `/memory`) | Per-machine, per-project, opaque/SQLite, written continuously by the harness at runtime. No stable export contract. | **Defer.** Document as machine-local. Capture convention stays the roborepo path. |
| **Claude MCP live store internals** | Claude owns and rewrites its internal MCP store format; not a stable file contract to hand-edit. | **Wrap, not mirror.** roborepo records server *intent* and re-applies via `claude mcp add`; never writes Claude's internal store directly. |
| **Plugins (whole concept)** | Claude-only; Codex has no plugin enable/install surface to mirror. | **Claude-only, no parity goal.** roborepo declares enablement in `settings.json`; native owns install records (gitignored). Item 2. |
| **Plugin install cache/records** (`installed_plugins.json`, `known_marketplaces.json`, marketplace caches) | Written by native plugin runtime with install timestamps, SHAs, machine-specific cache paths. | **Native-owned, gitignored.** roborepo never tracks, writes, or deletes these (cleanup rows only touch managed symlinks). Item 2. |
| **Session/transcript/log state** (`history.jsonl`, `logs_*.sqlite`, `sessions/`) | Runtime telemetry/history, inherently local and append-only. | **Defer.** Out of scope; telemetry already reads these read-only. |
| **Per-machine trust/project config** (Codex `[projects."..."]` trust levels, `config.toml` machine-specific blocks) | Absolute local paths and trust decisions are machine-specific. | **Defer / local-only.** Keep out of the version-controlled config or scope carefully. |
| **Out-of-band skill creation** (agent/user calls native `init_skill.py` / `skill-installer` directly) | A raw file write into `~/.codex/skills/<name>` — no roborepo command runs, nothing to intercept. | **Detect, not prevent.** SessionStart hook nudge + `doctor` drift report point at `roborepo skill adopt`. Item 5. |

## Spike Results (2026-06-20)

Tested the two gating unknowns before building. Both **PASS**.

- **Spike 1 — Codex loads symlinked skills (item 0 core assumption): PASS (high
  confidence).** Created a symlinked skill at `~/.codex/skills/<name>` → external
  source. Codex's own enumeration pattern (`os.listdir` + `is_dir`, as used in
  `skill-installer/scripts/list-skills.py:43`) sees it as a normal skill dir;
  `is_dir()` follows the symlink, `SKILL.md` is readable through it. Only an
  interactive Codex load fully closes this, but Codex's native tooling uses exactly
  the symlink-transparent pattern. Mixing a symlinked skill beside `.system/` real
  dirs in the same parent worked.
- **Spike 2 — doctor/verify breakage is contained and known: PASS.** `doctor.sh`
  asserts the *repo source structure*, not the live home install, so item 0 does
  not silently break it at runtime. But its assertions encoded the old model and
  had to change in lockstep:
  - `doctor.sh:230` — `check_repo_symlink "globals/claude/skills/<n>" "../../agents/skills/<n>"`
    asserts the intermediate `globals/claude/skills/` dir being removed. Update.
  - `doctor.sh:224-225` — comment states "Codex reads `~/.agents/skills` directly".
    Rewrite to the per-skill native-dir model.
  - `doctor.sh:216` legacy-root loop (`agents claude codex skills-local`) guards
    repo-root source dirs — unaffected (different from `globals/`).
  - `verify-install.sh` skill checks derive from `globals/agents/skills/*` source —
    survive; confirm no live-link assertion on `~/.agents`.

**Conclusion:** item 0 is safe to build. No design change needed. The doctor/verify
edits above are now concrete sub-tasks of item 0.6.

## Resolved Implementation Questions

All former open questions are resolved:

1. **System skills:** `globals/agents/skills/.system/` was removed. roborepo does
   not rely on vendored native system skills for render/link paths.
2. **Per-skill link mechanism:** the installer enumerate-step won. Skills are not
   represented as generated `manifest.tsv` rows.
3. **Claude dir-level → per-skill migration:** doctor/verify assumptions were
   updated with the per-skill native-dir model.
4. **Codex presence detection:** `harnesses.tsv` now detects Codex by `~/.codex`
   only. `~/.agents` is not a presence root.

**Resolved (design decided):**

- `~/.agents/skills` is not a standard → removed as a runtime target; fan into each
  harness's native dir (Decision 1, 2; item 0).
- `skill new` is native-backed (Codex) / roborepo-native (Claude), not a fallback
  (Decision 3).
- `agents/openai.yaml` always generated (Decision 4).
- **MCP source of truth:** new `manifests/inventory/mcp-servers.json` (state) for
  both harnesses; `mcp-presets.json` stays the catalog (item 3).
- **Plugin install vs enable:** enable-via-`settings.json` is sufficient; no
  install-on-update, no behavior change (item 2).
- **Command collisions:** warn-only in `--check`, not hard-fail (item 4).
- Out-of-band creation: detect via hook nudge + doctor, not prevent (Decision 5; item 5).

## Completed Sequence

1. Removed `~/.agents/*` runtime target and fanned shared skills into native dirs.
2. Stopped vendoring Codex system skills.
3. Made `roborepo skill new` native-backed when Codex tooling is present and always
   generates `agents/openai.yaml`.
4. Version-controlled MCP intent in `manifests/inventory/mcp-servers.json` and
   added `roborepo mcp apply`.
5. Added `skill adopt`, drift nudges, and doctor reporting.
6. Added command collision warnings via `reserved-commands.json`.
7. Updated docs/comments for `.agents`, plugin cleanup-row behavior, memory Defer,
   and No-Sync surfaces.
