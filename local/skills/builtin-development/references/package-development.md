# Package Development

Canonical reference for creating or modifying a RoboRepo package. This documents current
repository behavior — not an aspirational parallel system. If something described here doesn't
match what you find in code, trust the code and fix this doc.

## Package anatomy

A package lives at `globals/packages/<id>/`, `id` matching the directory name exactly
(`normalizePackage` in `scripts/cli/package-catalog.mjs` enforces this). Minimum viable package:

```text
globals/packages/<id>/
  package.config.json
```

Resource-type-specific files live alongside it (`skills/<id>/SKILL.md`, `rules.md`,
`hooks-claude.json`, `hooks-codex.json`, `commands/<name>.md`, etc.) — see Resource types below.

## Manifest schema (`package.config.json`)

Enforced by `normalizePackage`/`normalizeResource` in `scripts/cli/package-catalog.mjs`.

| Field | Required | Notes |
| --- | --- | --- |
| `schemaVersion` | yes | must be `1` (`SUPPORTED_SCHEMA`) |
| `id` | yes | slug, must match the parent directory name |
| `label` | yes | non-empty display name |
| `description` | yes | non-empty; shown in portal |
| `lifecycle` | no (defaults `optional`) | `optional` or `system` (`PACKAGE_LIFECYCLES`) |
| `defaultEnabled` | no (defaults `false`) | boolean; see Default-selection semantics below |
| `presentation.category` | yes | must exist in `manifests/inventory/package-categories.json` (including `token-optimization`, `skills-dev-lifecycle`, `skills-writing`, `skills-code-quality`, `code-conventions`, `chat-time-output`, `additional-agents-md-rules`, and `integrations`) |
| `presentation.order` | no (defaults `0`) | numeric, controls sort within category |
| `requires` | no | array of package IDs; cycle-checked, missing-dep-checked |
| `resources` | yes | array — see Resource types |
| `urls` | no | optional array shown in portal (see e.g. `caveman`, `jcodemunch`, `plan-write`) |

There is no `.schema.json` file — validation is hand-rolled JS, not JSON Schema. Do not add one
speculatively; the current approach is deliberate (see `validatePackageCatalog`).

## Resource types

`RESOURCE_TYPES` (package-catalog.mjs): `skill`, `slash-command`, `rules`, `hooks`, `permissions`,
`codex_tool_approvals`, `mcp`, `plugin`, `service`, `cli-command`, `harness-config`,
`package-runtime-asset`.

Validation depth differs by type — know this before assuming everything is checked:

| Type | Shape validated by `normalizeResource`? | Consumed by (enable/disable) |
| --- | --- | --- |
| `skill` | Yes — slug id, `source` inside package dir, `SKILL.md` exists, valid `invocation` (`auto`/`manual`), optional `risk` (`low`/`medium`/`high`), manual invocation requires a slash-command entrypoint | `setSkillComponent`, `installPackageCommands` in `packages.mjs` |
| `slash-command` | Yes — slug name, source path shape, source file exists on disk, harnesses array shape | rendered via `slash-commands.mjs` |
| `rules` | Yes — source exists on disk, valid harness (`claude`/`codex`/`both`) | `renderHomeRules()` |
| `hooks` | Yes — source exists, valid harness, `scripts[]` entries exist on disk if present | `mergeHooksInto`/`unmergeHooksFrom`, `installHookScripts` |
| `cli-command` | Minimal — just requires a `name` | `packageCommandNames` |
| `permissions` | Yes — non-empty `.allow` array of non-empty strings | `mergePermissions(path, component.allow)` — expects `.allow: string[]` |
| `codex_tool_approvals` | Yes — non-empty `.server` string, non-empty `.approvals` object | `mergeCodexToolApprovals` — expects `.server: string`, `.approvals: {toolName: approvalMode}` |
| `mcp` | Yes — non-empty `.preset` string | `installMcpPreset(component.preset)` — expects `.preset: string` matching `manifests/inventory/mcp-servers.json`/`mcp-presets.json` |
| `plugin` | Yes — non-empty `.id`, `.marketplace.{name,source}` present | `enablePlugin` — expects `.id`, `.marketplace.{name,source}` |
| `service` | Yes — non-empty `.id` | `setService(component.id, ...)` — expects `.id` |
| `harness-config` | Yes — source exists inside package dir, valid harness (`claude`/`codex`) | package-managed live harness config merge/unmerge |
| `package-runtime-asset` | Yes — source exists inside package dir, optional relative `.target` | copied to `~/.roborepo/package-runtime/<package-id>/` and referenced by harness config |

