---
name: roborepo-development
description: >
  Repo-local guidance for developing RoboRepo itself: installer and update flows, package/apply
  state, provider adapters, generated outputs, CLI, portal, and tests. Use for implementation or
  architecture work inside this repository. For shared/exportable agent skills and rules, use
  builtin-support. This skill stays in the development checkout; never install or export it to
  client repositories.
---

# Roborepo Development (internal)

Mechanic's manual for developing roborepo itself. Distinct from `builtin-support`
(operating shared/exportable skill, rule, hook, MCP, and parity content). This skill is
firewalled to this repo — it loads only when an agent works inside this repo.

Use the docs below to find the relevant implementation, then verify current behavior in code.
When a doc disagrees with code, correct the guidance as part of the change.

## Package development

When creating, changing, installing, removing, or reviewing a RoboRepo package (anything under
`globals/packages/<id>/`, or the `roborepo package *` CLI family), load
`references/package-development.md` before editing. Don't restate it here — it owns manifest
schema, resource-type validation depth, apply/reconcile behavior, and the completion checklist.

## Which doc answers which question

| Question | Doc |
|----------|-----|
| Symlink map, sync flow | `docs/user/reference/architecture.md` |
| Shared vs. internal skill layers | `docs/internal/skills-and-commands.md` |
| The current `roborepo` CLI surface | `docs/user/reference/roborepo-cli.md`, `manifests/platform/cli/command-definitions/**`, `manifests/platform/cli/removed.json` |
| Detailed CLI internals | `docs/internal/cli-internals.md` |
| Conflict / collision behavior on install | `docs/user/reference/config-collision-handling.md` |
| Rules generation + layering | `docs/internal/rules-parity-and-layering.md` |
| Provider registry, capability adapters, and new harnesses | `docs/internal/harness-provider-interface.md`, `scripts/harnesses/registry.mjs` |
| Skill/command mechanisms and trigger fixtures | `docs/internal/skills-and-commands.md`, `docs/user/reference/roborepo-skills.md` |
| Hook behavior (Claude / Codex) | `docs/user/reference/{claude,codex}-hooks.md` |
| Portal pages, shared browser code, API routes, and checks | `docs/internal/portal-architecture.md`, `scripts/cli/portal-server.mjs`, `scripts/test/portal-ui/` |
| NPM release workflow and maintainer doc placement | `docs/internal/npm-release.md` |
| Install UX + daily commands | `docs/user/guides/setup-and-daily-use.md`, `docs/user/guides/install-workflows.md` |
| Skills, two layers, client utilities (user-facing) | `README.md` |

## Repo dir convention (the one thing to internalize first)

- `globals/system/` holds required shared behavior; `globals/packages/<package>/` holds selectable
  features; `globals/harnesses/<id>/` holds provider-specific source. `generated/<id>/` is rendered
  install output. The provider registry determines which harnesses receive it.
- `.claude/`, `.codex/`, and `.gemini/` in this checkout are PROJECT-SCOPE config, not the user's
  global harness homes.
- `globals/packages/<package>/skills/<name>/` is the canonical package-owned shared layer;
  `globals/system/skills/<name>/` holds required system skills. Enabled shared skills are
  materialized into `~/.roborepo/skills/<name>`, then linked into each supporting harness's
  native global skill directory.
- `local/skills/<name>/` is the repo-only layer. `scripts/build/link-skills.sh` links it into the
  project-scope skill directory of every registered provider that supports skills (currently
  Claude, Codex, and Gemini). It is not a source for global installation or client export.
- Mutable global config files should not be direct symlinks to repo source; use a generated or
  exported active file so runtime trust, hook approval, and machine-local state stay outside the
  shared baseline.

Everything else (the two symlink levels, the layer table) lives in
`docs/user/reference/architecture.md`. Read it there.

## Operational judgment (not in the docs)

- **Cross-harness behavior is parity in outcome, not parity in execution.** Put shared guarantees
  in the capability contract and provider adapters (`scripts/harnesses/contract.mjs`), rather than
  porting one provider's native mechanism to another. Check the registered providers before changing
  cross-harness behavior; Claude, Codex, and Gemini can implement the same capability differently.
  `validateCapabilityAdapters` checks that each declared capability has its required methods, but
  it cannot prove their behavior. Add behavior checks for the providers affected by the change.
- **Adding any skill:** prefer `roborepo skill new`. Shared skill → a package under
  `globals/packages/`, then run `roborepo skill sync-global` to refresh the machine-local cache and
  harness views. Shared command surfaces are rendered from package `slash-command` resources; run
  `roborepo skill render-commands --check` and `roborepo skill triggers --check` when descriptions
  or command exposure change. Internal/
  repo-only skill → `local/skills/`, then run `scripts/build/link-skills.sh` for this repo's
  project-scope links. Never hand-write `ln`.
