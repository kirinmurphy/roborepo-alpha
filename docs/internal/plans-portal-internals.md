# Plans Portal Internals

How the `/plans` page is built, for people changing it. User-facing behavior is in
[Plans Portal](../user/reference/plans-portal.md).

## How It Runs

`roborepo web` starts the shared loopback portal server. `/plans` is registered directly in
`scripts/cli/portal-server.mjs`, alongside Config and Telemetry.

The page uses:

- `modules/plan-suite/index.mjs` for parsing, validation, Git metadata, rendering, and prompt generation
- `modules/plan-suite/canonical-scan.mjs` and `checkouts.mjs` for the snapshot: every checkout of each visible registry repository, merged by plan `id` with the main checkout canonical
- `modules/repositories/discovery-walk.mjs` for the bounded folder walk that `roborepo plans repair` uses
- `manifests/platform/plan-lifecycle.json` and `modules/plan-suite/lifecycle-manifest.mjs` for the lifecycle model (see below)
- `modules/plan-suite/transition.mjs` for every committed lifecycle move (see below)
- `modules/plan-suite/review-gates.mjs` for the completion preflight and approval freshness, and `sync-base.mjs` for `roborepo plans sync-base`
- `modules/plan-suite/repository-validation.mjs` for `roborepo plans validate` (see below)
- `modules/plan-suite/stop-servers.mjs` for `roborepo plans stop-servers`, which resolves a plan's linked worktree and hands it to `modules/developer-runtime/stop.mjs`
- `scripts/cli/plans.mjs` for portal-facing snapshots, package-state integration, and the `roborepo plans` CLI
- `portal/plans/` for static HTML/CSS/JS
- `portal/shared/base.css` and `portal/shared/theme.js` for the uniform portal
  header, navigation, active-page state, updated-at text, theme toggle, and shared hidden-element
  behavior

The portal writes to plan files through `POST /api/plans/priority`, which rewrites the
`priority` frontmatter line. Lifecycle changes are made by the plan suite's commands. Which
repositories Plans reads is decided by the repository registry and its sources
(`scripts/cli/repository-sources.mjs`), not by Plans.

## Scan Cache

Per-file scan results (parsed content, task counts, and git-derived fields like `reviewState`) are
cached in-process keyed by the file's mtime, so a file is only re-parsed and re-queried against git
when it actually changes on disk. Directory listing itself always runs fresh, so added/removed
files are seen immediately; only the expensive per-file work is skipped for unchanged files.

## Readiness Findings

Section synonyms live in `modules/plan-suite/section-synonyms.mjs`, the single place to extend when a
document uses a reasonable heading the scanner does not yet recognize.

Each problem is reported as a finding with a stable code, a plain-language message, a resolution
describing the fix, and optional structured metadata (an unchecked-task count, the accepted heading
names for a missing section). `plan.validation` carries both `findings` and `warnings`, the latter
being the message strings, so display and search keep working while the dialog, the API, and prompt
generation read the structured form.

Structural parsing skips fenced code blocks, so a sample heading or checkbox inside a fence never
becomes a section, a task, or a `## Not tested` entry. Cross-plan relationship findings are appended
to a copy of each cached record's validation, never to the cached record itself, so a rescan reports
each one once.

`roborepo plans validate` (`repository-validation.mjs`) builds the same records for the one
repository containing the current directory. From the main checkout it scans that checkout and its
linked worktrees with `scanCheckout` and `selectRecords`, under one repository identity, so each
Active or Review plan is validated from its authoritative copy and the CLI and the page report
identical findings. From a linked worktree it validates that checkout's own copies through
`buildRepositoryPlanSnapshot`, which is what a suite skill working in the worktree wants. Each result
names the copy it validated (`validated.source`: `worktree`, `primary`, or `checkout`). The
transitions also use `buildRepositoryPlanSnapshot`, from the primary checkout, because they move the
primary copy.

Lifecycle findings are visible in plan records and through `roborepo plans validate`. The portal has
no lifecycle mutation route or move dialog; every move goes through the transition operation below.

## Lifecycle Model

`manifests/platform/plan-lifecycle.json` declares each state once: its id and folder, label, tab
placement (primary or overflow), whether priority shows, whether it is worktree-bound (Active and
Review), and its copy-prompt actions; plus the transitions, each with its source states,
destination, and the commands that run it. `lifecycle-manifest.mjs` validates it at load and
compiles frozen lookups (`LIFECYCLE_MODEL`). The manifest names states and does not encode rules:

| Reads the model | For |
| --- | --- |
| `index.mjs` | `LIFECYCLES` (the folders) and `PLAN_SUITE_COMMANDS` (every action's command) |
| `lifecycle-policy.mjs` | destination validators keyed by state id; `plan-lifecycle-manifest-check.mjs` asserts every folder has one |
| `naming.mjs` | naming applies to states with an outgoing transition |
| `plan-authority.mjs` | worktree-bound states, whose assigned worktree holds the authoritative copy |
| `scripts/cli/worktree-policy.mjs` | worktrees a worktree-bound plan names are never cleaned up automatically |
| `scripts/cli/repository-overview-sources.mjs` | Home joins worktree-bound plans to their worktree rows |
| `canonical-scan.mjs` | publishes `lifecycleProjection()` as the snapshot's `lifecycle` field |

The portal never imports the manifest. `portal/plans/lifecycle.js` holds the projection a page
receives in its plans snapshot (`setLifecycleModel`), and tabs, labels, priority display, and
actions (`portal/plans/plan-actions.js`) read it from there.

While a plan is in Review its worktree copy may still be in `active/`. `plan-copies.mjs` reads the
worktree's copy under the primary copy's stage (`readPlanRecord(..., { lifecycle })`) and records
`primaryRelativePath` when the paths differ.

## Lifecycle Transitions

`transition.mjs` is the one operation behind `roborepo plans promote|start|submit|reopen|close|archive`.
It runs from the primary checkout on the base branch and:

1. resolves the plan from the primary checkout and checks the move against the manifest;
2. refuses when the plan's own paths have uncommitted changes, except for transitions that carry
   the command's own edits (`promote`, `close`); unrelated work never blocks it;
3. applies the transition's rules from `transition-rules.mjs` — `start` writes `worktree`, `submit`
   runs the completion preflight, `close` checks integration (`copy-integration.mjs`), approval
   freshness, and landing (`modules/repositories/worktree-landed.mjs`), `archive` applies the copy
   carry and writes the reason;
4. validates the content it will commit against the destination (`ready` and `completed` tolerate no
   findings, `active` and `review` tolerate `UNCONFIRMED_NOT_TESTED`, `archived` checks only its
   own rules), refusing with the findings and a repair prompt;
5. `git mv`, writes the content, commits with `--only` the old and new paths, and returns six
   post-commit checks from `transition-checks.mjs`.

A plan already at the destination returns `alreadyRecorded` without rerunning the gates; for
`promote` and `close` it commits the command's pending edits to the plan, if any. Git access for these
modules is in `plan-git.mjs`.

## API

All routes are served by the loopback-only portal server.

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/plans` | GET | compact plan index and package state |
| `/api/plans/document?key=<key>` | GET | one plan's Markdown, rendered HTML, metadata, tasks, and warnings |
| `/api/plans/prompt` | POST | build repository-aware or portable prompt from server-issued plan keys |
| `/api/plans/priority` | POST | change one plan's priority, guarded by expected value and mtime |
| `/api/plans/refresh` | POST | rebuild the in-memory snapshot |

POST routes require the same origin and per-server mutation token protections as other portal
mutations.

Priority mutation failures use the structured domain error serializer in
`scripts/cli/portal-routes-plans.mjs`. Its allowed fields must stay in sync with
`portalPostJson` in `portal/shared/api.js`; otherwise a new field is dropped at the boundary.

The browser sends plan keys, never arbitrary file paths. The server resolves plan keys from the
current snapshot and rechecks repository boundaries before reading document content.

## Key Files

- `manifests/platform/plan-lifecycle.json`
- `modules/plan-suite/index.mjs`
- `modules/plan-suite/lifecycle-manifest.mjs`
- `modules/plan-suite/transition.mjs`, `transition-rules.mjs`, `transition-checks.mjs`
- `modules/plan-suite/review-gates.mjs`, `review-record.mjs`, `copy-integration.mjs`, `sync-base.mjs`
- `scripts/cli/plans.mjs`
- `scripts/cli/package-status.mjs`
- `scripts/cli/portal-server.mjs`
- `portal/shared/base.css`
- `portal/shared/theme.js`
- `portal/plans/index.html`
- `portal/plans/app.js`
- `portal/plans/lifecycle.js`, `portal/plans/plan-actions.js`
- `portal/plans/styles.css`
- `globals/packages/plan-write/`, `plan-promote/`, `plan-execute/`, `plan-review/`, `plan-close/`, `plan-archive/`, `session-close/`
- `scripts/test/plan-suite-check.mjs`, `plan-suite-findings-check.mjs`, `plan-suite-commands-check.mjs`
- `scripts/test/plan-lifecycle-manifest-check.mjs`, `plan-lifecycle-transitions-check.mjs`, `plan-sync-base-check.mjs`

## Checks To Run

Targeted checks:

```sh
node scripts/test/plan-suite-check.mjs
node scripts/test/plan-suite-findings-check.mjs
node scripts/test/plan-suite-commands-check.mjs
node scripts/test/plan-lifecycle-manifest-check.mjs
node scripts/test/plan-lifecycle-transitions-check.mjs
node scripts/test/plan-sync-base-check.mjs
node scripts/test/plans-portal-state-check.mjs
npm run test:packages
node scripts/cli/main.mjs skill render-commands --check
node scripts/cli/main.mjs skill triggers --check
```

Broad smoke after shared portal or package changes:

```sh
npm test
```