All resource types now get shape-level validation at `roborepo package validate` time, not
just at enable-time. This closed a real gap that existed earlier in this repo's history (see
`docs/plans/backlog/roborepo-package-development-infrastructure-plan.md`, Deliverable 5) — the
last five types previously had no shape-checking beyond "is this a known resource type," so a
malformed resource failed loudly at enable-time instead of validate-time. If you're extending one
of these checks, mirror the existing `else if (next.type === ...)` branches in `normalizeResource`
(`scripts/cli/package-catalog.mjs`).

`harness-config` and `package-runtime-asset` were added for default-enabled package-owned status-line
support. Keep package-runtime assets out of prompt-context accounting; they are copied executable files, not
agent instructions.

## Ownership and conflict behavior (current, not aspirational)

`validatePackageCatalog` enforces single-owner claims via `claim()`: a skill ID, slash-command
name, or CLI-command name can only be declared by one package — a second package declaring the
same one is a validation error, not a merge.

Hook merging (`scripts/cli/hook-composition.mjs`, `mergeHooksInto`/`unmergeHooksFrom`):

- Per-event array merge.
- Identity/dedup is by the **literal `command` string** — there is no package-ID tag stored on the
  hook entry itself. Two packages that happen to install hooks with an identical command string
  will collide silently; two packages with different command strings for logically-the-same
  behavior will both persist.
- New entries are **prepended**, not appended, so a package's hooks can run before pre-existing
  ones for the same event (deliberate, for deny-before-allow ordering).