- **The firewall is code, not convention.** `link-skills.sh` manages repo-local links;
  installation and export read package/system shared skill sources. There is no code path from
  `local/skills/` to global config or a client export. Don't add one.
- **Reuse the link/conflict primitives.** Bash: `scripts/install/install-lib.sh` (`link_item`,
  `link_item_clean`, collision prompts) and `scripts/build/skill-lib.sh` (`list_source_skills`). Node:
  `scripts/cli/skill-lib.mjs` (`listSourceSkills`, `ensureSymlink`, `linkLocalSkills`, `writeZip`).
  Don't re-derive the "what is a skill" rule or hand-roll `ln`/`symlink` logic.
- **Generated outputs are not editable.** Baseline rules under `generated/<provider>/` come from
  `globals/system/rules/shared/` and provider-specific fragments via
  `scripts/build/render-rules.sh`; `scripts/cli/rules-render.mjs` adds enabled package fragments
  when rendering live home rules. Agent permission outputs are rendered from
  `manifests/inventory/agent-permissions.json` by `scripts/build/render-agent-permissions.mjs`.
  Edit sources, re-render, then check. `doctor.sh` flags drift.
- **`generated/` files are install baselines, not just fixtures.** `generated/<provider>/` is both the
  tracked artifact tests diff against AND `rootConfigBaseline` (`scripts/cli/paths.mjs`), which
  install/apply merges into each provider's live home (`scripts/cli/presets.mjs`).
  Claude's merge UNIONS permission arrays, so anything in the tracked file is additively copied into
  every real home and cannot be removed by a later render. Never change a `generated/` file to make a
  test deterministic: a placeholder that reads as obviously fake in the repo (`/Users/you`) ships
  verbatim to users. Fix the test instead — point it at a temp render, or pass explicit render
  options — and keep the tracked artifact equal to what a real install should produce.
- **Adding global commands:** there is now ONE global command (`roborepo`); prefer adding a
  `roborepo` subcommand over a new `bin/` entry. If you ever DO add a `bin/` command, wire it in
  three places — `install-global-commands.sh` (preflight + `link_command`), `doctor.sh` (file +
  link check), `verify-install.sh` (link check) — or it's half-installed.
- **Script conventions:** idempotent; `--dry-run`; verifiers take `--check`. Collisions warn,
  preserve the local copy, print an agent merge prompt — never clobber.
- **Pre-launch compatibility:** until roborepo has launched and real users depend on public
  behavior, do not add backwards-compatibility shims, deprecated aliases, or old command paths
  when changing features. Prefer one clear current interface. Start supporting deprecated
  commands/features only after launch, when compatibility is an explicit product requirement.
- **`--quiet`/`-q` on the checkers.** `doctor.sh`, `verify-install.sh`, `test-cli.sh`, and
  `link-skills.sh` all accept `--quiet`: suppress the per-check `ok:`/`+ linked` lines, still
  print every failure plus a one-line `… (N checks)` / `N passed, M failed` summary, exit code
  unchanged. Use the bare script + `--quiet` for a readable, permissionable check — never pipe a
  verifier through `grep`/`head` to trim output. `doctor.sh` also folds `link-skills.sh --check`,
  so it is the single repo-health entrypoint (`--installed` adds live global harness
  link checks including per-skill skill links); `test-cli.sh` stays the separate test suite.
- **Health gate before handoff.** After a merge from main, generated-file change,
  provider/adapter change, CI/workflow change, or `scripts/test/` addition/removal, run
  `bash scripts/doctor.sh --quiet` and `git diff --check` before final/push. `doctor.sh` is the
  provider-registry health gate; do not substitute narrower render/catalog checks when the change
  touches harness, provider, test, or CI plumbing.
- **Full CI parity is expensive.** `npm run check` is the full local CI parity gate: main suite,
  install-collisions, package install, and Docker clean-machine checks when Docker is available.
  Do not use it as the default cleanup loop for ordinary review or CodeRabbit feedback. Prefer
  targeted checks plus `bash scripts/doctor.sh --quiet`; reserve `npm run check` for pre-push,
  release, or changes to CI/workflow/test orchestration itself.
- **Docker test sandboxes:** use them for machine-shape behavior: clean `HOME`, clean `PATH`,
  package-mode install/uninstall, fake harness discovery, and generated config projection. Use one
  disposable image, one fresh container per scenario, one package install per scenario, and many
  assertions inside it. Repeating npm install/uninstall per assertion is not scalable; reserve that
  for lifecycle tests whose subject is install/uninstall itself. The doc of record is
  `docs/internal/docker-test-sandboxes.md`.
