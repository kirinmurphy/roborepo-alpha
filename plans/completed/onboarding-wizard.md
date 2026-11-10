---
id: onboarding-wizard
priority: none
next_action:
blocked_by: []
depends_on: []
related: []
reviewed_commit:
---

# Onboarding Wizard — Implementation Plan

> **Status: completed.** The item-level, multi-step `roborepo onboard` wizard shipped. It mirrors
> the `/config` behavior sections, uses a base-only default install, and is covered by
> `test-install-collisions.sh` and `test-roborepo.sh`. This file is kept as implementation history.

## Goal

Turn the install flow into: **fresh install applies only the `base` baseline, then launches an
interactive, multi-step onboarding wizard** that mirrors the read-only `/config` 5-section display and
lets the user toggle each item. CLI first; web `/config` stays read-only until the CLI ships.

## Key finding — most of this already exists

The current `presetsOnboard()` / `runInteractiveOnboard()` in `scripts/cli/presets.mjs` is **already
the item-level, /config-mirrored wizard** — not the old bundle-toggle. It:

- derives sections live from `buildBehaviorView(readConfigSnapshot())` (`config.mjs:173`), the SAME
  snapshot the read-only `/config` display uses → terminal and web stay in lockstep;
- toggles individual items via `applyItemToggle()` → the same `config-mutate` primitives the web POST
  endpoints use;
- has the Permissions profile sub-flow with looser-profile confirmation.

What it is NOT yet, and what this plan adds:

1. It is a **flat single-list loop** (pick item → toggle → return to list). We want a **multi-step
   wizard**: one section per step, `←/→` to move between steps, `↑/↓` + Enter/Space to toggle within a
   step.
2. It is **not launched** — three disable points still short-circuit it (see "Wiring" below).
3. Default install set is all four bundles, not minimal.

So the old bundle-toggle wizard is already gone. The plan §267 prophecy ("replaced, not restored")
already happened. We discard the *bundle-toggle docs/code remnants*, keep the item-level engine, and
build the step-nav UI on top.

## The 5 sections (source of truth: `config.mjs:173` `buildBehaviorView`)

Order for the wizard steps (per request, token-optimization first):

1. **Token Optimization** — toggle jcodemunch / jdocmunch / caveman / telemetry (packages)
2. **Commands** — toggle command skills (`setSkillInstalled`)
3. **Code Conventions** — toggle convention skills (`setSkillInstalled`)
4. **Chat-Time Output** — toggle the inline chat-note rule packages (`mutatePackage`)
5. **Permissions** — profile picker (read-only toggle; opens the existing `chooseProfile` sub-flow)

(Confirm exact item membership against `buildBehaviorView` at build time; the wizard renders whatever
the snapshot returns, so it auto-tracks future section changes.)

## Work breakdown

### 1. New wizard-step UI primitive — `scripts/cli/prompts.mjs`

`selectMenu` only supports ↑/↓/k/j/Enter/Esc on a single list — **no left/right**. Add a new
`wizard(steps, opts)` (do NOT overload selectMenu):

- Renders one step at a time: a title bar `Step N/5 · <Section>  (←/→ sections · ↑/↓ move · Space
  toggle · Enter next · Esc finish)`, then the section's toggle rows with `[x]/[ ]` marks.
- Keys: `←/h` prev step, `→/l` / Enter next step (Enter on last step = finish), `↑/↓/k/j` move within
  step, `Space` toggle current row (calls a per-item `onToggle` callback that runs the real mutate and
  re-reads state so the `[x]` reflects truth), `Esc/q` finish early.
- Non-TTY: skip entirely — caller already falls back to headless `presetsApply(["--default"])`.
- A "step" that is non-toggle (Permissions) renders its row as an action that opens a sub-menu on
  Space/Enter rather than flipping a mark.
- Reuse the raw-mode/keypress/redraw scaffolding from `selectMenu`; factor the shared ANSI redraw
  helper if it keeps it clean (optional).

### 2. Rewrite `runInteractiveOnboard()` — `scripts/cli/presets.mjs`

- Build `steps` from `buildBehaviorView(readConfigSnapshot())` in the fixed order above, filtering to
  toggleable items per the existing `toggleable` logic (presets.mjs:133-137).