- This is a known, documented limitation (see the module's own header comment) — not something
  this plan rebuilds. A full package-ID-tagged provenance system would be new infrastructure, out
  of scope unless a real collision forces it.

Codex tool approvals and MCP presets are keyed by server/preset name — same-name collision across
two packages is not currently detected pre-enable (would surface as one package's approvals
silently overwriting the other's TOML block).

## Source vs. generated boundaries

Already fully implemented (see completed plan
`docs/plans/completed/roborepo-system-package-ownership-and-generated-output-plan.md`):

```text
globals/
  system/       mandatory, always-installed behavior + generic composition infra
  packages/     configurable, user-selectable package source (this doc's subject)
  harnesses/    harness-specific resource locations

generated/
  claude/       composed native Claude artifacts (settings.json, CLAUDE.md)
  codex/        composed native Codex artifacts (config.toml, AGENTS.md, hooks.json)
  packages/<id>/{claude,codex}/commands/   per-package generated slash-command wrappers
```

Do not invent an intermediate location. Authored package source lives under `globals/packages/`;
everything under `generated/` is derived and gets overwritten — never hand-edit it.

## Default-selection semantics

A package opts into default-enabled by setting `defaultEnabled: true` in `package.config.json`
(validated as a boolean by `normalizePackage`; absent/`false` is the default, matching every
package that predates this field). Scaffold with `roborepo package create <id> --default-enabled=true`.

The enabled-packages registry (`scripts/cli/rules-render.mjs`) tracks two lists, not one:

```json
{ "packages": ["explicit-enable ids"], "disabled": ["explicit-disable ids"] }
```

`effectiveEnabledIds(catalog, registry)` is the single source of truth for "is this package
actually active" — explicit-enable OR (`defaultEnabled` AND NOT explicit-disable), with
explicit-disable winning over everything else:

```text
explicit-disable > explicit-enable > current defaults
```

`setPackageEnabled(id, true)` clears any prior explicit-disable for that id; `setPackageEnabled(id,
false)` clears any prior explicit-enable and records an explicit-disable — recorded
unconditionally (even for a package that isn't default-enabled today), so a package that later
becomes default-enabled doesn't silently re-enable itself for someone who already turned it off.

Every call site that needs to know what's actually live — `buildPackageLiveState` (portal/CLI
status), `renderHomeRules`/`checkHomeRules`/`renderedRulesMatches` (rules rendering and drift
checks), `validatePackageCommandOwnership`/`resolveEnabledCommand` (command conflict/dispatch),
`reconcileEnabledPackages`, `enabledDependents` — reads through `effectiveEnabledIds`, not the raw
registry. The one deliberate exception is `adoptLivePackages`'s "is this already known" check,
which also now uses `effectiveEnabledIds` (a default-enabled package should never be offered for
adoption). If you add a new call site that needs to know package on/off state, use
`effectiveEnabledIds` — reading `registry.packages` directly will silently miss default-enabled
packages.

Test coverage: `scripts/test/package-default-enabled-check.mjs`
(`npm run test:package-default-enabled`) — pure precedence computation plus a live CLI round-trip
proving a default-enabled package's rules render with zero `enable` calls, and that one explicit
disable survives being still-default-enabled in the catalog.

## Token-cost: computed, not declared

Token cost is **not a manifest field**. It is computed live from real content size by
`scripts/cli/context-cost.mjs` (`ceil(chars/4)` estimator) and surfaced in the portal as chips
(`contextCost` on every package/behavior item), tested by `scripts/test/context-cost-check.mjs`
(`npm run test:context-cost`). See completed plan
`docs/plans/completed/config-context-token-cost-plan.md`.

**Do not add a static token-cost field to `package.config.json`.** That would create a second,
driftable source of truth for something already derived correctly from the real files — the exact
anti-pattern this repo's package model forbids ("generated artifacts are derived and never become
a competing source of truth"). When adding a package, the only correlated action is making sure
its skill/rules content is real and present so the estimator has something accurate to measure —
nothing to author by hand.

## Portal metadata

Also computed, not separately authored. `buildBehaviorView`/`packagePresentationItem` in
`scripts/cli/config.mjs` derive the portal card directly from the manifest's `label`,
`description`, `presentation.category`, `urls`, live `enabled` state, and computed `contextCost`
— there is no separate portal-metadata file or field set to fill in. A package with a complete,
accurate `package.config.json` automatically renders a complete portal card.

## The `roborepo package` CLI surface (undocumented elsewhere — this is now the source)

`scripts/cli/packages.mjs`, dispatched via `packageCommand()`:

| Command | What it does |
| --- | --- |
| `roborepo package create <id> [--kind=empty\|auto-skill\|skill-command\|standalone-command] [--description=...] [--command=...] [--default-enabled=true]` | Scaffolds a new package into `globals/packages/<id>/` (dev checkout) or the user workspace packages dir (package mode). Refuses to overwrite an existing package. Prints the created path. |
| `roborepo package list` | Lists packages grouped by category with concise live enabled/disabled status. |
| `roborepo package inspect <id>` | Prints full manifest JSON for one package. |
| `roborepo package validate [id]` | Runs `validatePackageCatalog`; scope to one package or the whole catalog. |
| `roborepo package enable <id>` | Enables a package and **applies live immediately** — see Apply behavior below. |
| `roborepo package disable <id>` | Disables a package and **applies live immediately**. |
| `roborepo package reconcile` | Re-applies every currently-enabled package (full reconciliation entry point — see Apply behavior). |
| `roborepo package adopt-live [--dry-run]` | Detects externally-installed (unmanaged) package behavior and marks it enabled in the registry without re-installing it. |

Add these rows to `docs/user/reference/roborepo-cli.md` and to
`local/skills/builtin-development/SKILL.md`'s own CLI list whenever this table changes.

## Apply behavior (already automatic — do not reintroduce a manual step)

`enablePackage`/`disablePackage` in `packages.mjs` mutate live harness state directly as part of
the same call: permissions merged into `USER_CLAUDE_SETTINGS`, hooks merged via
`mergeHooksInto`/`unmergeHooksFrom`, rules re-rendered via `renderHomeRules()`, MCP presets
installed/removed, skill commands installed via `installPackageCommands`. **There is no separate
apply/sync step required after enable or disable** — this already matches the goal of "package
enable/disable takes effect immediately without `roborepo update`."

The portal's package toggle (`portal/config/config-toggle.js` →
`scripts/cli/config-mutate.mjs:mutatePackage()`) calls the exact same `enablePackage`/
`disablePackage` functions — CLI and portal share one apply path, not two.

`roborepo package reconcile` (→ `reconcileEnabledPackages()`) is the full-reconciliation entry
point: re-applies every enabled package and removes any enabled-but-no-longer-in-catalog stale
entries. This is the command to reach for if "apply everything currently selected" is needed —
don't invent a new name for it.

The one place a user is still told to run `roborepo update` is unrelated to enable/disable:
`portal/config/state.js`'s `"drifted"` status (root config file edited outside RoboRepo since its
last write) — a legitimate, distinct reconciliation case, not a gap in the enable/disable path.