- **Cross-platform floor:** Node cores use only `node:` built-ins (no shelling to
  `zip`/`unzip`/`ln`), so the same code runs on macOS/Linux/Windows. Keep it that way.
- **Skill discovery paths come from provider manifests.** Currently the project-scope directories
  are `.claude/skills`, `.codex/skills`, and `.gemini/skills`; global paths use the corresponding
  home directories. `link_global_skills` in `scripts/install/install-lib.sh` links each enabled
  shared skill into supporting harnesses. Do not add a hardcoded two-provider list to platform code.
- **`internal` is VISIBILITY, not availability.** Two different axes get conflated constantly:

  | Axis | Mechanism | Means |
  |------|-----------|-------|
  | Visibility | `kind: "internal"` on a command definition | Hidden from menus and scoped help; **still runs fine on end-user machines** |
  | Visibility | `advanced: true` | Kept out of the root menu; still listed under its own namespace's help |
  | Availability | `developmentOnly: true` on a command definition | Not listed, not resolvable, and not helpable off a dev checkout — `roborepo <it>` reports "unknown command" |
  | Availability | Script under `local/` + `requiresDevelopmentCheckout` | Runtime gate for a command that IS reachable but cannot work; prints why and exits 1 |

  The two availability rows are complementary, not alternatives. `developmentOnly` is enforced in
  `command-catalog.mjs` (listing, via `childEntries`) AND `command-resolver.mjs` (resolution, via
  `matchPath` — which walks raw children and would otherwise still open the menu for a command
  every listing hides). `requiresDevelopmentCheckout` is the last line of defence inside the
  command itself. A `developmentOnly` namespace still gets validated on every machine, because
  `validateCommandCatalog` passes `includeUnavailable: true` — a malformed definition that ships in
  the tarball must not fail only on a maintainer's laptop.

  `internal` does NOT mean "not for users" — `setup`, `bundle`, `onboard-intro`, and `presets` are
  all `internal` *because* they are machine-invoked install-time commands that must run on every
  end-user machine. It means "not something a human browses to."

  For dev-checkout-only behavior use `local/` plus the gate. `package.json`'s `files` never
  publishes `local/`, but it DOES publish `manifests/` — so the command definition reaches an npm
  user even when the script it points at does not. Without `requireDevelopmentCheckout()`
  (`cli/roots.mjs`) that surfaces as a bare `missing script:` path error instead of an explanation.
  Belt and suspenders: the script is absent AND the gate fires.
- **The `dev` namespace** (`manifests/platform/cli/command-definitions/dev/`, `cli/dev.mjs`) holds
  development-checkout-only tooling. `dev start`/`dev stop`/`dev status` orchestrate by calling the
  same commands a human would (the fixture script, `web`/`web stop`) so there is one authoritative
  code path per service — do not give the orchestrator its own copy of that logic, and do not add
  thin per-service wrappers that only re-expose what a root command already does. The namespace
  carries `advanced: true` to stay out of the root menu; its children deliberately do not, because
  `includeAdvanced: false` in `help-renderer.mjs` would hide them from `roborepo help dev` too.
- **`web --detach` cold starts are slow.** The portal warms telemetry/developer-runtime views before it
  binds — measured ~29s on a normal dev checkout. `waitForPortalReady` allows 60s for that; do not
  "tidy" it back down to a few seconds or every cold detached start fails while the child goes on
  to bind moments later.
- **Resolve before killing when starting a portal.** Both `serveCommand`'s foreground path and
  `startDetachedPortal` call `resolvePortalPort` FIRST and only `killExistingServer` after the reuse
  branch has declined. The detached path used to kill first, which made its reuse branch dead code:
  every `web --detach` SIGTERMed a healthy portal and respawned it. `resolvePortalPort` already
  covers what the early kill was for — it restarts a STALE portal (one running code that changed
  since it started) and waits for the port to free. Keep the two paths in the same order.

## The `roborepo` CLI (the single consumer front door)

`roborepo` is the ONE command a consumer runs. `scripts/cli/main.mjs` is a thin composition root:
load catalog, resolve command, run adapter. User-facing command metadata lives in schema v2 catalog
files under `manifests/platform/cli/command-definitions/**`; retired command guidance lives in
`manifests/platform/cli/removed.json`. Prefer fixing catalog definitions or docs over command
execution code unless behavior is actually wrong. Subcommand impls live under `scripts/cli/`;
`paths.mjs` defines app/workspace/state roots and package mode, while `skill-lib.mjs` holds shared
Node primitives (zip, prompts, symlink helpers). Bash shim is `bin/roborepo`. No-arg = interactive
menu (arrow keys + numbered fallback via `selectMenu` in `cli/skill-lib.mjs`).
Subcommands, grouped by category:

