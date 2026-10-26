---
id: bysyzl1e
priority: high
next_action: Run /plan-review to review the implementation and confirm the Not tested entry.
blocked_by: []
depends_on: []
related: ["o9zwxuav", "ejsc769o", "jdsobwn", "user-managed-packages-and-add-workflows"]
reviewed_commit: ce0749f0ef66bc30e53addd4f2029cd14abcaf4a
worktree: package-multi-skill-packages
---

# Package Management: Part 01 - Bundle Skills That Only Work Together

## Summary

A RoboRepo package can technically list several `skill` resources, but none does. Every authoring
path, the Agents page card, and its source popup assume one skill per package. That works while
every skill stands alone. It breaks when skills only make sense together, like the six plan
lifecycle skills, which hand off to one another and are shipped today as six separate packages.

This plan makes several skills in one package a supported shape: authored, validated, enabled,
reported, and shown in the portal. The plan suite is its first user. Its six skills move into one
`plan-suite` package, and `session-close` stays a separate package.

The plan also sets the vocabulary for groups of skills, because a package with several skills is
easy to confuse with a group of packages:

| Concept | What the user controls | Example | Declared by |
| --- | --- | --- | --- |
| **Package** | One switch. Every resource in it turns on and off together. | `plan-suite`, `caveman` | `package.config.json` |
| **Collection** | Each member has its own switch, plus Select All / Deselect All for the group | None built in after this plan (the Plan Suite section was the only one) | A category with `bulkToggle: true`; see Non-goals |
| **Category** | Each member has its own switch, with no group switch | Code Conventions | A category without `bulkToggle` |
| **Dependency** | Nothing directly. It turns on because a selected package `requires` it. | `implementation-review` | `requires` in the parent manifest ([[o9zwxuav]]) |

The rule for authors: **a package holds skills that are only correct together; a collection holds
skills that are useful together.**

## Context

### Current state

Verified at `ce0749f`.

| Area | Today |
| --- | --- |
| Catalog validation | `normalizeResource` in `scripts/cli/package-catalog.mjs` validates each resource on its own, and `validatePackageCatalog` claims each skill ID once across the catalog. Nothing forbids two skills in one package, but no fixture or built-in package exercises it. |
| Authoring | `roborepo package dev create <id> --kind=…` scaffolds a package with at most one skill. There is no command to add a skill to an existing package. |
| Activation | Each skill folder is copied to `~/.roborepo/skills/<skill-id>` and linked into every harness skill folder by skill ID. The package ID does not appear in any installed path. |
| Trigger fixtures | One `skill-triggers.json` per package: a `tests` array keyed by `skill`, read by `scripts/cli/skill-trigger-fixtures.mjs`. Several skills already fit this shape. |
| Agents page card | `buildBehaviorView` in `scripts/cli/config.mjs` builds `toolByPackage` as a `Map` keyed by package ID, so a package with several commands keeps only the last one. `packagePresentationItem` sets one `inspect` target: the command, else `item.skillIds[0]`, else the rules. |
| Source popup | `portal/config/panels.js` `createConfigModal` owns one `<dialog id="config-modal">`. Clicking a card's label calls `openSource(inspect)`, which fetches and renders one source file. |
| Collections | `manifests/inventory/package-categories.json` marks only `skills-dev-lifecycle` ("Plan Suite") with `bulkToggle: true`. `standardSection` in `portal/config/templates.js` renders its Select All / Deselect All switch. |

Plan suite specifics:

| Area | Today |
| --- | --- |
| Packages | `globals/packages/plan-{write,promote,execute,review,close,archive}/`, each with one `skill` resource and one `slash-command` entrypoint. `plan-execute` also has a `rules` resource (`rules.md`). All are in `skills-dev-lifecycle`, with order 10–45. |
| Runtime package-ID references | `scripts/cli/plans.mjs` `planWritePackageState()` reads `packageStatusSummary("plan-write")`, and every plans snapshot carries the result as `planWritePackage`, which `portal/plans/app.js`, `portal/plans/templates.js`, `portal/plans/plan-drawer.js`, `portal/home/app.js`, and `scripts/cli/mock-home.mjs` read. `scripts/cli/telemetry.mjs` `loadPlanCloseEnabled` reads `packageStatusSummary("plan-close")`; the comment on `withCleanupOffer` in `scripts/cli/repository-overview-projections.mjs` names "the plan-close package". `portal/plans/api.js` `PLAN_SUITE_PACKAGES` lists all six plus `session-close` for the onboarding banner's bulk enable. |
| Command references | `manifests/platform/plan-lifecycle.json`, `portal/plans/plan-actions.js`, and `portal/plans/plan-drawer-partial.html` name commands and skills, not packages, so they stay as they are. The Plans page skill popup (`portal/shared/skill-detail-modal.js`) and `loadConfigSource` resolve skills by skill ID and commands through `packageSlashCommands()`, so they follow the move without edits. No preset or bundle in `manifests/` names a plan package. |
| Docs | `docs/user/guides/setup-and-daily-use.md` and `docs/user/guides/plan/lifecycle/plan-suite.md` tell users to run `roborepo package enable` once per plan package. `docs/internal/plans-portal-internals.md` lists the six `globals/packages/plan-*/` directories. |
| Tests naming the packages | By package ID: `scripts/test/plan-suite-check.mjs` and `scripts/test/plan-suite-commands-check.mjs` (enable, disable, or query `plan-write`); `scripts/test/config-bulk-toggle-check.mjs` (`SECTION_IDS` lists all seven, plus individual `plan-write` toggles); `scripts/test/package-retired-ids-check.mjs` and `scripts/test/system-package-ownership-characterization-check.mjs` (use `plan-write` as a current, enableable package); `scripts/test/package-catalog-check.mjs` (looks up `plan-write`'s `urls`, which would pass vacuously once the ID is gone); `scripts/test/cli-command-catalog-check.mjs` (parses `package status plan-write` without reading the catalog, so it can stay). By path: `scripts/test/plan-close-integration-check.mjs`, `scripts/test/skill-reference-matrix-characterization-check.mjs`, `scripts/test/plan-suite-skills-check.mjs`, and `scripts/test/test-cli.sh` read files under `globals/packages/plan-*/` or `generated/packages/plan-*/`. Other tests name the plan skills or commands only. |
| Retired package IDs | No mapping exists. `scripts/test/package-retired-ids-check.mjs` pins what `roborepo update` does with registry IDs the catalog no longer has (`plan-docs`, `wrap-up`, `plan-start`): `reconcile` drops them from both registry lists and removes their skill cache, harness skill views, and slash commands. |

### Why now

- **External skills ([[jdsobwn]], [[user-managed-packages-and-add-workflows]])** will create
  packages with several skills from repos that ship a suite. The card, popup, and status paths need
  to work on content RoboRepo controls first.
- **Desired state ([[o9zwxuav]])** changes what the enabled-packages file means. Changing the plan
  package IDs first means its migration fixtures use the final IDs.
- **Required and recommended skills ([[ejsc769o]])** lists `requires` edges from `plan-write`,
  `plan-promote`, `plan-execute`, `plan-review`, and `plan-close`. After this plan those edges all
  start from `plan-suite`.

## Goals

- A package with several `skill` resources validates, enables, disables, reports `partial` when any
  one component is missing, and sums context cost across all of them.
- Authors can add a skill to an existing package from the CLI.
- On the Agents page, a package with one skill looks and behaves exactly as it does today.
- A package with several skills shows a count on its card. Clicking its label opens a contents view
  that lists each resource, and each entry opens today's single-source view.
- The six plan lifecycle skills ship as one `plan-suite` package; `session-close` stays separate.
- Package, collection, category, and dependency are defined in package-development guidance, along
  with the authoring rule for choosing between a package and a collection.

## Non-goals

- Toggling individual skills inside a package. A package is all-or-nothing by definition; skills
  that need their own switches belong in a collection.
- A collection record separate from categories. Categories with `bulkToggle` already are
  collections. A separate record is needed once a collection comes from somewhere other than a
  built-in category: a user creating one ([[user-managed-packages-and-add-workflows]]) or an
  external source with several skills ([[jdsobwn]]). Whichever lands first defines it.
- Deciding from skill content whether skills belong in one package. [[ejsc769o]] owns the reference
  audit that flags candidates; see Package or collection.
- Mapping old plan package IDs to `plan-suite` in the enabled-packages file. RoboRepo has not
  launched, so no compatibility shim is added. See Risks.
- Changing any plan skill's content or workflow.
- The System / Custom / Third Party tabs on the Agents page, owned by
  [[user-managed-packages-and-add-workflows]].

## Proposed design

### Package or collection

The decision belongs to the author, because only the author knows whether a skill is correct
without its siblings. The question to answer:

```mermaid
flowchart TD
  q1{Does each skill do its job when the others are off?}
  q1 -->|no: they hand off or share one contract| pkg[One package]
  q1 -->|yes| q2{Will users usually want them together?}
  q2 -->|yes| col[Separate packages in a bulkToggle category]
  q2 -->|no| cat[Separate packages in a plain category]
  q1 -->|one needs another, but not the reverse| dep[Separate packages joined by requires]
```

The plan suite answers "no" to the first question: `/plan-promote` hands off to `/plan-execute`, which
hands off to `/plan-review`, and so on. Code Conventions answers "yes, but not always together":
`code-style` is useful without `react`.

The skill reference audit in [[ejsc769o]] gives the deterministic check: an unconditional handoff
from a skill in one package to a skill in another package, with no `requires` between them, is
reported as a candidate for merging or for a `requires` edge.

### Agents page: card and contents view

A package's card shows one switch whatever it contains. What changes is the label and what clicking
it opens:

```mermaid
flowchart TD
  card[Package card label clicked] -->|package has 0 or 1 skill| today[Today's source view for the command, skill, or rules]
  card -->|package has 2 or more skills| contents[Contents view]
  contents -->|user selects an entry| source[Today's source view for that entry]
  source -->|user selects Back| contents
```

Contents view, rendered inside the existing `#config-modal` dialog:

```text
Development Planning Lifecycle                  Startup: <cost>  When loaded: <cost>
6 skills · 1 rules fragment
──────────────────────────────────────────────────────────────────────────────
/plan-write     <SKILL.md description, one line>                    <cost>  ›
/plan-promote   <SKILL.md description, one line>                    <cost>  ›
/plan-execute   <SKILL.md description, one line>                    <cost>  ›
/plan-review    <SKILL.md description, one line>                    <cost>  ›
/plan-close     <SKILL.md description, one line>                    <cost>  ›
/plan-archive   <SKILL.md description, one line>                    <cost>  ›
Rules           Code Outlives Plans                                 <cost>  ›
```

| Element | Source |
| --- | --- |
| Header title and cost row | The package label and the package's existing cost chips |
| Summary line | Resource counts by type |
| Entry label | `/command` for a skill with a slash command, the skill ID otherwise, and the resource type for rules or hooks |
| Entry description | The skill's `SKILL.md` frontmatter `description`, shortened to one line |
| Entry cost | The resource's entry in the per-component list that `scripts/cli/context-cost.mjs` already builds for each package |
| Entry action | `openSource` with the same `inspect` object a single-skill card uses today |
| Back | Re-renders the contents view in the same dialog. No second dialog is stacked. |

On the card, a `6 skills` badge sits beside the cost chips so users can tell before clicking that
the card controls a set. The card label is the package label, never one of its commands.

[[user-managed-packages-and-add-workflows]] later splits the Agents page into System, Custom, and
Third Party tabs. The card, badge, and contents view behave the same on every tab; `plan-suite`
sits on the System tab.

Server side, `packagePresentationItem` sets `inspect` to `{ kind: "package-contents", id, entries }`
when a package has two or more skills. Each entry carries the `inspect` object it would have had as
a single-skill card. `buildBehaviorView` groups tools by package as arrays instead of keeping one per
package. `loadConfigSource` needs no change, because every entry's `inspect` is a kind it already
serves.

### Authoring

Add `roborepo package dev add-skill <package-id> <skill-id> [--command] [--description=…]`. It
creates `skills/<skill-id>/SKILL.md`, appends the `skill` resource (and its `slash-command`
entrypoint with `--command`), adds a `skill-triggers.json` entry, and runs package validation. It
refuses when the skill ID is already claimed by any package.

### Plan suite migration

```text
globals/packages/plan-suite/
  package.config.json
  rules.md                      moved from plan-execute/
  skill-triggers.json           the six tests arrays concatenated
  skills/
    plan-write/                 moved unchanged
    plan-promote/
    plan-execute/
    plan-review/
    plan-close/
    plan-archive/
```

The manifest header replaces the six old headers:

```json
{
  "schemaVersion": 1,
  "id": "plan-suite",
  "label": "Development Planning Lifecycle",
  "description": "Six commands that carry a repository plan from first draft to merged work: write, promote, execute, review, close, and archive. Each step hands off to the next, so they turn on and off together.",
  "lifecycle": "optional",
  "presentation": { "category": "skills-dev-lifecycle", "order": 10 }
}
```

`resources` holds the six `skill` resources in lifecycle order, each copied unchanged from its old
manifest (`id`, `source`, `invocation`, `risk`, and the `slash-command` entrypoint), followed by the
`rules` resource from `plan-execute`.

| Location | Today | After |
| --- | --- | --- |
| `scripts/cli/plans.mjs` `planWritePackageState` | `packageStatusSummary("plan-write")` | `packageStatusSummary("plan-suite")`. Rename the function to `planSuitePackageState`. |
| Plans snapshot field `planWritePackage` and the portal's `planWriteEnabled` / `getPlanWritePackage` | Named after `plan-write` | Rename to `planSuitePackage`, `planSuiteEnabled`, and `getPlanSuitePackage` in `scripts/cli/plans.mjs`, `scripts/cli/mock-home.mjs`, `portal/plans/`, `portal/home/app.js`, and the portal UI specs, so no name points at a package that no longer exists. The field's shape is unchanged. |
| `scripts/cli/telemetry.mjs` `loadPlanCloseEnabled` | `packageStatusSummary("plan-close").enabled` | `packageStatusSummary("plan-suite").enabled`. The name stays: it still answers whether `/plan-close` is available. |
| `scripts/cli/repository-overview-projections.mjs` `withCleanupOffer` comment | "the plan-close package is disabled" | "the plan-suite package is disabled" |
| `portal/plans/api.js` `PLAN_SUITE_PACKAGES` | seven IDs | `["plan-suite", "session-close"]` |

After the move, the `skills-dev-lifecycle` category is labeled "Development Workflows", drops
`bulkToggle`, and holds two packages, `plan-suite` and `session-close`, each with its own switch.
The category and the package each have their own description. The Plans onboarding banner still
enables both through the bulk endpoint, which does not depend on `bulkToggle`. See Decision Log.

## Implementation plan

### Phase 1: Several skills in one package

- [x] Add a fixture package with two skills, one with a slash command, plus a rules
      resource. It sits in a throwaway app root, not a workspace; see Decision Log.
- [x] Prove with checks that the fixture validates, enables both skills and the command, reports
      `partial` when one skill link is removed, disables cleanly, and sums context cost.
- [x] Fix any path that assumes one skill per package, found by the checks or by searching
      `scripts/cli/` for `skillIds[0]` and for maps keyed by package ID that hold one resource.

### Phase 2: Authoring

- [x] Add the `package dev add-skill` command definition under
      `manifests/platform/cli/command-definitions/package/` and its implementation beside
      `package dev create` in `scripts/cli/packages.mjs`.
- [x] Update `docs/user/reference/roborepo-cli.md` and the package-development reference.

### Phase 3: Agents page

- [x] Group tools by package in `buildBehaviorView`, and emit the `package-contents` inspect target
      and the skill-count badge from `packagePresentationItem`.
- [x] Add a `showContents` view to `createConfigModal` in `portal/config/panels.js`, with Back
      returning to it from `openSource`, and a template for the entry list in
      `portal/config/templates.js`.
- [x] Keep card and popup output identical for packages with zero or one skill.

### Phase 4: Plan suite migration

- [x] Create `globals/packages/plan-suite/` with `git mv` for the skill folders and `rules.md`, then
      delete the six old package directories.
- [x] Run `roborepo skill render-commands` and `roborepo skill triggers --check`; commit
      `generated/packages/plan-suite/` and delete the six `generated/packages/plan-*/` directories.
- [x] Update the runtime references in the table above, then search `scripts/`, `modules/`,
      `portal/`, and `manifests/` again for any old package ID used as a package ID.
- [x] Update the tests that name old package IDs or paths, listed under Current state. In
      `package-catalog-check.mjs`, point the `urls` lookup at `plan-suite` and assert the package
      exists, so the check cannot pass vacuously.
- [x] Extend `scripts/test/package-retired-ids-check.mjs` with the six old plan package IDs: after
      `reconcile`, they leave the registry; after `roborepo package enable plan-suite`, all six
      plan skills and their slash commands are installed. Record in this plan what happens to the
      plan skill links between those two steps. Recorded under Risks: the links survive, because
      adopt-live adopts `plan-suite` during the update.
- [x] Update the two user guides so the CLI shows `roborepo package enable plan-suite` and
      `roborepo package enable session-close`.
- [x] Replace `globals/packages/plan-*/` paths in `docs/internal/plans-portal-internals.md` and in
      open plans under `docs/plans/backlog/`, `ready/`, `active/`, and `review/`. Leave completed and
      archived plans and `docs/internal/history/` as written: they record the layout at the time.

### Phase 5: Guidance

- [x] Add the package, collection, category, and dependency table and the authoring question to
      `.claude/skills/roborepo-development/references/package-development.md`.
- [x] Describe the contents view and the skill-count badge in `docs/user/reference/config-control-panel.md`.

## Validation

| Behavior | Check |
| --- | --- |
| Two skills in one package validate; each skill ID is claimed once | `node scripts/test/package-catalog-check.mjs` |
| Enable, disable, and `partial` across several skills and a rules fragment | `node scripts/test/package-lifecycle-check.mjs` |
| Context cost sums every resource and exposes each resource's share | `node scripts/test/context-cost-check.mjs` |
| `package dev add-skill` creates the files and refuses a claimed ID | `bash scripts/test/test-cli.sh --quiet` |
| Command catalog accepts the new definition | `node scripts/test/cli-command-catalog-check.mjs` |
| Several-skill card shows the badge; label opens the contents view; each entry opens its source; Back returns; single-skill cards are unchanged | `npm run test:portal-ui` |
| Plans page and command status read `plan-suite` | `node scripts/test/plan-suite-check.mjs`, `node scripts/test/plan-suite-commands-check.mjs` |
| Plan skill content and the rules fragment are unchanged after the move | `node scripts/test/plan-suite-skills-check.mjs`, `node scripts/test/plan-close-integration-check.mjs`, `node scripts/test/skill-reference-matrix-characterization-check.mjs` |
| Onboarding bulk enable turns on `plan-suite` and `session-close` | `node scripts/test/config-bulk-toggle-check.mjs` |
| Updating a machine that enabled the six old IDs drops them, and enabling `plan-suite` installs all six skills and commands | `node scripts/test/package-retired-ids-check.mjs` |
| Enabling and disabling `plan-suite` installs and removes its command wrappers | `node scripts/test/system-package-ownership-characterization-check.mjs` |
| Generated command wrappers and trigger fixtures match source | `roborepo skill render-commands --check`, `roborepo skill triggers --check` |
| Full gate: package defaults, generated output, CLI catalog, and portal change | `bash scripts/doctor.sh --quiet`, `npm run check` |

## Risks

| Risk | Treatment |
| --- | --- |
| Existing machines list the six old IDs in `~/.roborepo/enabled-packages.json`. `reconcileEnabledPackages` in `scripts/cli/packages.mjs` drops IDs missing from the catalog and then runs `cleanupPackageProjections`. | Checked in Phase 4: the update's earlier `package adopt-live` step finds the plan skill caches still in place and adopts `plan-suite`, and reconcile then installs all six skills and re-owns their commands, so the plan skill links survive and `plan-suite` ends enabled. A machine that had enabled only some of the six ends with all six. `package-retired-ids-check.mjs` asserts this with two of the six enabled. Pre-launch, no mapping is added; the user guides say to run `roborepo package enable plan-suite` on a fresh setup, and the plan suite walkthrough says what an update does. |
| A path assumes one skill per package and the fixture does not reach it | Phase 1 searches as well as tests, and Phase 4 repeats the search for the plan suite |
| Authors put unrelated skills in one package to save toggles | The authoring question in package-development guidance, and the [[ejsc769o]] audit, which also reports skills in one package that never reference each other |

## Decision Log

- **2026-10-24 (user decision, supersedes the next entry): The `skills-dev-lifecycle` category is
  "Development Workflows" with no `bulkToggle`, and the `plan-suite` package is labeled
  "Development Planning Lifecycle".** Decided by the user after seeing the result: a category and a
  package both named "Plan Suite", with the same description and a Select All over two cards, did
  not make sense. Each now has its own description. The package ID stays `plan-suite`, and the
  Plans page keeps calling the feature the plan suite. No built-in category has `bulkToggle` after
  this; the portal still supports it.
- **2026-10-24 (superseded): The `skills-dev-lifecycle` category stays "Plan Suite" with `bulkToggle`.** Decided
  by the user. After the move it is a collection of two packages, `plan-suite` and `session-close`,
  and its section header shares a name with the `plan-suite` card. Considered and not chosen:
  renaming the category to "Dev Lifecycle" and dropping `bulkToggle`, and moving `session-close`
  to another category.
- **2026-10-24: The plans snapshot field `planWritePackage` is renamed to `planSuitePackage`.**
  Decided during promotion. It reports `plan-suite`'s status after the move, and the field is
  internal to the portal and its tests. `loadPlanCloseEnabled` keeps its name because it still
  answers whether `/plan-close` is available.

- **2026-10-24: "Partial when one component is missing" means one skill's cache or command
  wrapper.** Decided during implementation. The skill probe in `scripts/cli/package-probes.mjs`
  checks each skill's cache and command wrappers, not its harness skill links, for every package;
  a several-skill package inherits that per skill, which Phase 1 asserts. Considered and not
  chosen: probing harness links too, which would change status for every package (a harness not
  installed on the machine would read partial) and is outside this plan.
- **2026-10-24: The several-skill fixture lives in a throwaway app root, not a workspace.**
  Decided during implementation. Only built-in packages get generated slash-command wrappers
  (`installPackageCommands` reads `generated/packages/<id>/`), so a workspace package's command
  can never install, whatever its skill count. A temporary development app root with the fixture
  under `globals/packages/` exercises the command path without adding a test package to the real
  catalog. Considered and not chosen: a workspace fixture without the command (would not cover
  the command), and teaching workspace packages to render commands (out of scope).
- **2026-10-24: Each resource's cost is reported under `contextCost.packages[<id>].resources`,
  keyed `skill:<id>`, `rules:<source>`, or `slash-command:<name>`.** Decided during
  implementation. A skill-backed command wrapper counts toward its skill, so a contents-view row
  shows one figure per skill. Considered and not chosen: computing entry costs in the portal from
  the raw component list, which would repeat the harness-max logic `aggregatePackages` already
  owns.
- **2026-10-24: The contents view lists skills first, then one Rules and one Hooks row.**
  Decided during implementation. `loadConfigSource` serves one rules and one hooks source per
  package, so each type is one row; the rules row is described by its fragment's first heading.
  A skill row shows its on-demand cost, a rules row its startup cost.
- **2026-10-24: `package dev add-skill` places the new skill after the package's last skill and
  leaves an empty trigger fixture.** Decided during implementation. Keeping skills ahead of rules
  and hooks matches the plan-suite manifest's order; an empty `skill-triggers.json` entry passes
  `skill triggers --check` and gives the author the place to fill. It also refuses a built-in
  package in package mode, where app files are immutable. Ownership is left to
  `validatePackageCatalog`: the files are written, the catalog is validated, and a skill or command
  another package claims fails validation and restores the package. Only a repeat inside the same
  package is checked up front, because `claim()` ignores a second claim by the same owner.
  Considered and not chosen: hand-written claim checks before writing, which duplicated the
  catalog's rules and left the restore path unreachable and untested.
- **2026-10-24: `docs/user/reference/plans-portal.md`, `docs/user/reference/repositories.md`, and
  `docs/internal/portal-architecture.md` were updated too.** They named the old plan package IDs
  as packages, so they were newly affected docs of record.

- **2026-10-24: Two links into moved files were repointed, including one in
  `docs/internal/history/`.** Decided during implementation. `docs-reference-check.mjs` fails on a
  missing link target, so the history README's link to `plan-execute/SKILL.md` and
  `docs/internal/backlog-review.md`'s link to `plan-write/package.config.json` now point at
  `globals/packages/plan-suite/`. Only the targets changed; the prose still records the layout at
  the time. Considered and not chosen: leaving them broken, which fails the gate.

- **2026-10-25 (user decision): Merge main into this branch and adapt main's two `bulkToggle`
  tests.** main gained two hook-readiness Agents tests that looked for a built-in section with
  `bulkToggle`, which this branch removes. The user approved merging main; both tests now serve the
  live config with the first package section marked `bulkToggle`, which keeps the user's category
  decision and gives the Select All switch a UI test again. Considered and not chosen: keeping a
  built-in `bulkToggle` category (reverses the user's decision), and leaving it to the merge (a
  red portal suite).

## Not tested

- [x] Updating a real machine that enabled some of the old plan packages ends with `plan-suite`
      enabled and all six commands working in Claude, Codex, and Gemini. The retired-IDs check
      covers the registry and each harness's skill and command files in a hermetic home, not a live
      harness session running the commands. Confirmed by the user on 2026-10-26 ("i have confirmed
      the manual check").

## Review

### Findings

- [x] Portal comments still named the `plan-write` package as the Plans page gate
      (`portal/plans/app.js`, `templates.js`, `plan-drawer.js`, `plan-drawer-partial.html`,
      `portal/home/app.js`) — fixed (22b2b531)
- [x] `add-skill` refusals documented but untested: built-in package in package mode, a claimed
      command name, and the restore on validation failure — tested; claim checks now go through
      validation so the restore path runs (22b2b531)
- [x] `aggregateResources` comment claimed per-resource figures always sum to the package total —
      reworded; `package-catalog-check.mjs` asserts equality only when harnesses agree (22b2b531)
- [x] A failed `add-skill` on a package with no `skills/` folder left an empty one behind while
      reporting nothing changed — the restore removes a `skills/` folder the call created; tested (e01c9d9f)
- [x] A test comment still said the cleanup offer depends on the plan-close package — fixed (28e30973)
- [x] The fixture comment and Phase 1 task called the fixture a workspace package; it is a built-in
      package in a throwaway app root — fixed (28e30973)
- [x] main's two hook-readiness Agents tests need a built-in `bulkToggle` section, which this
      branch removes — the user approved merging main; both tests now route a config with one
      section marked `bulkToggle` (`routeBulkToggleConfig` in `portal-ui.spec.mjs`) (3aa6d03c)
- [x] Bulk endpoint comments said it serves only `bulkToggle` sections; the Plans banner, from a
      section without one, is now its built-in caller — reworded (de5ad784)
- [x] `portal/plans/api.js:35` and `docs/user/reference/plans-portal.md:280-281` still say the
      banner enables its packages "through the config section's bulk endpoint"; no section has
      `bulkToggle` now — reworded to "the config bulk endpoint (`/api/config/packages/bulk`)" (e84e3c35)
- [x] `scripts/cli/packages.mjs` `addSkillToPackage` prints `next: roborepo skill render-commands`
      after `--command` even in package mode, where only workspace packages are editable and their
      commands never install — the hint now prints only for built-in packages; a workspace package
      gets a note that the command will not install, asserted in `test-cli.sh` (e84e3c35)
- [x] The contents-view portal UI test does not assert that each entry renders its own cost chip
      (`contentsEntryChipSpec`) — the test now asserts all seven rows show a visible chip with tokens
      (e84e3c35)
- [x] Validation record still said pass 5's findings were open and named an older gate run —
      updated (e9e3aec2)
- [x] `package-retired-ids-check.mjs` comment said two retired IDs are enabled; the registry
      enables five — fixed (e9e3aec2)
- [x] `multiSkillPresentationItem` emitted a `skillCount` field nothing reads (the badge carries the
      count) — removed, with the assertion that only checked its absence (e9e3aec2)
- [x] `plans-portal.md` said enabling `plan-suite` turns on seven skills; it turns on six, and
      `/session-close` is its own package — fixed (42d61c23)
- [x] No test covered a successful `add-skill` without `--command` (an auto skill with no
      entrypoint) — added to `test-cli.sh` (55e55a00)
- [x] `scripts/dev/docs-screenshots.mjs` `PACKAGES` still enables `plan-write`, which no longer
      exists, so `setUpHome` throws — fixed in review (c5c35b35)
- [x] Open backlog plan `portal-home-onboarding-calls-to-action.md` (lines 37, 113) names
      `plan-write` as a package — fixed in review (a229395d)
- [x] `package-retired-ids-check.mjs` asserts plan-suite's skills and commands only for Claude; the
      hermetic home also installs them for Codex and Gemini — all three asserted; Not tested entry
      narrowed to a live harness session (0d26b9a4)
- [x] Open backlog plan `test-agent-behavior-evals.md` (lines 346, 355) uses `plan-close` as a
      package ID in its example run report — fixed in review (85f3cd2a)
- [x] Coordination did not say that [[ejsc769o]]'s per-skill plan `requires`/`recommends` edges
      merge into `plan-suite` — noted in its Coordination row; that plan settles the merged edges

### Verification

- Validation pass 1: 3 `fix` findings (fresh-context subagent)
- Validation pass 2: 1 `fix` finding (fresh-context subagent)
- Validation pass 3: 2 `fix` findings, 1 `escalate` (fresh-context subagent)
- Validation pass 4: 1 `fix` finding, after merging main (fresh-context subagent)
- Validation pass 5: 3 `fix` findings; the loop stopped at its five-pass cap, and a resumed `/plan-execute` fixed them (e84e3c35) (fresh-context subagent)
- Full gate at e84e3c35: `npm run check` passed — doctor 106 checks, test-cli 463/0, check suites 60/60, package-install, clean-machine Docker suites, portal UI 132; Windows installer parity skipped (pwsh unavailable)
- Resumed run, validation pass 1: 3 `fix` findings (fresh-context subagent)
- Resumed run, validation pass 2: 1 `fix` finding, a docs wording fix (fresh-context subagent)
- Resumed run, validation pass 3: 1 `fix` finding, a missing test (fresh-context subagent)
- Validation: clean on resumed-run pass 4 at 55e55a00 (fresh-context subagent)
- `/plan-review` sync-base at bdde8726: up-to-date with main e479885d
- `/plan-review` validator pass 1 at bdde8726: 3 `fix` findings, 0 `escalate` (fresh-context
  subagent); the ten per-row Validation checks passed
- Full gate at bdde8726: `npm run check` passed — doctor 100 checks, portal UI 132; Windows
  installer parity skipped (pwsh unavailable)
- `/plan-review` validator pass 2 at 0d26b9a4: 2 `fix` findings and 1 `escalate`, reclassified as
  `fix` because the remedy is a Coordination note (fresh-context subagent). Its Not tested finding
  was already fixed in 3dee1cf6
- Full gate at 0d26b9a4: `npm run check` failed once on `browser-lifecycle-check.mjs` (empty JSON
  from the backgrounded `--serve` case, line 50). The branch does not touch that check or the
  browser CLI; it passed 3/3 standalone on the branch and 5/5 on main, so it is intermittent, not a
  base failure
- Full gate at fb0c9543: `npm run check` passed — check suites 60/60, test-cli 464/0, portal UI
  132, clean-machine sandboxes; Windows installer parity skipped (pwsh unavailable)
- `/plan-review` validator pass 3 at fb0c9543: clean (fresh-context subagent)
- Manual: the Not tested entry (a real machine updated from the old plan packages) confirmed by
  the user on 2026-10-26

### Result

- Status: pending
- Reviewed implementation commit: fb0c9543194d39d8d552a54445c24e1904c16414
- Base commit: e479885db4383315645e2ff8a9d7c8ef334de427
- Pending: the Not tested manual check

### Approval

- Decision: not requested (blocked by the unconfirmed manual check)

## Documentation impact

| Doc | Update |
| --- | --- |
| `.claude/skills/roborepo-development/references/package-development.md` | Several skills per package; package, collection, category, and dependency; the authoring question; `package dev add-skill` |
| `docs/user/reference/roborepo-cli.md` | `package dev add-skill` |
| `docs/user/reference/config-control-panel.md` | Contents view and skill-count badge |
| `docs/user/guides/setup-and-daily-use.md` | Replace the six per-package `enable` lines with `plan-suite` |
| `docs/user/guides/plan/lifecycle/plan-suite.md` | Same CLI change, and the new Agents page layout |
| `docs/internal/plans-portal-internals.md` | The six plan package directories become `globals/packages/plan-suite/` |

## Coordination

| Plan | Effect |
| --- | --- |
| [[o9zwxuav]] | Depends on this plan; registry migration fixtures use `plan-suite`. Its dependency-row mockup still shows `/plan-close` as its own card under Plan Suite; after this plan that card is `Development Planning Lifecycle`, under Development Workflows. It should refresh the mockup when it is promoted. |
| [[ejsc769o]] | Depends on this plan; owns the reference audit that flags package-or-collection candidates, and its plan rows collapse into one `plan-suite` row. Its Phase 4 and 5 tasks still give `plan-write`, `plan-promote`, `plan-execute`, `plan-review`, and `plan-close` their own `requires` and `recommends` edges; those merge into the one `plan-suite` manifest, and that plan settles the merged edges when it is promoted |
| [[jdsobwn]] | Depends on this plan; external suites become packages with several skills and use the contents view. It also names `globals/packages/plan-write/skills/plan-write/`, which Phase 4 rewrites |
| [[user-managed-packages-and-add-workflows]] | Depends on this plan; "Multiple things together" asks whether to create a package or a collection; adds the System / Custom / Third Party tabs, inside which the contents view must work unchanged |
| [[46qth5z8]], [[plans-portal-live-refresh-and-static-preflight]], [[plan-lifecycle-suite-blockers-dependencies]] | Not dependencies. Each names a file under `globals/packages/plan-*/`; Phase 4 rewrites those paths to `globals/packages/plan-suite/` and changes nothing else in them |
