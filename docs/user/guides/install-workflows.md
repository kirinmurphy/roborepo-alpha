# Install Workflows

## Purpose

This guide covers the checkout installer and its lifecycle: preview, install, update, and uninstall,
plus moving a verified package to a new Mac. The installer copies RoboRepo-owned files into your
harness homes, renders rules, and preserves your own config; the one choice it asks you to make is
the [collision policy](#collision-policy).

## Workflow Shape

1. Run a dry-run preview when you want to inspect planned paths.
2. Run the installer.
3. Choose a collision policy when the first run asks.
4. Let onboarding enable optional packages and skills.
5. Verify with `roborepo doctor --installed`.

## Preview

```sh
./scripts/install/main.sh --dry-run
```

Dry-run reports the shell/PATH actions, install state write, base rule render, and base bundle application it would perform. It does not mutate home config.

For automation, `--no-presets-onboard` or `ROBOREPO_PRESETS_ONBOARD=skip` skips install-time
onboarding.

## Install

```sh
./scripts/install/main.sh
```

The installer writes:

- rendered base rules to `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`
- copied RoboRepo-owned files such as markers, commands, hooks, and Codex rules
- copied root config baselines when no local file exists
- `builtin-support` in each installed harness skill directory
- `~/.local/bin/roborepo`
- install state at `~/.roborepo/install-state.json`

Then it applies the default `base` bundle. Choosing the optional behaviors is `roborepo init`'s job, not the installer's. On update, that base bundle still re-applies so rendered rules stay fresh even on an already-initialized machine.

## Verification

```sh
roborepo doctor --installed
```

`doctor --installed` checks the active machine state, including rendered home rules and base skill copies.

## Collision Policy

The collision policy decides what happens when a file RoboRepo manages already exists locally and
differs from the repo version. It applies to the checkout installer and to every `roborepo update`
(or `roborepo config apply`). The first run asks which policy to use and saves your answer:

| Policy | Use when | Result |
| --- | --- | --- |
| `keep` | You already have local Claude/Codex config you want active. | Leave the existing file active and stage the repo candidate beside it as `*_update_TIMESTAMP`. |
| `overwrite` | The repo baseline should replace the local file. | Move the existing file to `*_original_TIMESTAMP`, then copy the repo file into place. |
| `abort` | You want to review conflicts by hand first. | Stop instead of changing the conflicting path. |

Root config files (`settings.json`, `config.toml`) are merged rather than replaced, so your
settings survive; if you edited one since RoboRepo last wrote it, `keep` leaves it untouched. See
[Root Config Drift Detection](../reference/config-collision-handling.md#root-config-drift-detection).

Pass `--on-conflict keep|overwrite|abort` to choose explicitly:

```sh
./scripts/install/main.sh --on-conflict keep
roborepo update --on-conflict overwrite
```

Without the flag, RoboRepo reuses your saved choice (`~/.roborepo/install-state.json`); a first
noninteractive run defaults to `keep`.

## Update

```sh
roborepo update
```

`roborepo update` re-runs the installer against the current repo source, refreshes copied files, re-renders rules from the registry, and keeps the saved conflict policy unless `--on-conflict` overrides it. It is safe to re-run.

After a successful update it prints a concise change report, for example:

```text
changed: rules claude
changed: skill builtin-support
unchanged: package registry
```

## Uninstall

Removal has **two owners**:

| Step | Removes | Owned by |
| --- | --- | --- |
| `roborepo uninstall` | RoboRepo-managed harness configuration and machine-local state, then the npm application in package mode | RoboRepo, then npm |
| `npm uninstall -g codethings-roborepo-alpha` | the application files npm installed | npm |

On current package installs, run:

```sh
roborepo uninstall
```

**Removing the npm package alone does not remove your RoboRepo configuration, or the
files RoboRepo projected into your harnesses.** Those live outside the package directory, so npm
does not know about them. Development-checkout mode still skips npm removal because npm does not own
the checkout.

Managed cleanup removes RoboRepo-owned copied files, rendered rules, managed skill copies, shell
wiring, package projections, and machine-local state. If a genuine pre-install backup exists under
`~/.roborepo/backups/pre-install/`, it is restored. Content that has drifted from what RoboRepo
wrote, and harness files RoboRepo does not own, are left alone and reported.

### What uninstall keeps

By default `~/.roborepo/workspace` survives uninstall:

```sh
roborepo uninstall            # ~/.roborepo/workspace preserved
roborepo uninstall --dry-run  # preview; changes nothing
```

To remove it as well, ask explicitly. Combined with `--dry-run`, it still only previews:

```sh
roborepo uninstall --delete-workspace
```

Noninteractive runs refuse to remove anything unless you pass `--yes`, so a script cannot delete
your configuration by accident:

```sh
roborepo uninstall --yes
```

The portal exposes the same managed cleanup at `/agents` → **Maintenance**, with a preview and an
explicit confirmation. The browser action is preserve-only: there is no workspace-deletion control
there, because that is a deliberate typed choice rather than a button.

## New-Mac Package Install

This is a separate workflow from the checkout-based install above. Use it when you want to get
`roborepo` running on a new Mac from a real npm package artifact, before that Mac has a clone of
this repository. Keep the bare `roborepo` command pointing at the packaged snapshot. Use package-mode
commands such as `roborepo config apply` to materialize live configuration.

### 1. On the old Mac: build and verify a transfer artifact

From a clean checkout (no uncommitted changes — the tool refuses otherwise, since the artifact's
recorded source commit must match the bytes it ships):

```sh
npm run prepare:new-mac-install -- --output-dir ~/roborepo-transfer
```

This packs the real npm tarball, installs it into an isolated prefix and temporary home (nothing
touches your real `~/.roborepo` or global npm), and runs a package-mode smoke test against it. Only after all of that passes does it write three files
into `~/roborepo-transfer` (real npm-generated names, e.g. `codethings-roborepo-alpha-0.1.0-beta.0.tgz`):

- `<tarball-name>.tgz` — the tarball that passed every check
- `<tarball-name>.tgz.sha256` — its checksum
- `install-manifest.json` — package name/version, the exact git commit it was built from, and
  which commands it was verified against

It also prints the exact commands you'll need next, with the real filenames filled in. Keep that
output, or just re-read the filenames from `install-manifest.json` and follow the steps below.

### 2. Transfer `~/roborepo-transfer` to the new Mac

AirDrop, USB drive, `scp`, whatever moves files between the two machines. Copy the whole directory
so the tarball and its checksum stay together.

### 3. On the new Mac: verify and install

```sh
cd ~/roborepo-transfer   # wherever you copied it to
shasum -a 256 -c <tarball-name>.tgz.sha256
npm install -g ./<tarball-name>.tgz
```

The checksum check confirms the transfer didn't corrupt the file. `npm install -g` installs it
globally, the same way a published package would install — `roborepo` is now on your `PATH`
without a repo checkout anywhere on this machine.

Then set it up for first use:

```sh
roborepo web
```

The first `roborepo web` runs one-time setup (see [First-Time Setup](first-time-setup.md#install-the-package)).
It should succeed with no harness binaries installed and no native harness home/config created yet
— zero detected harnesses is a valid outcome.

Confirm the result:

```sh
roborepo version
roborepo harness list
roborepo doctor
```

The lower-level primitives (`setup`, `harness refresh`, `config apply`) still exist and are what
the automated package smoke test drives, but a person setting up a machine only needs `roborepo web`
(or `roborepo init` for the terminal chooser).

### 4. Roll back if needed

```sh
npm uninstall -g codethings-roborepo-alpha
```

### 5. Clone for development later

Clone the repository only after the packaged baseline works. Do not run the checkout installer just
to materialize harness config; doing that can replace or shadow the packaged global command with a
checkout symlink.

```sh
git clone <repo-url>
cd roborepo
./bin/roborepo version
```

Use:

- `roborepo` for the globally installed package snapshot;
- `./bin/roborepo` for development code from the checkout.

Both entry points may write the same live `~/.roborepo` and harness config. Check which code path
ran with `roborepo version` or `./bin/roborepo version` before comparing behavior.

Maintainers repeating development-vs-package environment permutations: see
[Test Scenarios](../../internal/test-scenarios.md).