- `skill new` / `skill adopt` / `skill export-to-project` / `skill link-project` / `skill inspect` /
  `skill audit` / `skill triggers` / `skill render-commands` / `skill native` — shared skill,
  slash-command, ownership, and invocation-policy tools. They operate on the shared/client-local
  layer — never `local/skills/`.
- `index code|docs [path]`, `index code [path] --watch`, `run <cmd>` (`cli/index.mjs`) — package-owned
  jcodemunch/jdocmunch wrappers + the trimmed-output runner. `[path]` is optional, defaults to cwd,
  and resolves to absolute. Before changing the watch pidfile, check the jcodemunch package's
  SessionStart hook and `docs/internal/hooks-internals.md`.
- `mcp add <name-or-url>` / `mcp apply` (`cli/mcp.mjs`) — register/apply MCP server config with
  Claude and Codex. Presets live in `manifests/inventory/mcp-presets.json`; portable intent lives
  in `manifests/inventory/mcp-servers.json`.
- `package enable <package-id>` / `package disable <package-id>` / `package manage` / `presets` — package and preset
  feature toggles. Package mode separates immutable app files, portable workspace resources, and
  machine-local state; do not collapse those roots.
- `package create|list|inspect|validate|enable|disable|reconcile|adopt-live` (`cli/packages.mjs`)
  — full package lifecycle surface. See `references/package-development.md` for details on each subcommand.
  `enable`/`disable` already apply live immediately — no `roborepo update` needed afterward.
- `setup` / `apply` / `workspace` / `version` — package-mode setup and root inspection tools.
- `web` / `telemetry ...` — local portal and telemetry capture/reporting.
- `dev start|stop|status`, `dev fixture start|stop|status` (`cli/dev.mjs`) — development-checkout-only
  tooling, gated by `requireDevelopmentCheckout()`. See the `dev` namespace note above before adding
  to it.
- `update`/`repair`/`uninstall`/`doctor`/`rules`/`permissions` — lifecycle verbs that
  dispatch to the existing scripts. `update` re-runs `scripts/install/main.sh`; in package mode it
  aliases to `apply`.

Client skill behavior details:
- `skill export-to-project` / `skill link-project` / `skill native` — the
  dual-harness skill tools (export bundles + copies into `.claude/skills` + `.codex/skills`;
  project linking is `.codex/skills` → `.claude/skills`, with prune; native prints the harness
  plugin/skill escape hatch). Read only the shared /
  client-local layer — never `local/skills/`.

Adding a new `roborepo` subcommand: add or extend the command definition under
`manifests/platform/cli/command-definitions/**`, point it at the existing execution adapter where
possible, and only write module code under `scripts/cli/` when the behavior is new. Add replaced or
removed public commands to `manifests/platform/cli/removed.json` with direct replacement guidance.
Run `node scripts/test/cli-command-catalog-check.mjs` after catalog edits and
`node scripts/test/cli-surface-integration-check.mjs` after resolver, adapter, help, menu, or
retired-command behavior changes. Only ONE global command exists (`roborepo`), so the old
per-command 3-place wiring is gone — `install-global-commands.sh`, `doctor.sh`,
`verify-install.sh` each reference only `roborepo`. MAINTAINER scripts (`render-rules.sh`,
`link-skills.sh`, `test-*.sh`) stay OUT of `roborepo`.

**Tests:** `scripts/test/cli-command-catalog-check.mjs` validates schema v2 command catalog
definitions and removed-command mappings. `scripts/test/cli-surface-integration-check.mjs` exercises
help, namespace fallbacks, retired command guidance, concise/verbose doctor output, and detached
portal routing. `scripts/test/test-cli.sh` smoke-tests the subcommands (skill link-project/prune/
uninstall/conflict, export-to-project/override/firewall/self-pollution guard, sync-global, inspect,
native, trigger checks, run, `mcp add/apply`, lifecycle dispatch, menu fallback, package/workspace
paths) against throwaway temp repos. Run it after behavior changes under `scripts/cli/`. `doctor.sh`
also asserts `skill-lib.sh` and `cli/skill-lib.mjs` agree on the skill list (parity guard). Use
`scripts/test/test-install-collisions.sh --quiet` after installer, root-config, link, or
collision-flow edits.
