---
id: config-control-panel
priority: none
next_action:
blocked_by: []
depends_on: []
related: []
reviewed_commit:
---

# Config Control Panel + Phased Onboarding

> **Status: shipped (archived).** The read-only config view, the interactive
> package/skill/permission/telemetry/caveman toggles, per-project permission scope,
> the typed-component model (`mcp`/`rules`/`hooks`/`permissions`/`plugin`/`service`/
> `skill`), and package composition (`requires`) are all built. Current behavior is
> documented in
> [`docs/user/reference/config-control-panel.md`](../../user/reference/config-control-panel.md).
> This plan is kept for history; do not treat it as current behavior.

## Purpose

The repo has been running in a hand-assembled interim state since the full install
was torn down for baseline telemetry measurement. During that period two new
primitives appeared: `--telemetry-only` as a light install path, and `roborepo
enable <package>` as an atomic per-package installer. Neither existed in the
previous full-install workflow.

Before doing a full reinstall, the goal is to:

1. **Audit the gap** between the current hand-assembled config and what a full
   managed install would write — so the cleanup is intentional, not blind.
2. **Decide what to keep** from the interim primitives (telemetry-only path, enable
   command, packages catalog).
3. **Build a read-only config state view** (terminal + web) so the current active
   state is visible before adding controls — Phase 0.
4. **Restore opt-in bundle-toggle onboarding** so `roborepo onboard` lets the user
   turn default bundles on/off without forcing it at install time — Phase 1.
5. **Add package selection** to the onboarding wizard so tools like jcodemunch can
   be added or removed in the same flow — Phase 2.

The web portal already has a telemetry dashboard; a second view showing what is
currently configured is the natural companion.

---

## Audit: Current Config vs Full Install

The current `~/.claude/settings.json` was assembled by hand and through
`roborepo enable jcodemunch`. A full managed install would write
`globals/claude/settings.json` instead. The differences:

### In the full install but not in the current hand-assembled config

| What | Why it matters |
|------|---------------|
| `block-source-exploration.mjs` Bash hook | Redirects Bash source exploration to jcodemunch. The hand config has the Grep/Glob blocker but not the Bash-level guard. |
| `minimize-bash-output.mjs` hook | Keeps Bash output concise; absent from interim. |
| `capture-dense-bash.mjs` hook | Captures heavy Bash sessions for telemetry; absent from interim. |
| `roborepo-write-guard.mjs` hook | Guards writes against accidental roborepo edits; absent from interim. |
| jdocmunch SessionStart nudge | Tells the agent jdocmunch is available when docs are indexed. |
| Unmanaged skills nudge | Warns at session start if hand-added skills are detected. |
| Deny list: `rm`, `git push`, `git pull`, `git rm` | Full install explicitly denies these; interim has them in the allow or ask list. |
| `enabledPlugins: { "caveman@caveman": true }` | Enables the caveman plugin; absent from interim. |
| `extraKnownMarketplaces` | Registers the caveman marketplace; absent from interim. |
| `alwaysThinkingEnabled: false`, `awaySummaryEnabled: false`, `skipDangerousModePermissionPrompt: true` | Harness behavior tuning; absent from interim. |

### In the current config but not in the full install (will be lost at reinstall)

| What | Fate at reinstall |
|------|------------------|
| Generic Bash allow list (`rm *`, `git add *`, `mkdir *`, `mv *`, `cp *`, `cat *`, `echo *`, etc.) | Removed — some entries conflict with the deny list |
| Ask list for `git push`, `git checkout`, `git switch`, `git branch`, `WebFetch`, `WebSearch` | Replaced by deny entries for git destructive commands; WebFetch/WebSearch become ask via project settings.local.json if needed |

### What the current config has correctly (already in the full install)

- 5 telemetry capture hooks (SessionStart, PreToolUse, PostToolUse, UserPromptSubmit, Stop)
- jcodemunch SessionStart nudge hook
- Grep/Glob blocker (`search_symbols`, `get_file_outline` redirect)
- jcodemunch permissions (9 tools)
- `model: "opus"`

---

## What to Keep from Interim Solutions

### Keep: `--telemetry-only` install flag

`scripts/install/main.sh --telemetry-only` delegates to `roborepo telemetry install`,
which wires only the bin symlink and 5 capture hooks — nothing else. This is the right
light-install path for users who want token visibility before committing to a full install.
It is idempotent and does not conflict with a later full install.

### Keep: `roborepo enable <package>` command

`scripts/cli/packages.mjs` implements atomic per-package installation: MCP, hooks,
permissions, and rules are all wired in one command. The jcodemunch package definition
in `manifests/inventory/packages.json` proves the pattern works. This becomes the
install mechanism for the package-selection step in Phase 2.

### Keep: `packages.json` catalog and `globals/packages/<id>/` fragments

