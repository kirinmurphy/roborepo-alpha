# Plans Portal Internals

How the `/plans` page is built, for people changing it. User-facing behavior is in
[Plans Portal](../user/reference/plans-portal.md).

## How It Runs

`roborepo web` starts the shared loopback portal server. `/plans` is registered directly in
`scripts/cli/portal-server.mjs`, alongside Config and Telemetry.

The page uses:

- `modules/plan-suite/index.mjs` for parsing, validation, Git metadata, rendering, and prompt generation
- `modules/plan-suite/plan-store.mjs` for the one copy of a repository's plans: locating the reserved worktree, the lock, and fetch, commit, and push (see below)
- `modules/plan-suite/canonical-scan.mjs` and `checkouts.mjs` for the snapshot: each visible registry repository's plans worktree, plus its checkouts for Home and worktree joins
- `modules/repositories/discovery-walk.mjs` for the bounded folder walk that `roborepo plans repair` uses
- `manifests/platform/plan-lifecycle.json` and `modules/plan-suite/lifecycle-manifest.mjs` for the lifecycle model (see below)
- `modules/plan-suite/transition.mjs` for every committed lifecycle move (see below)
- `modules/plan-suite/review-gates.mjs` for the completion preflight and approval freshness, and `sync-base.mjs` for `roborepo plans sync-base`
- `modules/plan-suite/repository-validation.mjs` for `roborepo plans validate` (see below)
- `modules/plan-suite/stop-servers.mjs` for `roborepo plans stop-servers`, which resolves a plan's linked worktree and hands it to `modules/developer-runtime/stop.mjs`
- `scripts/cli/plans.mjs` for portal-facing snapshots and package-state integration, and `scripts/cli/plans-command.mjs` for the `roborepo plans` CLI
- `portal/plans/` for static HTML/CSS/JS
- `portal/shared/base.css` and `portal/shared/theme.js` for the uniform portal
  header, navigation, active-page state, updated-at text, theme toggle, and shared hidden-element
  behavior

Every portal write goes through the store: `POST /api/plans/order` saves a namespace's Backlog order
and `POST /api/plans/namespace-pin` sets its pin (see "Backlog ordering" below). `POST /api/plans/archive`
retires one unprioritized Backlog plan through the same `transitionPlan` as `roborepo plans archive`.
`POST /api/plans/import` saves an uploaded plan through the same `savePlan` as `roborepo plans save`.
Every other lifecycle change is made by the plan suite's commands. Which
repositories Plans reads is decided by the repository registry and its sources
(`scripts/cli/repository-sources.mjs`), not by Plans.

## Plan Store

`plan-store.mjs` owns `origin/repo-plans` and its reserved worktree. It knows nothing about what a plan
means. `locateStore` finds the worktree by its checked-out branch through `linkedWorktrees`, which reads
Git's administrative files so the portal's fingerprint poll spawns nothing; only a reftable repository,
whose HEAD files hold a placeholder, asks Git, and caches the answer on `tables.list`.

`mutateStore({ store, operation })` holds a repository-level lock, fetches and fast-forwards, runs the
operation, commits only the paths it returned, and pushes. The operation reads the fresh tree and returns
`{ files, message, result }` without writing, so a rejected push can re-run it and `plans-order.json` is
recomputed rather than merged. A remote change to the same plan refuses with `PLAN_STORE_CONFLICT`. An
unreachable remote keeps the commit and returns `synchronized: false`; `refreshStore`, which portal
startup and Refresh call, or the next mutation that reaches the remote, pushes pending commits first. Content identical to the file commits
nothing. A failed write or commit restores every touched file.

Store commands run with hooks disabled, because a repository's code hooks can't pass on a tree holding
only plans, and network Git gets a longer timeout through `runGitProcess` without blocking the server's
event loop. `linkedWorktrees` filters the reserved branch out unless the store asks for it, so a new
consumer can't list it by accident.

`plan-writes.mjs` holds the named writes (`savePlan`, `approvePlan`, `setConfigNamespaces`). `plan-git.mjs`
holds code-branch helpers only.

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

`roborepo plans validate` (`repository-validation.mjs`) builds the same records for the repository
containing the current directory through `buildRepositoryPlanSnapshot`, which reads the store, so the
CLI, the transitions, and the page report identical findings from any checkout.

