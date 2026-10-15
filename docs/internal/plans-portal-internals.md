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
- `modules/plan-suite/start-transition.mjs` for `roborepo plans start`, the one plan mutation that commits
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

`roborepo plans validate` builds the same records for the one repository containing the current
directory (a linked worktree included) through `buildRepositoryPlanSnapshot`, so the CLI and the
page report identical findings.

Lifecycle findings are visible in plan records and through `roborepo plans validate`. The
`movePlanLifecycle` domain function remains in the plan-suite module, but the portal no longer
exposes a lifecycle mutation route or move dialog.

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

- `modules/plan-suite/index.mjs`
- `modules/plan-suite/start-transition.mjs`
- `scripts/cli/plans.mjs`
- `scripts/cli/package-status.mjs`
- `scripts/cli/portal-server.mjs`
- `portal/shared/base.css`
- `portal/shared/theme.js`
- `portal/plans/index.html`
- `portal/plans/app.js`
- `portal/plans/styles.css`
- `globals/packages/plan-write/`, `plan-promote/`, `plan-start/`, `plan-close/`, `session-close/`
- `scripts/test/plan-suite-check.mjs`, `plan-suite-findings-check.mjs`, `plan-suite-commands-check.mjs`

## Checks To Run

Targeted checks:

```sh
node scripts/test/plan-suite-check.mjs
node scripts/test/plan-suite-findings-check.mjs
node scripts/test/plan-suite-commands-check.mjs
npm run test:packages
node scripts/cli/main.mjs skill render-commands --check
node scripts/cli/main.mjs skill triggers --check
```

Broad smoke after shared portal or package changes:

```sh
npm test
```