- Drive the new `wizard()`; each toggle's `onToggle` calls the existing `applyItemToggle(section,
  item)` (already correct), then re-reads the snapshot so the displayed mark updates.
- Permissions step: on activate, call the existing `chooseProfile(profileItem)`.
- On finish: keep `markOnboarded()`.
- Delete the flat-loop body and its now-unused `menu/actions` assembly.

### 3. Minimal default install — `manifests/platform/presets.json`

- Change `"default": ["base", "rules", "hooks", "commands"]` → `"default": ["base"]`.
  - Verified safe: `withDependencies` (presets.mjs:389) only forces `hooks` when `telemetry` is
    selected; base/rules/commands have no forced deps. `base`-only = root config baselines
    (settings.json, CLAUDE.md, config.toml, managed markers) → a working but minimal harness.
  - NOTE: `rules` (Codex command permission rules) and `hooks` are currently auto. Dropping them to
    opt-in is the intended "start with nothing." Double-check at build time that a base-only Codex
    install is not broken without `rules` — if it is, keep `rules` in the minimal default and make
    only hooks/commands opt-in.

### 4. Wiring — launch wizard after install (`scripts/install/main.sh` + `presets.mjs`)

Per decision "base + nothing auto, prompt for rest":

- `run_post_install_onboarding()` (main.sh:396): on an **interactive** install, after the base apply,
  launch `node scripts/cli/main.mjs onboard` (the wizard). On non-interactive, keep headless default
  apply. (This is close to the disabled original in onboarding-reinstatement.md §3 — reinstate the
  interactive-launch branch, but pointing at the new wizard.)
- `presetsOnboard()` already routes TTY → `runInteractiveOnboard()`, non-TTY → headless. Good.
- Decision: do **not** reinstate the forced gate (`maybeRunPresetOnboarding`, §1). Keep it a
  pass-through. The wizard runs once at install and is rerunnable via `roborepo onboard`; we don't
  block other commands until onboarding.

### 5. Discard bundle-toggle remnants

- `presets.mjs`: remove `printBundleChoices()` and `resolveSelection()` (presets.mjs:343-368) — only
  the dead bundle-toggle used them. Confirm no other caller first.
- `docs/plans/completed/onboarding-reinstatement.md`: this records the OLD bundle-toggle for restoration. Once
  the new wizard ships, supersede it — replace its body with a pointer to this plan (keep as historical
  record, mark superseded), or delete. Recommend supersede-pointer.

### 6. Docs

- `docs/user/guides/first-time-setup.md`: describe the post-install wizard (5 steps, ←/→ nav) and that
  `roborepo onboard` reruns it. Note minimal default.
- `README.md` "Global Behavior": replace "installs everything automatically" copy with "install lands
  a minimal baseline, then the onboarding wizard lets you pick behavior; rerun with `roborepo
  onboard`."
- `docs/user/guides/install-workflows.md`: update the managed/adopt walkthroughs to show the wizard step.

### 7. Tests — `scripts/test/`

- `test-roborepo.sh`: add a non-TTY `roborepo onboard` test → asserts headless default apply +
  `onboardedAt` set. Add a `presets.json` default = `["base"]` assertion (only base applied on fresh
  install).
- `test-install-collisions.sh`: ensure base-only install still passes collision handling.
- Wizard keystroke flow is hard to unit-test in bash; cover the wizard's pure pieces (step list
  construction, toggle→mutate mapping) with a small node assertion if practical, else manual-verify.
- Run `scripts/test/test-roborepo.sh`, `scripts/test/test-install-collisions.sh`, `scripts/doctor.sh`
  → green.

## Verification

1. Fresh state (already uninstalled): `./scripts/install/main.sh` → confirm only `base` applied, then
   wizard launches.
2. Walk wizard: ←/→ across all 5 steps, toggle items in each, confirm marks reflect real state and
   the underlying config/skills/packages actually change.
3. `roborepo onboard` again → wizard reflects current state, lets you change.
4. Non-TTY: `roborepo onboard < /dev/null` → headless default apply, no hang.
5. `roborepo config` read-only display matches what the wizard set (lockstep check).

## Resolved decisions

- **Minimal default = `["base"]`** (RESOLVED). `rules`/`hooks`/`commands` are all `link` rows in
  manifest.tsv (pure additive: Codex permission rules, lifecycle hooks, slash commands). Nothing
  requires them for a functioning harness — doctor only validates them *if present* (doctor.sh:243,
  267). `base` carries the real skeleton (settings.json, config.toml, CLAUDE.md/AGENTS.md, managed
  markers). Caveat: without `rules`, Codex uses its own default command-permission behavior (less
  locked-down, not broken) — surface this in the Permissions step copy. So flip rules/hooks/commands
  to opt-in. No `rules`-stays exception needed.

- **Key scheme = Space toggle, ←/→ sections, ↑/↓ move, Enter next, Esc finish** (RESOLVED). Enter on
  the last step finishes. Step 1 header example:

  ```
  Step 1/5 · Token Optimization
    ←/→ sections · ↑/↓ move · Space toggle · Enter next

  > [x] jcodemunch
    [ ] jdocmunch
    [x] Caveman plugin
    [ ] Telemetry
  ```

- **Permissions step = read-only display** (RESOLVED). Step 5 shows the active profile + blocked-command
  count from the snapshot, but does NOT edit (matches the "Phase 2 / read-only" intent, presets.mjs:67).
  Do NOT wire `chooseProfile` into the wizard; users change profiles via `roborepo config` /
  `roborepo onboard`'s separate path later. This simplifies step 2 (rewrite) — the Permissions step is
  a render-only panel, no toggle/sub-menu. `chooseProfile` stays in code for the standalone path; do
  not delete it.