Lifecycle findings are visible in plan records and through `roborepo plans validate`. The portal has
no lifecycle mutation route or move dialog; every move goes through the transition operation below.

## Backlog ordering

| Module | Owns |
| --- | --- |
| `modules/plan-suite/naming.mjs` | `resolvePlanNamespace`: longest approved prefix. `plan.namespace` is computed in `buildPlanRecord`, then recomputed against the store's vocabulary in `repositoryPlanRecords` |
| `modules/plan-suite/backlog-order.mjs` | Pure calculations: `findDependencyCycles`, `deriveGroups`, `proposeOrder` |
| `modules/plan-suite/backlog-registry.mjs` | The registry file: `buildBacklogIndex` (the snapshot's `backlog` field), `saveNamespaceOrder`, `placePlan`, and the private `applyOrder` both of those end in |
| `portal/plans/backlog-model.js` | Pure browser model: URL level, directory counts, prerequisite status, Next up, draft moves on whole blocks |
| `portal/plans/backlog.js` | Directory and list rendering, the draft, Save, and the guard |

The index is calculated from the plans, the config, and the registry on every read and never written,
so a dependency edit regroups on the next load and reaches the file at the next write. A transition
commits only the plan's own paths (an archive adds the dependents it clears) and never touches the registry; `applyOrder` is where a plan that
left Backlog is pruned. Registry reads and writes use the store.

A draft carries the namespace's revision: a hash of the config bytes, the namespace's saved order, and
each namespace plan's id, filename, and `depends_on`. Pins and other namespaces' orders are left out,
since a Save re-reads the file and keeps them. A Save against any other revision is `STALE_ORDER`
(409). The open page learns of changes on load, **Refresh**, after mutations, and at Save; there is no
push channel.

`portal/shared/repository-scope.js` has a `setRepositoryScopeGuard` seam so a page can hold a scope
change. Back/forward cannot be cancelled, so with a dirty draft `app.js` pushes the draft's URL back
and asks; `syncRepositoryScopeFromUrl` then applies the move. A capture-phase click listener covers
links outside the board, the board's own links guard themselves, and `beforeunload` covers tab close
and reload.

Naming findings are blocking: `roborepo plans validate` exits 1, and the promote and start transitions
add them through `namingGateFindings`, since severity alone does not gate a transition.

## Lifecycle Model

`manifests/platform/plan-lifecycle.json` declares each state once: its id and folder, label, tab
placement (primary or overflow), whether it is worktree-bound (Active and
Review), and its copy-prompt actions; plus the transitions, each with its source states,
destination, and the commands that run it. `lifecycle-manifest.mjs` validates it at load and
compiles frozen lookups (`LIFECYCLE_MODEL`). The manifest names states and does not encode rules:

| Reads the model | For |
| --- | --- |
| `index.mjs` | `LIFECYCLES` (the folders) and `PLAN_SUITE_COMMANDS` (every action's command) |
| `lifecycle-policy.mjs` | destination validators keyed by state id; `plan-lifecycle-manifest-check.mjs` asserts every folder has one |
| `naming.mjs` | naming applies to states with an outgoing transition |
| `scripts/cli/worktree-policy.mjs` | worktrees a worktree-bound plan names are never cleaned up automatically |
| `scripts/cli/repository-overview-sources.mjs` | Home joins worktree-bound plans to their worktree rows |
| `canonical-scan.mjs` | publishes `lifecycleProjection()` as the snapshot's `lifecycle` field |

The portal never imports the manifest. `portal/plans/lifecycle.js` holds the projection a page
receives in its plans snapshot (`setLifecycleModel`), and tabs, labels, and
actions (`portal/plans/plan-actions.js`) read it from there.

## Lifecycle Transitions

`transition.mjs` is the one operation behind `roborepo plans promote|start|submit|reopen|close|archive`.
It runs from any checkout, inside one `mutateStore` operation, which it may re-run on a rejected push:

1. resolves the plan from the fresh store and checks the move against the manifest;
2. applies the transition's rules from `transition-rules.mjs` — `start` writes `worktree`, `submit`
   runs the completion preflight, `reopen` invalidates any approval, `close` checks approval
   freshness and landing (`landing-gate.mjs` over `modules/repositories/worktree-landed.mjs`, which
   verifies the plan's recorded absorbing commit before scanning) and clears `next_action`, and
   `archive` writes the reason and declares `clearsReferences`, which removes the plan's id from the
   `depends_on` and `blocked_by` of unfinished plans;
3. validates the content it will commit against the destination (`ready` and `completed` tolerate no
   findings, `active` and `review` tolerate `UNCONFIRMED_NOT_TESTED`, `archived` checks only its
   own rules), refusing with the findings and a repair prompt;
4. returns the old and new paths plus any cleared dependents for the store to commit, then returns six
   post-commit checks from `transition-checks.mjs`. The store refuses when any of those paths has
   uncommitted edits in the plans worktree.

A plan already at the destination returns `alreadyRecorded` without rerunning the gates. `--base` names
the code branch the gates compare against. `landing-gate.mjs` accepts a reachable branch tip for Review
and Completed plans, because a fast-forward merge reads as "no own work" to the generic branch check and
the completion preflight already proved the branch had commits.

## API

All routes are served by the loopback-only portal server.

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/plans` | GET | compact plan index and package state |
| `/api/plans/document?key=<key>` | GET | one plan's Markdown, rendered HTML, metadata, tasks, and warnings |
| `/api/plans/prompt` | POST | build repository-aware or portable prompt from server-issued plan keys |
| `/api/plans/order` | POST | save one namespace's whole Backlog order, guarded by its revision |
| `/api/plans/namespace-pin` | POST | pin or unpin one namespace in `plans-order.json` |
| `/api/plans/archive` | POST | archive one unprioritized Backlog plan with a reason; refuses a ranked plan |
| `/api/plans/import/preview` | POST | what an uploaded plan would do, with a diff for an existing id; writes nothing |
| `/api/plans/import` | POST | save an uploaded plan through `savePlan`; 4 MB body limit |
| `/api/plans/refresh` | POST | fetch each store, push pending commits, and rebuild the in-memory snapshot |

POST routes require the same origin and per-server mutation token protections as other portal
mutations.

Order save failures use the structured domain error serializer in
`scripts/cli/portal-routes-plans.mjs`. Its allowed fields must stay in sync with
`portalPostJson` in `portal/shared/api.js`; otherwise a new field is dropped at the boundary.

The browser sends plan keys, never arbitrary file paths. The server resolves plan keys from the
current snapshot and rechecks repository boundaries before reading document content.

## Key Files

- `manifests/platform/plan-lifecycle.json`
- `modules/plan-suite/index.mjs`
- `modules/plan-suite/lifecycle-manifest.mjs`
- `modules/plan-suite/transition.mjs`, `transition-rules.mjs`, `transition-checks.mjs`
- `modules/plan-suite/review-gates.mjs`, `review-record.mjs`, `sync-base.mjs`
- `modules/plan-suite/plan-store.mjs`, `plan-writes.mjs`, `plan-git.mjs`
- `scripts/cli/plans.mjs`, `plans-command.mjs`
- `scripts/cli/package-status.mjs`
- `scripts/cli/portal-server.mjs`
- `portal/shared/base.css`
- `portal/shared/theme.js`
- `portal/plans/index.html`
- `portal/plans/app.js`
- `portal/plans/lifecycle.js`, `portal/plans/plan-actions.js`
- `portal/plans/styles.css`
- `globals/packages/plan-suite/` (the six plan skills and the Code Outlives Plans rules fragment), `globals/packages/session-close/`
- `scripts/test/plan-store-check.mjs`, `plan-suite-check.mjs`, `plan-suite-findings-check.mjs`, `plan-suite-commands-check.mjs`
- `scripts/test/plan-lifecycle-manifest-check.mjs`, `plan-lifecycle-transitions-check.mjs`, `plan-sync-base-check.mjs`

## Checks To Run

Targeted checks:

```sh
node scripts/test/plan-store-check.mjs
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

## Merge Readiness

`mergeReadiness` requires a committed review packet, a clean index and filesystem, and a current
reviewed base implementation before merging.
