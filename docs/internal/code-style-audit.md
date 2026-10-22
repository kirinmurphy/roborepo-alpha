# Code Style Audit Log

## Purpose

This log records the code style audit: which areas have been reviewed, what each pass changed, and
how the changes were verified. Open defects and design questions live in
[Code Style Findings](code-style-findings.md); when a pass resolves one, the change is recorded
here and the finding leaves that page.

The audit checks maintained source and tests against the installed `code-style`,
`javascript-typescript`, and `test-harness` skills. Cleanup preserves behavior. A verified defect is
fixed only with a regression that fails before the fix and passes after it.

## Scope

- **In scope:** maintained modules, CLI and server code, portal pages, and tests — their comments,
  ordering, duplication, ownership, and reuse.
- **Out of scope:** generated output, vendored libraries, archived packages, and mockup HTML; Codex
  hooks, hook wiring, and supporting harness configuration, excluded at the user's request.

The audit started from `d155e9ae` on `codex/code-style-audit`. A "full" review means every line of
the file was read; an inventory entry is a search result, not a review. Passing tests verify
behavior and do not count as review coverage.

## Coverage

| Area | Status | Evidence |
| --- | --- | --- |
| Retention | Reviewed | All five modules and the retention policy checks. |
| Repository domain | Reviewed; findings open | All 27 modules in `modules/repositories/` read in full. Findings F1, F4–F6. |
| Plan domain | Reviewed; findings open | All 27 modules in `modules/plan-suite/` read in full. Findings F2, F3, F7. |
| Runtime domain | Reviewed; findings open | All 28 modules in `modules/developer-runtime/` read in full, plus the shared command executor added by the audit. Findings F8–F12. |
| CLI and server | Partly reviewed | Agent-run policy, skill-command configuration, telemetry findings/insights/observations, and the Plans CLI and HTTP routing files listed in pass 4. Most CLI files are unreviewed. Finding F13. |
| Portal | Partly reviewed | All 14 Plans JavaScript files, both Plans HTML files, and both Plans stylesheets. Other pages are unreviewed or inventory-only. Findings F14, F15. |
| Installer, providers, hooks, build, maintenance | Inventory only | Source inventory collected; behavior needs review before changes. |
| Tests | Partly reviewed | Runner and CI scripts, retention, idle-cache, telemetry correctness, Runtime history, `plan-suite-authority-edge-check.mjs`, `portal-ui/plans-status.spec.mjs`, and selected scope/documentation browser tests. Finding F16. |

## Passes

### Pass 1 — retention, repositories, telemetry, and plan citations

| Change | Files | Verification |
| --- | --- | --- |
| Reuse the day-duration constant; put the private validator after public functions. | `modules/retention/file-set-store.mjs`, `policy.mjs` | `retention-policy-check.mjs` passed. |
| Reuse the shared enrollment predicate, name the confidence ranks, and put private helpers after public functions. | `modules/repositories/summary.mjs`, `dev-fixtures.mjs`, `discovery-walk.mjs` | All eight repository suites passed. |
| Replace plan references and historical commentary with standalone explanations. | Repository and plan modules; repository CLI and routes; portal comments | `plan-citation-comments-check.mjs` passed. |
| **Defect:** session warning templates called a formatter defined inside another function, so `large_document_read` and `repeated_document_read` warnings threw. | `scripts/cli/telemetry-session-findings.mjs`; new `scripts/test/telemetry-session-findings-check.mjs` in the CI group | The new check failed with `ReferenceError: tok is not defined`; all five warning variants pass after the fix. |
| Share count and text formatting; use named function declarations. | `scripts/cli/telemetry-format.mjs` and its three consumers; agent-run policy; skill-command configuration | Session findings, agent-run policy, and slash-command characterization checks passed. |
| Attach the inline-array export and the frontmatter-writer comment to their own declarations. | `modules/plan-suite/index.mjs` | All eight plan-suite suites passed. |

### Pass 2 — repository and plan modules

| Change | Files | Verification |
| --- | --- | --- |
| Put public functions above private helpers without changing bodies. | `modules/repositories/registry.mjs`, `schema.mjs`, `sources-schema.mjs`, `worktree-removal.mjs` | Repository suites and the worktree lifecycle suite passed. |
| Reuse the identical exported timestamp validator. | `modules/repositories/sources-schema.mjs` | Error wording and validation order preserved; repository suites passed. |
| Correct traversal, cache, and hardening comments. | `modules/repositories/discovery-walk.mjs`, `idle-git-cache.mjs`, `git-exec.mjs` | Checked against the implementation. |
| Put repair entry points above their helpers; correct the Git wrapper description. | `modules/plan-suite/repair.mjs`, `repair-prompt.mjs`, `plan-git.mjs` | All eight plan-suite suites passed. |

### Pass 3 — Runtime modules