The catalog format (components: mcp, hooks, permissions, rules, cliCommands) is the
right shape for declaring what a package installs. The jcodemunch fragments
(`hooks-claude.json`, `rules.md`) live in `globals/packages/jcodemunch/` and are
the source for `roborepo enable`. Both survive into the phased onboarding plan.

### Absorb: the hand-assembled shim

The hand-written `settings.json` additions (generic Bash allow list, ask list) were
a stopgap. They do not belong in the config and will not survive a reinstall. Any
entries worth keeping move to `~/.claude/settings.local.json` before the full install
runs. After reinstall, this hand-assembled state is gone.

The current two-step light-install workflow that results from keeping these pieces:

```
scripts/install/main.sh --telemetry-only   # bin + capture hooks
roborepo enable jcodemunch                 # MCP + hooks + permissions + rules
```

There is no `--jcodemunch-only` install flag, and there does not need to be — `roborepo
enable` is the right surface for that.

---

## Phases

### Phase 0 — Read-Only Config State View

**Goal:** See what is currently active and inactive before adding any controls.
Build this first so the control panel has something to display.

#### Terminal: `roborepo config status`

New command (or `roborepo status`) that prints a structured view of current state:

```
packages
  [x] jcodemunch      (mcp + hooks + permissions + rules)
  [ ] jdocmunch       (not enabled)

bundles
  [x] base
  [x] skills
  [x] hooks
  [x] mcp
  [ ] telemetry       (disabled)

install
  mode:    managed
  presets: onboarded 2026-06-15
```

Data sources:
- `~/.roborepo/presets/state.json` — bundle selections
- `~/.roborepo/install-state.json` — install mode
- `~/.roborepo/telemetry/state.json` — telemetry enabled
- `manifests/inventory/packages.json` — full package catalog (to show inactive)
- `manifests/platform/presets.json` — full bundle catalog (to show inactive)
- `~/.claude/settings.json` — live hooks/permissions for comparison

The command does not write anything.

#### Web: Config tab in the telemetry dashboard

The telemetry server (`telemetry-serve.mjs`) gets two new routes:

- `GET /api/config` — JSON: same data as the terminal view (packages, bundles, install
  state, active hooks count, active permissions count). Reads the same files.
- `GET /config` — static HTML shell for the config view (or a JS-driven tab on the
  existing dashboard page).

The dashboard currently serves one HTML shell from `/`. The lightest option is a
second HTML shell at `/config` that shares the same CSS variables and panel component
style as the telemetry view — no build step, same stdlib `http` server. A nav link
at the top of each page lets the user switch views.

Config view panels:
- **Packages** — active (checkmark) vs available (grayed), components listed per package
- **Bundles** — which presets are selected
- **Install state** — mode, timestamps
- **Active hooks** — count by event and harness (read from settings.json)
- **Active permissions** — count and list (read from settings.json)

The view is read-only. No controls yet.

**Phase 0 target for today:** terminal command + web config tab.

---

### Phase 1 — Interactive Config Controls

**Goal:** `roborepo onboard` and the web Config tab let the user toggle active items
on/off. The organization mirrors the four sections already displayed on `/config`:

| Section | Controls |
|---|---|
| Token Optimization | Toggle each tool: jcodemunch, jdocmunch, Caveman, Telemetry |
| Workflows | Toggle each skill/command pair (install or remove its symlink) |
| Code Conventions | Toggle each auto-loaded skill (install or remove its symlink) |
| Permissions | Select permission profile |

The full install headless path (`run_post_install_onboarding()` in `install/main.sh`)
is NOT restored — install keeps its headless apply-all. `roborepo onboard` becomes the
place for post-install adjustments.

**Terminal (`roborepo onboard`):** Restore `presetsOnboard()` interactive body from
`onboarding-reinstatement.md §2` as a starting point, then reorganize its sections to
match the four categories above instead of the old bundle list. Keep the headless
fallback for non-TTY. Do NOT restore the forced gate.

**Web portal:** Add toggle controls inline to each existing section on `/config`.
Toggling a row posts to the appropriate endpoint and the view refreshes from
`/api/config`. No separate Onboarding tab — the Config tab gains write capability.

**Endpoints needed:**
- `POST /api/config/packages` — `{ id, enabled: bool }` — calls `enablePackage` or `disablePackage`
- `POST /api/config/skills` — `{ id, enabled: bool }` — installs or removes a per-skill symlink
- `POST /api/config/permissions` — `{ profile }` — re-renders the permission profile

**Phase 1 is the first place anything writes config.** Each endpoint validates input,
mutates only the targeted item, and returns the updated config snapshot.

---

### Phase 2 — Package Disable + Persistence

**Goal:** `disablePackage()` is the missing half of `enablePackage()`. Packages
selected or deselected via Phase 1 persist in preset state so `roborepo update`
can reconcile them.

- **`disablePackage(id)` in `packages.mjs`.** Reverses each component type: removes
  MCP entry, removes matching hook entries, removes permissions. Idempotent.
