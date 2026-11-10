---
id: onboarding-reinstatement
priority: none
next_action:
blocked_by: []
depends_on: []
related: []
reviewed_commit:
---

# Onboarding UI — Reinstatement Record

> **SUPERSEDED.** The old bundle-toggle onboarding UI described here was *not* restored. It was
> replaced by the item-level, multi-step onboarding wizard (mirrors the `/config` sections, one step
> per section, ←/→ navigation). See [`onboarding-wizard.md`](onboarding-wizard.md) for the shipped
> design. This file is kept only as a historical record of the bundle-toggle surface and how it was
> wired — useful for parity reference, not for restoration.

## Purpose

The bundle-toggle onboarding UI was disabled (not deleted) so that installation auto-applies every
default package/tool silently. Per-feature configuration now lives in the package model and config
control panel (`roborepo onboard` + the `/config` dashboard); see
[`config-control-panel.md`](../../user/reference/config-control-panel.md) and the completed plan
[`config-panel-behavior-sections.md`](config-panel-behavior-sections.md).

This doc records exactly what was removed or changed and how to restore it, so the working,
previously-tested behavior can be brought back without archaeology. It covers all surfaces touched:
the CLI gate and wizard (§1–2), the install script (§3), the README (§4), both test suites (§5–6),
and the two install guides (§7). The *engine* (headless `presetsApply`, the `bundle` subcommands,
`presets.json`) was kept intact — only the user-facing wizard surface and the forced onboarding gate
were removed.

## What stays live (the engine — not removed)

- `presetsApply()` / `requestedBundles()` in `scripts/cli/presets.mjs` — headless default-bundle
  install. Install now calls this directly.
- `roborepo bundle apply|status|check|remove` — scriptable bundle plumbing, still wired in
  `presets.mjs` and `main.mjs`.
- `manifests/platform/presets.json` — the bundle catalog.
- `markTelemetrySelected()` and the telemetry → `presetsApply(["telemetry"])` path.

## What was disabled (and how to restore)

### 1. Forced onboarding gate — `scripts/cli/presets.mjs`

`maybeRunPresetOnboarding()` blocked the first interactive command until onboarding ran, and errored
on non-TTY. It was reduced to a pass-through. To restore, replace the pass-through body with the
original:

```js
export async function maybeRunPresetOnboarding(args) {
  if (process.env.ROBOREPO_PRESETS_ONBOARD === "skip") return args;
  const filtered = args.filter((arg) => arg !== "--no-presets-onboard");
  if (filtered.length !== args.length) return filtered;
  if (!isInstalledCore()) return args;
  if (isBypassCommand(args)) return args;
  const state = readPresetState();
  if (state.onboardedAt) return args;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("onboarding has not run. Run: roborepo onboard");
    console.error("For automation, pass --no-presets-onboard or set ROBOREPO_PRESETS_ONBOARD=skip.");
    process.exit(2);
  }
  await presetsOnboard([]);
  return args;
}
```

### 2. Interactive wizard — `scripts/cli/presets.mjs`

`presetsOnboard()` rendered the bundle toggle UI and read a selection. It now prints an in-progress
notice and applies defaults headlessly instead of prompting. The original interactive body:

```js
export async function presetsOnboard(args) {
  rejectUnknownFlags(args, new Set());
  const catalog = readPresetCatalog();
  const state = readPresetState();
  const current = new Set(state.selected ?? catalog.default);
  const prompter = makePrompter();
  if (!prompter.ask) {
    console.error("bundle onboarding needs an interactive terminal.");
    process.exit(2);
  }

  try {
    console.log("roborepo onboard");
    console.log("These are optional behavior packages you can add.");
    console.log("You can opt in or out of some or all of them.");
    console.log("You can change these settings later by running: roborepo onboard");
    console.log("");
    console.log("Toggle behavior groups. Blank keeps current selection.");
    printBundleChoices(catalog, current);
    const answer = await prompter.ask("Select numbers to toggle, or 'all'/'none': ");
    const selected = withDependencies(resolveSelection(answer, catalog, current));
    applySelection(selected, catalog, { reconcile: true });
    writePresetState({
      selected: [...selected],
      onboardedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bundles: bundleStates(catalog, selected),
    });
    console.log(`bundles: ${selected.size} selected`);
  } finally {
    prompter.close();
  }
}
```

`printBundleChoices()` and `resolveSelection()` were KEPT in place (still used if the interactive
body is restored, and harmless otherwise).

### 3. Post-install onboarding launch — `scripts/install/main.sh`

`run_post_install_onboarding()` launched `roborepo onboard` (the UI) at the end of install. It was
replaced with a headless default-bundle apply. Original function:

```sh
run_post_install_onboarding() {
  if [[ $dry_run -eq 1 ]]; then
    echo "Next: install will start roborepo onboard after core install."
    return 0
  fi

  if [[ "${skip_presets_onboard}" -eq 1 || "${ROBOREPO_PRESETS_ONBOARD:-}" == "skip" ]]; then
    echo "Onboarding skipped. Run later: roborepo onboard"
    return 0
  fi

  if presets_onboarded; then
    echo "Onboarding already complete. Run roborepo onboard to change behavior bundles."
    return 0
  fi

  if ! stdin_is_interactive || [[ ! -t 1 ]]; then
    echo "Onboarding not started because this install is noninteractive."
    echo "Run later: roborepo onboard"
    return 0
  fi

  echo "Starting onboarding."
  echo ""
  node "${repo_root}/scripts/cli/main.mjs" onboard
}
```

(The `presets_onboarded()` helper above it was kept — still valid.)