| Change | Files | Verification |
| --- | --- | --- |
| **Defect:** history compaction parsed before cutting, so a corrupt line shifted the retention boundary into recent events, and an oversized file with a corrupt tail was never trimmed. Compaction now cuts non-blank physical lines before parsing and keeps the last valid event when the kept tail is corrupt. | `modules/developer-runtime/history.mjs`; three new cases in `scripts/test/developer-runtime-history-check.mjs` | The expired-invalid-record case failed before the fix; all cases pass after it. |
| Add one shared command executor for the listener, process, and Docker providers, keeping per-provider timeouts, UTF-8 output, error propagation, and the 1 MiB output cap. | `modules/developer-runtime/command-exec.mjs` and the five providers | A real subprocess smoke covered stdout/stderr, non-zero exit, and timeout. |
| Reuse `labelFromId` and the stale-days default; use one comparator for all three checkout sorts. | `modules/developer-runtime/snapshot.mjs` | Repository merge checks passed. |
| Put public exports above private helpers; correct identity, mount, and timeout comments. | Process metrics, snapshot, probe, settings schema, discovery | Provider, Compose identity, process, health, Git, repository merge, retention, and history checks passed. |

### Pass 4 — Plans CLI, routing, and browser code

Full reviews added in this pass: the remaining 13 plan modules; `scripts/cli/plans-command.mjs`,
`plans.mjs`, `portal-routes-plans.mjs`, `portal-routes-http.mjs`, `portal-router.mjs`,
`portal-routes-developer-runtime.mjs`, `portal-routes-maintenance.mjs`, `portal-routes-metadata.mjs`,
`portal-routes-repositories.mjs`, `portal-routes-scope.mjs`, `portal-routes-usage.mjs`,
`portal-routes-telemetry.mjs`; every file in `portal/plans/`.

| Change | Files | Verification |
| --- | --- | --- |
| Put entry points and route tables above private helpers; group module constants. | `modules/plan-suite/lifecycle-policy.mjs`, `plan-authority.mjs`; `scripts/cli/plans.mjs`, `portal-routes-plans.mjs`, `portal-routes-developer-runtime.mjs`, `portal-routes-repositories.mjs` | Function bodies and route definitions unchanged. |
| Reuse the exported plan-config path constant. | `modules/plan-suite/naming.mjs` | Resolves the same file. |
| Put template and custom-element helpers after the primary API; remove an unused import. | `portal/plans/templates.js`, `elements/plan-card.js`, `elements/plan-status.js` | Markup and callbacks unchanged. |
| Reuse the drawer's blocker-link renderer in the popover. | `portal/plans/blockers-popover.js` | Resolved links close the popover first; unresolved entries stay plain text. |
| Correct comments about completion ranking, merged badges, option building, and OpenAPI generation and startup. | `portal/plans/state.js`, `templates.js`, `elements/plan-status.js`; `scripts/cli/portal-router.mjs` | No-checklist plans still sort below tracked 0% plans. |
| Shorten historical route commentary; remove obsolete breakpoint and dead-declaration comments. | Runtime, metadata, and telemetry route files; `portal/plans/styles.css` | Route behavior and CSS declarations unchanged. |

Passes 1–4 landed in commit `240102ce`.

### Pass 5 — review of commit `240102ce`

The commit was reviewed for accuracy, performance, security, and conformity. Every move and helper
consolidation was confirmed to be behavior-preserving, no import cycle or use-before-declaration
was introduced, and Git hardening is unchanged.

| Change | Files | Verification |
| --- | --- | --- |
| Restore dropped rationale: why `working_dir` must not decide checkout placement, why a no-repository identity is never promoted, and why bind-mount matches are marked `auto-bind`. Correct the mount-inspection comment. | `modules/developer-runtime/discovery.mjs` | Compose identity suite passed. |
| Correct the blocker-link comment; drop a progress note from the idle-cache header; state the admission rule for the read-only Git allow-list. | `portal/plans/templates.js`, `modules/repositories/idle-git-cache.mjs`, `git-exec.mjs` | Syntax and plan-citation checks passed. |
| Import the shared command executor directly instead of re-exporting it from each provider. | `modules/developer-runtime/discovery.mjs`, `stop.mjs`, `index.mjs`, and the five providers | Runtime suites passed. `index.mjs` still exports `defaultRunCommand`. |
| One strict path validator, `safeAbsolutePath` in `modules/repositories/schema.mjs`, now serves registry roots, repository sources (`safeSourcePath`), and new Runtime `repoPath` input, which previously accepted `..` segments. Stored Runtime settings keep a shape-only check (`safeStoredAbsolutePath`), because `loadSettings` throws on any invalid value. | `modules/repositories/schema.mjs`, `sources-schema.mjs`, `sources.mjs`; `modules/developer-runtime/settings.mjs`, `settings-schema.mjs`; `scripts/test/developer-runtime-check.mjs` | The new case failed without the strict input check and passes with it. It also proves a stored `..` path still loads and does not block an unrelated edit. |
| Split open findings into their own page and restate size-based findings in terms of responsibilities. | This log; `docs/internal/code-style-findings.md` | Documentation reference check passed. |

## Verification notes

- `npm run check` is the completion gate. On `240102ce` it passed every stage: doctor, the CLI
  suite, install collisions, 54/54 CI-group suites, package install, all four Docker clean-machine
  suites, and 104/104 portal browser tests.
- Windows installer parity has not run: the machine that ran these passes has no PowerShell.
  Windows behavior is unverified by this audit.
- Suites that bind `127.0.0.1` (Runtime discovery, metadata suggestions, plan commands) fail with
  `listen EPERM` inside a sandbox that blocks localhost. Run them with localhost access.
- `scripts/test/harness-registry-check.mjs` failed once in a full gate run ("validated executable
  must be detected") and passed on an isolated rerun and the next full run. Neither that check nor
  harness discovery was changed by the audit. The cause is unconfirmed.