- **Persist skill selection** in preset state under `items.skills: [...]`.
- **Persist package selection** under `items.packages: [...]`.
- **`roborepo update` reconciliation.** Re-enables packages/skills that should be on;
  warns about catalog entries no longer present.

---

## Implementation Checklist

### Phase 0 — Config State View ✓ Done

1. ~~`roborepo config` command~~ — done, `scripts/cli/config.mjs` + `main.mjs`
2. ~~Config data reader~~ — done, `readConfigSnapshot()` + `buildBehaviorView()` in `config.mjs`
3. ~~`/api/config` route~~ — done, `telemetry-serve.mjs`
4. ~~Config HTML view~~ — done, `config-dashboard.mjs` at `/config`
5. ~~Nav update~~ — done, Telemetry ↔ Config links in both dashboard templates

### Phase 1 — Interactive Config Controls

6. **Restore `presetsOnboard()` interactive body** from `onboarding-reinstatement.md §2`,
   reorganized into the four web portal categories (Token Optimization, Workflows, Code
   Conventions, Permissions) instead of the old bundle list. Keep non-TTY headless path.
   Do NOT restore the forced gate.
7. **`POST /api/config/packages` endpoint.** `{ id, enabled }` — calls `enablePackage` /
   `disablePackage`. Returns updated snapshot.
8. **`POST /api/config/skills` endpoint.** `{ id, enabled }` — installs or removes the
   per-skill symlink at `~/.claude/skills/<id>`. Returns updated snapshot.
9. **`POST /api/config/permissions` endpoint.** `{ profile }` — re-renders the permission
   profile into `settings.json`. Returns updated snapshot.
10. **Toggle controls in web config view.** Each item row in Token Optimization, Workflows,
    Code Conventions gains a toggle button. Permissions section gains a profile selector.
    Posts to the matching endpoint; refreshes from `/api/config`.

### Phase 2 — Package Disable + Persistence

11. **`disablePackage(id)` in `packages.mjs`.** Reverses each component type:
    removes MCP entry, removes matching hook entries, removes permissions. Idempotent.
12. **`/api/config/packages` POST.** Accepts `{ enabled: [id, ...] }`. Calls
    enable/disable as needed. Returns updated config snapshot.
13. **Package toggles in web config view.** Checkbox list per package with component
    details on expand; posts to the packages endpoint.
14. **Persist package selection in preset state** under `items.packages: [...]`.
    `roborepo update` reconciles: re-enables packages that should be on, warns about
    packages no longer in the catalog.

---

## Milestones

| # | Target | Status |
|---|--------|--------|
| 0a | `roborepo config status` terminal command | ✓ done |
| 0b | `/api/config` data route | ✓ done |
| 0c | `/config` web view (read-only panels) | ✓ done |
| 0d | Nav between Telemetry and Config views | ✓ done |
| 1a | Restore `presetsOnboard()` interactive body (4-section layout) | next |
| 1b | Toggle controls inline in web Config tab | follow-on |
| 1c | API endpoints: packages, skills, permissions | follow-on |
| 2a | `disablePackage()` | follow-on |
| 2b | Persist skill/package selection in preset state | follow-on |

Phase 0 is the natural starting point: it shows what's currently active (jcodemunch,
telemetry, hooks, rules) with no risk of writing config. Building it first also
validates the data model before adding controls.

---

## Open Decisions

- **Config view as tab vs separate route.** A second route (`/config`) is simpler to
  implement with no JS framework. A tab system on one page avoids two page loads. Tab
  probably wins if the data APIs stay separate; route is fine if the user treats them
  as distinct tools.
- **`POST /api/config/*` authentication.** The server binds loopback-only. Is that
  enough, or do writes need a session token even on localhost?
- **`disablePackage` for MCP.** Removing an MCP entry requires knowing how `claude mcp
  remove` works (or directly editing the MCP config file). Needs a spike before Phase 2.
- **Config status for settings.local.json.** Show local overrides as a separate section,
  or merge with the main permissions view?
- **`roborepo update` and packages.** Should `update` re-run `enablePackage` for
  selected packages (to pick up new hook/permission additions in the catalog), or only
  run if something is detectably out of sync?

---

## Related

- [`config-panel-behavior-sections.md`](config-panel-behavior-sections.md) — the
  config-panel section model (Commands, Chat-Time Output) and the superseded-wizard
  history. This doc covers the control-panel phases built earlier.
- [`onboarding-reinstatement.md`](onboarding-reinstatement.md) — exact code and test
  changes needed to restore the bundle-toggle wizard (Phase 1 source).
- [`cleanup-before-reinstall.md`](cleanup-before-reinstall.md) — steps to get from
  the current hand-assembled state to a clean full install.
- `scripts/cli/packages.mjs` — `enablePackage()` implementation.
- `scripts/cli/telemetry-serve.mjs` — server route pattern to follow for new routes.
- `scripts/cli/telemetry-dashboard.mjs` — dashboard HTML pattern for the config view.