### 4. README — `README.md`

The "Global Behavior" intro previously described the onboarding prompt and showed the interactive
bundle-toggle terminal block. Both were replaced with auto-apply copy + an HTML comment pointing
here. Original intro prose:

```md
Once you install the `roborepo` core, you will be prompted to install default packages and configurations. You can opt in/out of each one.

After CLI install, you can choose which packages/tools to enable:
```

Original terminal block that followed it:

```text
== roborepo onboarding =================
These are optional behavior packages you can add.
You can opt in or out of some or all of them.

You can change these settings later by running: roborepo onboard

Toggle behavior groups. Blank keeps current selection.
  1) [x] Base guidance (base)
      AGENTS/CLAUDE guidance, managed markers, and root config baselines.
  2) [x] Skills (skills)
      Shared global skills for Claude and Codex.
  3) [x] Codex rules (rules)
      Generated Codex command permission rules.
  4) [x] Hooks (hooks)
      Claude and Codex lifecycle hooks.
  5) [x] Slash commands (commands)
      Global slash command wrappers.
  6) [x] Permission profiles (permissions)
      Rendered harness permission defaults inside root config.
  7) [x] MCP defaults (mcp)
      Default jcodemunch and jdocmunch MCP config inside root config.
  8) [ ] Telemetry (telemetry)
      Local cross-repo metadata capture and reports. Installed off unless selected.
Select numbers to toggle, or 'all'/'none':
```

### 5. Tests — `scripts/test/test-roborepo.sh`

The two assertions tied to the forced gate were disabled (commented with a pointer to this doc):

- `onboard gate: noninteractive command fails before onboarding`
- `onboard gate: explicit bypass allows command`

Both assumed `maybeRunPresetOnboarding` errors/bypasses. With the gate removed they no longer apply.
The `bundle apply/check/remove` and telemetry tests were KEPT — the engine they test is unchanged.
To restore, uncomment those two assertions when the gate is reinstated.

### 6. Tests — `scripts/test/test-install-collisions.sh`

Three interactive-install tests asserted the old onboarding behavior. They were **updated** (not
disabled) to assert the new headless default-apply, because install still applies defaults — just
without the UI:

- `test_fresh_managed` — previously asserted a noninteractive install *defers* onboarding and leaves
  `settings.json`/`config.toml` uninstalled (`Onboarding not started because this install is
  noninteractive`). Now asserts install *applies* defaults headlessly (`Applying default
  configuration`) and the files exist.
- `test_mode_prompt_allows_adopt_on_clean_machine` and `test_mode_prompt_allows_managed_selection` —
  their `expect` scripts waited for `Select numbers to toggle` and answered the toggle prompt. That
  prompt is gone, so the `expect` lines were removed and the assertions now check `Applying default
  configuration` instead of the `roborepo onboard` UI banner.

To restore: re-add the `expect "Select numbers to toggle"` / `send "\r"` lines to those two expect
scripts, and revert `test_fresh_managed` to assert the deferred-onboarding behavior.

### 7. Guide docs — `docs/user/guides/install-workflows.md` and `docs/user/guides/first-time-setup.md`

Two guides walked through the interactive wizard. They were rewritten to describe headless
default-apply. Original content, for restore:

**`install-workflows.md` — post-core-install block (Step 2):**

```sh
Then the onboarding workflow starts:

Starting onboarding.

roborepo onboard
These are optional behavior packages you can add.
You can opt in or out of some or all of them.
You can change these settings later by running: roborepo onboard
```

**`install-workflows.md` — the whole "Step 5: Onboarding" section** (replaced with "Step 5: Default
Configuration"). Original walked through running `roborepo onboard`, the full 8-item toggle list,
toggling telemetry as item `8` (`bundles: 8 selected`), pressing enter to keep the current selection
(`bundles: 7 selected`), turning bundles off (staged updates deleted / backups restored), and a
"What Onboarding Does" list:

```md
The wizard is the machine-level chooser for optional bundles. Re-running it later shows selected
options checked and unselected options unchecked so you can turn any behavior on or off.
When you turn a bundle off, `roborepo onboard` removes the bundle artifact from the place it was
installed: staged updates are deleted in keep-originals mode, and backed-up content is restored in
overwrite or managed mode when a backup exists.

## What Onboarding Does

- Stores bundle selections locally on the machine.
- Applies the selected bundles idempotently.
- Lets you rerun the same workflow later to change your choices.
```

The full original toggle-list block is identical to the README terminal block in §4 — reuse that
when restoring.

**`first-time-setup.md` — original onboarding lines:**

```md
Interactive installs ask for the install mode, then start the onboarding wizard automatically.
If you skip onboarding or run install noninteractively, start the same wizard later with:
```

and the managed-mode table cell: `...point into this repo through symlinks, then you choose optional
bundles separately.`

## Restore checklist

1. Restore `maybeRunPresetOnboarding` body (§1).
2. Restore `presetsOnboard` interactive body (§2).
3. Restore `run_post_install_onboarding` (§3).
4. Reinstate the README onboarding block (§4).
5. Uncomment the two gate tests (§5).
6. Revert the three `test-install-collisions.sh` tests to the interactive flow (§6).
7. Restore the interactive walkthroughs in `install-workflows.md` and `first-time-setup.md` (§7).
8. Run `scripts/test/test-roborepo.sh`, `scripts/test/test-install-collisions.sh`, and
   `scripts/doctor.sh` to confirm green.

When item-level onboarding ships, this UI is most likely *replaced* rather than restored verbatim —
in that case this doc is the record of what the old surface did, for parity reference.
