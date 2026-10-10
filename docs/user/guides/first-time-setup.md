# First-Time Setup

Use this guide to install RoboRepo, run it for the first time, and choose which behaviors it
manages.

Works with Claude Code, Codex, and Gemini CLI — any one of them, or any combination. RoboRepo
discovers whichever are installed and manages those; see
[Supported Harnesses](harnesses/supported-harnesses.md) for what each one receives. Requires
**Node.js 20+**. Supports macOS and Linux; Windows is available but less tested — see
[Windows](#windows).

## Choose An Install Path

| Path | Use when | Start with |
| --- | --- | --- |
| npm package | You want to use RoboRepo | `npm install -g codethings-roborepo-alpha` |
| Git checkout | You are developing RoboRepo, or want your config sourced from a clone | `./scripts/install/main.sh` |
| Offline transfer | Moving a verified package to a machine before it has the repo | [New-Mac Package Install](install-workflows.md#new-mac-package-install) |

## Install The Package

```sh
npm install -g codethings-roborepo-alpha
roborepo web
```

The first `roborepo web` runs one-time setup, then opens the portal. Setup creates RoboRepo's
directories under `~/.roborepo`, detects which agent harnesses are on this machine, and records that
initialization completed. Later runs only start the portal.

Prefer the terminal? Run `roborepo init` instead. It runs the same setup, then asks whether to
configure in the browser or in the CLI.

Setup itself leaves your existing Claude and Codex config alone; behaviors you turn on afterwards
are merged into it. Setup is safe to re-run: once complete it reports that and exits, and an
interrupted run resumes instead of starting over. Zero detected harnesses is fine; install or launch
a harness later, then open **Settings → Agent Harnesses → Check for harnesses**. The equivalent CLI
command is `roborepo harness refresh`.

## Install From A Checkout

From the root of a clone, preview and then install:

```sh
./scripts/install/main.sh --dry-run
./scripts/install/main.sh
```

The installer puts `roborepo` on your `PATH`; open a new shell afterwards so it resolves. It ends
with a welcome menu that can open the behavior chooser. Then use `roborepo web` or `roborepo` as
above.

On its first run the installer asks what to do with Claude or Codex files you already have — keep
them, overwrite them, or stop — see
[Collision Policy](install-workflows.md#collision-policy).

## Choose Behaviors

Only the baseline is applied automatically; everything else is opt-in (telemetry stays off unless
you turn it on). Choose behaviors in the portal's `/config` page, or in the terminal chooser:

```sh
roborepo library
```

The chooser walks the available package sections, then a read-only Permissions panel, one section per
step:

| Key | Action |
| --- | --- |
| `←` / `→` | Move between sections |
| `↑` / `↓` | Move within a section |
| `Space` | Toggle the highlighted item |
| `Enter` | Advance (finishes on the last step) |
| `Esc` | Finish early |

`roborepo library` and `roborepo package manage` are two names for the same chooser. Rerun it any
time to change your choices. Noninteractive runs skip it and apply the baseline headlessly.

## After Setup

```sh
roborepo                     # interactive menu
roborepo update              # pick up new or changed config
roborepo doctor              # health check
roborepo doctor --installed  # verify the installed harness paths
```

There is no separate `install` verb; `roborepo update` re-applies configuration. On a package
install, the first `roborepo update` asks what to do with Claude or Codex files you already have —
keep them, overwrite them, or stop — see [Collision Policy](install-workflows.md#collision-policy).

## Windows

Windows needs two things first:

- **Git for Windows** ([git-scm.com](https://git-scm.com)), which provides Git Bash for hook scripts
  and bin commands.
- **Developer Mode** (`Settings > System > For Developers`) or an **administrator PowerShell**, so
  the installer can create symlinks.

From a checkout, install from PowerShell, or run the usual installer from Git Bash, which calls the
same PowerShell script:

```powershell
.\scripts\install\install-windows.ps1
```

Harness config lives under your user profile, as on other platforms:

| Harness | Path |
| --- | --- |
| Claude Code | `%USERPROFILE%\.claude\` |
| Codex | `%USERPROFILE%\.codex\` |
| Gemini CLI | `%USERPROFILE%\.gemini\` |

After a checkout install, add `~/.local/bin` to your `PATH` to call `roborepo` from PowerShell — see
[Install and PATH](../reference/roborepo-cli.md#install-and-path).
