# roborepo CLI Internals

How the `roborepo` command is built, for people changing it. The user-facing command reference is
[roborepo CLI Commands](../user/reference/roborepo-cli.md).

## Modules

`roborepo` is a Node program invoked through the `bin/roborepo` shim. `scripts/cli/main.mjs` is a
thin composition root; commands are declared as JSON under
`manifests/platform/cli/command-definitions/` and implemented in modules under `scripts/cli/`:

| Module | Owns |
| --- | --- |
| `scripts/cli/skills.mjs` | `skill adopt`, `skill inspect`, `skill native`, `skill export-to-project`, `skill link-project` |
| `scripts/cli/skill-inventory.mjs` | read-only skill inventory used by `skill inspect` and `/agents` source popups |
| `scripts/cli/index.mjs` | `index code\|docs`, `index code --watch`, `run` |
| `scripts/cli/browser.mjs` + `scripts/cli/browser/` | `browser probe\|run`: package gate, provider contract and validation, Playwright and stub providers, evidence store, local-service lifecycle |
| `scripts/cli/mcp.mjs` | `mcp add` (registration with every MCP-capable harness) |
| `scripts/cli/presets.mjs` | `library` / `package manage` (one shared `packageLibrary` execution preset), `bundle status\|apply\|check\|remove` |
| `scripts/cli/initialize.mjs` | `init` — orchestrates setup, harness discovery, the Package Library handoff, and apply |
| `scripts/cli/initialization-state.mjs` | reads/writes `<stateRoot>/initialization.json`; owns the missing / in-progress / complete distinction |
| `scripts/cli/first-run-routing.mjs` | decides whether a bare `roborepo` enters `init`; pure function of (argv, phase, tty) |
| `scripts/cli/telemetry.mjs` | `web`, `telemetry install\|enable\|disable\|status\|report\|export\|backup\|purge\|capture` |
| `scripts/harnesses/transcript-locate.mjs`, `scripts/harnesses/transcript-parse.mjs` | locate and parse harness transcripts for telemetry capture |
| `scripts/cli/telemetry-analyze.mjs` | sessions, spikes, spike causes, token contributors, usage windows, spike-vs-normal |
| `scripts/cli/portal-server.mjs` + `portal/` | loopback-only web portal routes and static assets |
| `scripts/cli/paths.mjs` | shared `repoRoot` / `sharedSkillsDir` |
| `scripts/cli/skill-lib.mjs` | shared Node core (zip, prompts, symlink helpers) |

The CLI uses only `node:` built-ins — no external `zip`/`unzip`/`ln` — so it runs on macOS, Linux,
and Windows (Git Bash).

The lifecycle verbs dispatch to `scripts/install/main.sh`, `scripts/doctor.sh`, and
`scripts/verify-install.sh`. Most maintainer-only scripts (`test-*.sh`) are intentionally not
exposed through `roborepo`; `skill sync-global` and `rules` are, because shared-skill and
generated-rule editing are documented maintainer workflows.

## Package-Owned CLI Commands

Some `roborepo` commands are package-owned. The command name is part of the stable CLI surface and
needs a command definition, but the executable recipe lives on a package `cli-command` resource in
`globals/packages/<package>/package.config.json` or an equivalent workspace package config:

```json
{
  "type": "cli-command",
  "name": "index code",
  "commandOrUrl": "uvx",
  "args": ["jcodemunch-mcp"],
  "mode": "index"
}
```

Use this pattern when the front-door command should stay stable but the implementation belongs to
an enabled package. `roborepo index code`, `roborepo index code --watch`, and `roborepo index docs`
follow it. Running one resolves the enabled package owner first; if no owning package is enabled,
the CLI tells the user which package to enable.

Lifecycle:

- `roborepo package enable <package-id>` records command ownership in
  `~/.roborepo/enabled-packages.json` for packages with `cli-command` or `rule` resources.
- `roborepo package disable <package-id>` removes that ownership.
- `roborepo doctor` validates command resource shape and duplicate ownership inside package
  dependency closures; `roborepo doctor --installed` checks live install links too.
- `roborepo maintenance repair` relinks moved install paths and preserves package command state,
  because the command registry is path-independent runtime state.
- `roborepo uninstall` removes `~/.roborepo/enabled-packages.json`, so no package command ownership
  survives uninstall.

## Browser Commands

`roborepo browser` is a core namespace rather than a package `cli-command`, because a package
command can only wrap one external process and cannot register a namespace. The package still owns
the feature: `scripts/cli/browser/gate.mjs` refuses both commands unless `feature-verification` is
effective (`effectiveEnabledIds`).

`scripts/cli/browser.mjs` only orchestrates: gate, parse, prune evidence, start or reuse the local
service, call the provider, validate, print. A provider that throws (a scenario that does not load,
a browser that does not launch) becomes a `blocked` run or an unavailable probe, so `--json` output
is always a result. The pieces it calls:

| Module | Role |
| --- | --- |
| `browser/result.mjs` | The contract: status values, `statusFromChecks`, and validators. `passed` requires at least one executed check and no failed one; every artifact path must exist. The CLI validates every provider result before printing it. |
| `browser/providers.mjs` | Static map of providers. `playwright` is the default; `stub` answers from a JSON fixture and is selectable only with `ROBOREPO_BROWSER_STUB=1`, for tests. |
| `browser/playwright-resolve.mjs` | Finds Playwright: the scenario's project first, then `<stateRoot>/browser/tools/`. Builds the install command (version pinned to this repo's `@playwright/test` devDependency) and checks Playwright's browser cache for the headless shell matching the full browser's revision (what a headless launch actually uses; the full browser need not be installed) and ffmpeg, without launching. |
| `browser/playwright-spec.mjs` | Runs a project test file with the project's runner and config (`--reporter=json`, `--trace=on` when asked), maps tests to checks, and adopts attachments as evidence. Stops the runner with SIGINT, which Playwright treats as a graceful shutdown that also stops the config's `webServer`. |
| `browser/playwright-script.mjs` | Runs a script scenario in one browser context, with recording and tracing configured before the script starts. |
| `browser/evidence.mjs` | Flat per-run file names in the `browser-evidence` retention store; prunes by the store's policy before a run writes. |
| `browser/local-service.mjs` | Reuses a URL that already responds; otherwise starts `--serve` in its own process group and stops only that group, even after the shell that led it has exited. |
| `browser/owned-processes.mjs` | Stop functions for every process a run started (the `--serve` group, the test runner), called on SIGINT/SIGTERM to the CLI so an interrupted run strands nothing. |

A second real provider is another entry in `providers.mjs` returning the same shapes; it must pass
`scripts/test/browser-contract-check.mjs` unchanged. Scenario files are provider-specific and are
not expected to port.

## First-Run State

`roborepo web` and `roborepo init` share one bootstrap, `ensureInitialized()`, which creates the
workspace/state roots, refreshes harness discovery, and records initialization. The record at
`<stateRoot>/initialization.json` is the only thing that distinguishes a never-initialized install
from a finished one — directory existence is not evidence, since `setup` can create the workspace on
its own. An interrupted first run is resumable; a completed one re-runs as a no-op report.

`first-run-routing.mjs` sends only a bare, interactive `roborepo` into `init`. Explicit commands
always run regardless of initialization state, and a bare non-interactive invocation goes to the
normal menu so automation is never dropped into a wizard it cannot answer.

The install-time file operations (root config baselines, command links, hook links, Codex rules)
have no user-facing verb: `roborepo update` re-applies them and `roborepo uninstall` reverses them.
The internal `roborepo bundle` verb exists only for `scripts/install/main.sh` and back-compat
scripts, and is intentionally absent from the usage and menu.

## Portal Startup

`roborepo web [--detach] [--no-open] [--port <n>]` (default `4317`) runs the bootstrap above, then
starts the portal on `127.0.0.1`. `--detach` forks it into the background and writes
`~/.roborepo/portal/server-<port>.pid`.

Before binding, it probes an occupied port through `/api/portal/status`, which reports a content
hash of the served portal source. A portal running current code is reused. One that is alive but
running code from before a `git pull` — a detached server outlives the CLI invocation that started
it, and Node never re-reads changed `.mjs` files — is killed and restarted on the same port. An
unhealthy or unrecognized listener on the default port makes the new server pick a fallback port.

See [Portal Architecture](portal-architecture.md) for page, route, and mutation-token internals.

## Telemetry Capture Internals

The capture hooks are package-owned (`globals/packages/telemetry/hooks-{claude,codex}.json`).
Enabling the telemetry package through the portal or CLI installs the hooks and writes
`~/.roborepo/telemetry/state.json {enabled:true}` in the same operation.
Each `<harness>.jsonl` spool is capped at ~25 MB: when exceeded, the oldest records are dropped and
the newest ~70% kept. Per-session token cursors live under `~/.roborepo/telemetry/collector/` and
back the `delta_tokens` computation.

MCP tool attribution resolves both the prefixed wire name (`mcp__<server>__<tool>`) and the bare
tool names Codex sometimes logs (e.g. `search_symbols`), via a known-tool table in
`telemetry-transcript.mjs` — without it, Codex MCP usage is undercounted.

For demos and dashboard development, `node scripts/cli/telemetry-seed-demo.mjs` writes synthetic
sessions to a dedicated `spool/demo.jsonl`, picked up alongside real spools; rerun with `--clear` to
remove it. It never touches the real `claude.jsonl` / `codex.jsonl` spools.

The capture record schema, markers, experiments, and API routes are documented in
[Telemetry](../user/reference/telemetry.md).

## Tests

`scripts/test/test-cli.sh` smoke-tests the subcommands against throwaway temp repos and touches no
global state. It covers skill link-project/sync-global/inspect/prune/uninstall/conflict, `skill new`
scaffolds, the native escape-hatch guide, the audit check, export/override/firewall/self-pollution
guards, slash-command render checks, `package manage`/`bundle` onboarding/apply/remove/status,
`telemetry` enable/status/report, `run`, `mcp add` dry-runs plus real Codex/Claude writes against a
throwaway harness root, lifecycle/rules dispatch, and menu fallback.