## Tests

- `scripts/test/package-catalog-check.mjs` (`npm run test:packages`) — loads the real catalog,
  asserts known packages/commands exist, and builds a temp-dir fixture package (`legacy-shape`
  pattern) to test malformed/edge-case shapes against the loader.
- `scripts/test/system-package-ownership-characterization-check.mjs` — package-ownership /
  generated-output regression guard; spawns the real CLI against a temp `HOME`, round-trips
  enable/disable, and asserts Codex-side hook/config ownership.
- `scripts/test/context-cost-check.mjs` (`npm run test:context-cost`) — token-cost estimator
  correctness, independent of any one package.
- `scripts/test/package-default-enabled-check.mjs` (`npm run test:package-default-enabled`) —
  default-selection provenance precedence, independent of any one package.
- `scripts/test/test-cli.sh` — broad CLI smoke test; covers package/workspace paths.

Minimum test bar for a new or changed package: it must load cleanly through
`loadPackageCatalog`/`validatePackageCatalog` (covered generically by `package-catalog-check.mjs`
against the real catalog — no per-package test file needed for basic shape correctness), and its
enable/disable must round-trip without leaving stale live state (covered generically once the
lifecycle-check exists — see Deliverable 5 in the source plan).

## Package completion checklist

```text
[ ] package.config.json matches current schema (schemaVersion 1, valid category, valid resources)
[ ] Directory name matches id exactly
[ ] Every declared resource source file actually exists (`roborepo package validate` enforces
    this for skill/rules/hooks/slash-command/harness-config/package-runtime-asset)
[ ] No resource ID/name collides with another package's claimed skill/slash-command/CLI-command
[ ] Optional behavior kept entirely inside this package — nothing added to globals/system/
[ ] Ran `roborepo package validate <id>`
[ ] Enabled and disabled the package once locally; confirmed live state (settings.json, hooks,
    rendered rules, or MCP config as applicable) both appears and cleanly disappears
[ ] Portal renders label/description/category/cost correctly (no manual portal file to edit)
[ ] Did NOT add a static token-cost field — cost is computed
[ ] If defaultEnabled: true, confirmed explicit disable survives being still-default-enabled
    (see scripts/test/package-default-enabled-check.mjs)
[ ] Ran `npm test` (or the narrowest relevant subset — package-catalog-check, context-cost-check,
    package-default-enabled-check, system-package-ownership-characterization-check) before calling
    it done
```
