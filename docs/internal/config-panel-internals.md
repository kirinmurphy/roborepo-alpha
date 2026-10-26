# Config Control Panel Internals

How the `/agents` panel and `roborepo package manage` are built, for people changing them.
User-facing behavior is in [Config Control Panel](../user/reference/config-control-panel.md).

## State Snapshot

`readConfigSnapshot()` (`scripts/cli/config.mjs`) assembles the state both the web view and the
terminal flow render from. `buildBehaviorView()` maps that snapshot onto the panel's sections.

Each snapshot package carries `selectable`, `selection` (`selected`, `required`, or `off`, from
`packageSelectionStates` in `package-state.mjs`), `recommends`, and the inverse `requiredBy` /
`recommendedBy` lists. `buildBehaviorView()` omits packages whose `presentation.visibility` is not
`catalog` from the normal rows, and gives each section `requiredDependencies[]` (the transitive
`requires` of its rows) and `recommendedDependencies[]` (their direct `recommends`). Each dependency
item is an ordinary row plus `relationship`, `referencedBy`, `relationText`, `selectable`, and
`selection`; it has no `toggle` when it is not selectable or is on only through its parents. The
portal renders both lists below the section's rows, and `roborepo config status` prints them.

Adding a feature of an existing resource shape is data, not code: declare its resources in the
owning `package.config.json`. A new shape needs a new `case` in the enable/disable switch
(`scripts/cli/packages.mjs`).

## Reading state

`readConfigSnapshot()` assembles a JSON snapshot from the live harness config, the
package catalog, skill resources, the permission manifest, and roborepo state files.
`GET /api/config` returns it; both the web view and the terminal flow render from it.

Package rows include `status`, `desired`, and `componentStatus` so the panel can distinguish
enabled, configured, disabled, partial, external, and blocked package state without treating every
observed component as an enabled package. `configured` is a fully-installed package whose only
not-`present` component is a runtime service the user has deliberately turned off (component state
`inactive`, e.g. telemetry capture disabled) — distinct from `partial`, which means an install is
genuinely incomplete.

Skill rows include a native-aware `inventory` object from `scripts/cli/skill-inventory.mjs`.
The skill source popup uses that same inventory, so it can show ownership, managed cache state,
native collision state, native-only metadata files, and per-harness install state before the skill
body and bundled context files.

## Writing state

Every mutation goes through one of the `{ ok, message }` primitives in
`scripts/cli/config-mutate.mjs` (or the package enable/disable path), so the web server
and terminal flow share one implementation:

- `mutatePackage(id, enabled)` → `enablePackage` / `disablePackage`. Beyond `{ ok, message }` it
  returns `outcomes[]` (one probed result per package the mutation applied or removed: `enabled`,
  `partial`, `blocked`, or `disabled`, with the probe's per-component detail), `recommendations[]`
  (recommended packages an enable left off, for the portal to offer), and `keptOnBy[]` (the selected
  packages that keep a deselected package on). A refused mutation (unknown id, ownership conflict,
  dependency-only package, derived-only disable) is a `PackageMutationError` returned as
  `{ ok: false, message }`; nothing has changed when it is. The bulk endpoint returns the same
  `outcomes[]` per member and skips dependency-only members.
- `setSkillInstalled(id, enabled)` → materializes/removes the cache entry in `~/.roborepo/skills`
  and links/unlinks the skill in each installed harness's skill directory
- `setBehaviorBucket(behaviorId, bucket)` → writes a personal behavior override, then re-renders live global permissions
- `setCommandBucket(tokens, bucket)` → writes a personal arbitrary-command override, then re-renders live global permissions

Writes target the user's **live** config, not the repo template (`globals/`). The repo
template is changed only by the install/render pipeline.

When `roborepo config apply` or package-mode `roborepo update` runs from inside a repository with
`docs/plans/plans-config.json`, the post-apply permissions refresh updates Codex's live profile with
that repository family's concrete worktree root. With `"worktreeRoot": "~/.worktrees"` in
`plans-config.json`, a normal checkout named `my-repo` renders `~/.worktrees/my-repo`; a nested
worktree such as `~/.worktrees/my-repo/feature` renders the same family root. Codex profiles require
concrete `workspace_roots`, so the Codex provider materializes the path instead of using a glob for
every repository under `~/.worktrees`.

## Web endpoints

The loopback-only portal server (`scripts/cli/portal-server.mjs`) serves `/agents`
and these write endpoints. Each returns the fresh snapshot so the client re-renders from
one response.

| Endpoint | Body | Result |
| --- | --- | --- |
| `POST /api/config/packages` | `{ id, enabled }` | enable/disable a package |
| `POST /api/config/skills` | `{ id, enabled }` | link/unlink a skill |
| `POST /api/config/permissions` | `{ behaviorId, bucket }` or `{ tokens, bucket }` | set a named behavior or arbitrary command to `deny`, `ask`, `allow`, or `default` |

## Context Cost Estimates

The snapshot carries `contextCost` (computed by `scripts/cli/context-cost.mjs`): per-harness
token estimates for the configuration itself, rendered as a `Usage` row in the agent files
grid (one `<token-chip>` per harness, colored by level, with a contributing-amounts tooltip),
plus matching chips on the rules-file cells when rules are medium/high, per-package cost badges
for workspace packages, and chips in the source-inspect popup header.
`<token-chip>` is a shared web component (`portal/shared/token-chip.js`, styles in
`base.css`) so every cost chip renders and behaves identically.

Two cost classes are tracked and never mixed:

- **Startup** — text included automatically at chat start: the rendered rules payload
  (`CLAUDE.md` / `AGENTS.md` managed block) plus installed skill/command discovery metadata
  (frontmatter name and description). The authoritative startup rules number is measured from
  the full rendered output, not by summing source fragments; the remainder over package
  fragments is attributed to `core-baseline`.
- **On-demand** — text loaded only when invoked: full `SKILL.md` bodies and generated slash
  command wrappers. Deliberately never summed in the UI (skill bodies don't load together, so
  a machine-wide or section-wide sum is noise). Instead each package's single-invocation cost
  is rated on its own skill-size scale (`ON_DEMAND_LEVEL_THRESHOLDS`: low < 1k, medium 1k–3k,
  high > 3k) and only medium/high sizes render a colored per-item chip; low-cost skills show
  no chip.

Built-in packages get no per-item chip, and their popup chips render muted with no threshold
scale (`builtIn` on each package row in `behaviorView`): their size ships with the release, so a
warning is not something the user can act on. The per-harness startup totals stay the capacity
signal, and `scripts/cli/skill-structure.mjs` holds built-in skills to structure limits instead —
a `SKILL.md` body under 500 lines, a `## Contents` section in any reference over 100 lines, and
every reference linked from `SKILL.md`. `doctor` fails on a built-in skill that breaks them in a
development checkout, and warns about the user's own workspace skills.

Config/settings syntax, hook scripts, and MCP schemas never receive token numbers — they are
labeled `Not prompt context`, `conditional`, and `runtime-dependent` respectively. Disabled
packages keep a measured *potential* cost but contribute nothing to active totals.

All counts are estimates (`~4 characters per token`, `method: "estimated-v1"`). The
low/medium/high rating uses threshold families from
`manifests/platform/context-cost-thresholds.json`: full startup payloads and rendered rules use
the large startup scale; package rule snippets and skill discovery metadata use the smaller
Chat-Time Output/snippet scale; single skill/command invocations use the on-demand skill-size
scale. Results are cached by a stat signature over every input file plus enabled/install state,
so the 10-second portal poll does not re-read sources.

## Codex Worktree Permissions Coordinator

Codex permission profiles accept only concrete `workspace_roots`; they do not support a dynamic
"same repo name under my worktree parent" expression. Roborepo is therefore the coordinator that
materializes those roots.

The flow is:

1. A repo carries `docs/plans/plans-config.json` with `"worktreeRoot": "~/.worktrees"`.
2. `roborepo config apply`, package-mode `roborepo update`, or a permissions toggle renders live
   permissions from the current working directory.
3. The generic permission renderer passes provider context to each harness adapter.
4. The Codex provider reads the current repo's plan config and contributes
   `~/.worktrees/<repo-folder-name>` to `workspace_roots`.
5. Claude and Gemini ignore that Codex-only context. Claude gets repository scoping from its
   tool-call hook; Gemini cannot express a path predicate and keeps the documented skip.

This keeps the provider seam intact: the platform owns the permission intent, the render
orchestrator passes context, and each provider decides whether its native permission model can use
that context. It also avoids granting all of `~/.worktrees`, which would let one repo's session
write into another repo's worktree family.

The repository boundary cannot be a path, because no rule syntax can express "wherever the session
happens to be".
So a scope change is an install-time concern, while a *boundary* change takes effect immediately.

Path-scoping changes must be worked through **per provider** — Claude and Codex both, not Claude
alone. The two render through different code paths in `scripts/harnesses/permissions-render.mjs`
and support different permission primitives; a scope that works in one is not evidence it works in
the other.


The home-relative credential denylist (`~/.ssh/**`) is correct on every machine, unlike a personal
*project* layout. Both forms contain `~`; only the second is a portability bug, which is why
`scripts/test/permission-rule-home-path-check.mjs` tests the bucket rather than the presence of a
tilde.

## Key Files

- `scripts/cli/config.mjs` — `readConfigSnapshot()`, `buildBehaviorView()`,
  `loadConfigSource()` (orchestrator).
- `scripts/cli/config-source-lookup.mjs` / `config-source-render.mjs` — source-popup file
  resolution and HTML rendering.
- `scripts/cli/root-config-view.mjs` — per-harness root-config drift view (shared by CLI and portal).
- `scripts/cli/config-live-rules.mjs` — live CLAUDE.md/AGENTS.md reading.
- `scripts/cli/config-cli-print.mjs` — terminal-only `roborepo config` output.
- `scripts/cli/skill-inventory.mjs` — shared read-only skill inventory for the CLI and portal.
- `scripts/cli/context-cost.mjs` — token-cost estimator, collectors, and stat-signature cache
  behind the snapshot's `contextCost`.
- `scripts/cli/package-probes.mjs` — read-only package live-state reconciliation.
- `scripts/cli/config-mutate.mjs` — the shared mutate primitives.
- `scripts/cli/packages.mjs` — `enablePackage` / `disablePackage` and package dependency
  resolution.
- `scripts/cli/permissions-render.mjs` — the permission render core.
- `scripts/cli/config-dashboard.mjs` — the `/agents` web view.
- `scripts/cli/portal-server.mjs` — the HTTP routes.
- `portal/config/` — the config page HTML, CSS, and browser JavaScript.
- `globals/packages/*/package.config.json` — built-in package configs.
- workspace `packages/*/package.config.json` — imported or locally authored package configs.
