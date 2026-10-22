# Code style audit

## Scope and evidence

This audit checks maintained source and tests against the installed `code-style`,
`javascript-typescript`, and `test-harness` skills. Style fixes preserve behavior; verified
defects are recorded separately from cleanup. Larger restructures and behavior decisions are recorded for discussion. Generated output,
vendored libraries, archived packages, and mockup HTML are excluded from automatic cleanup.

The audit started from commit `d155e9ae78ac09dbe910aff211838f18d0e0b626` on
`codex/code-style-audit`. The original work window ended October 22, 2026 at 05:30 America/Bogota.
An inventory finding is a search result, not a completed file review.

The next clock read after pending verification calls returned was October 22 at
08:56 America/Bogota, beyond the requested cutoff. The audit stopped at that point;
the repository-wide review remained partial. Work resumed in the same audit worktree on
October 22, 2026 under a new continuation request, without the original timebox. The latest Git
state and coverage are recorded in the latest continuation below.

## Coverage

| Area | Status | Evidence |
| --- | --- | --- |
| Retention | Reviewed | Read all five modules and the retention policy checks; focused checks pass. |
| Repository domain | Static review complete; findings open | Read all 27 modules in full during continuation. Public/helper ordering, duplication, comments, ownership, and cache boundaries reviewed. Eight repository suites pass before and after cleanup; worktree lifecycle checks pass. Identity/registry/schema splits and cache freshness remain open. |
| Plan domain | Static review complete; findings open | All 27 modules read in full across the continuations; the Plans continuation below explicitly closes the remaining file coverage. Module boundaries, Git execution, and the verified stale-cache case remain open. |
| Runtime domain | Static review complete; findings open | Read all 28 existing modules in full, plus the new command executor. Fixed corrupt-history retention with a failing-then-passing regression. Provider, health, Git, retention, and snapshot checks pass; larger boundaries remain for discussion below. |
| CLI and server | Partly reviewed | Reviewed agent-run policy, command configuration, telemetry findings/insights/observations, and selected call sites. The Plans continuation adds twelve complete file reviews below. Most CLI files remain unreviewed. |
| Portal | Partly reviewed | All 14 Plans JavaScript files, both Plans HTML files, and both Plans stylesheets read in full. Other pages remain unreviewed or inventory-only. Framework-free HTML templates and light-DOM custom elements are established conventions. |
| Installer, providers, hooks, build, maintenance | Inventory only | Source inventory collected; behavior needs review before changes. |
| Tests | Partly reviewed | Reviewed runner/CI, retention, idle-cache, telemetry correctness, selected scope/documentation browser tests, and the two full suites named in the Plans continuation. Browser selector inventory collected; broad test review remains unfinished. |

## Changes and verification

| Change | Files | Verification |
| --- | --- | --- |
| Reuse the existing day-duration constant and place the private validator after public functions. | `modules/retention/file-set-store.mjs`, `policy.mjs` | `node scripts/test/retention-policy-check.mjs` passed. |
| Reuse the shared enrollment predicate, name confidence ranks, and move private helpers after public functions. | `modules/repositories/summary.mjs`, `dev-fixtures.mjs`, `discovery-walk.mjs` | `node scripts/test/run-checks.mjs --filter repositories` passed all eight suites before the subsequent comment-only cleanup. |
| Replace stale plan references and historical commentary with standalone explanations. | Repository and plan modules; repository CLI/routes; portal comments. | `node scripts/test/plan-citation-comments-check.mjs` passed; the continuation full gate also passed. |
| Fix session warning templates calling a formatter outside its scope. | `scripts/cli/telemetry-session-findings.mjs`; new `scripts/test/telemetry-session-findings-check.mjs`, registered in the CI group. | The new test first failed with `ReferenceError: tok is not defined`; all five warning variants pass after the fix. |
| Share duplicated count/text formatting and use named function declarations. | `scripts/cli/telemetry-format.mjs`, telemetry consumers, agent-run policy, and skill-command configuration. | Session findings, agent-run policy, and slash-command characterization checks pass. |
| Put the inline-array export and frontmatter-writer explanation on their intended declarations. | `modules/plan-suite/index.mjs` | Seven plan-suite suites passed in the sandbox; the remaining plan-command suite passed with localhost access. |

During the original session, the first `npm run check` stopped after 402 main-suite checks passed and three failed;
local server creation reported `listen EPERM`. The unrestricted retry passed all 447 main
checks and the install-collision checks, then reported 49/54 passing CI-group suites. Four
browser suites could not import the worktree's missing `@playwright/test` dependency.
The fifth failure was this log's invalid function-qualified file reference, corrected
during handoff. The continuation below resolves the dependency setup and records a passing full gate.

## Findings for discussion

| Finding | Evidence | Proposed next step | Why discuss |
| --- | --- | --- | --- |
| Repository identity mixes identity derivation with Git filesystem resolution | `modules/repositories/identity.mjs` contains `resolveProjectIdentity`, `resolveGitDir`, and identity helpers in 259 lines. | Review consumers, then split filesystem resolution from identity normalization. | The dependency direction must remain acyclic because repository services import identity helpers widely. |
| Repository registry combines persistence and several mutation responsibilities | `modules/repositories/registry.mjs` contains file I/O, discovery provenance, checkout ownership, enrollment, visibility, and aliases in 399 lines. | Separate persistence, discovery/checkouts, and repository preference mutations; retain one public API. | Several services share these operations, so this needs a consumer/dependency review before splitting. |
| Repository schema combines record validation and registry graph validation | `modules/repositories/schema.mjs` contains record, root, discovery, enrollment, and alias-graph validation in 298 lines. | Separate record validators from registry validation while preserving validation order and messages. | Validation errors are observable contracts in CLI/server callers and existing tests. |
| Idle Git cache can report a clean checkout after a tracked file is edited | `modules/repositories/idle-git-cache.mjs` fingerprints only `.git`, `HEAD`, `index`, and `packed-refs`; `readIdleGit` in `scripts/cli/developer-runtime.mjs` caches all of `collectGitContext`, including dirty state. A real temporary repository returned `firstDirty=false`, `cachedDirty=false`, `freshDirty=true` after editing a tracked file. | Add a real-filesystem regression; choose a bounded refresh lifetime or separate uncached working-tree state from cached ref state. | Correctness versus polling cost is a behavior/performance choice. The existing fake-filesystem cache tests assert read counts and cannot expose this path. |
| The plan domain index mixes parsing, discovery, mutations, document HTML, and public projections | `modules/plan-suite/index.mjs` is 874 lines and imports the CLI Markdown renderer. | Separate parsing, file operations, mutations, and presentation; trace document consumers before moving HTML rendering. | This crosses module and consumer boundaries and requires a broader dependency review. |
| Tokens still authors substantial multi-element markup in JavaScript | `portal/tokens/app.js` uses `innerHTML` for session findings, turns, waste cards, investigation sections, and raw tables. | Move each rendered unit into actual HTML templates and split rendering from page orchestration. | This spans many interactive views and needs browser coverage; string-to-template-variable conversion would not satisfy the skill. |
| Browser suites use structural selectors for controls that already have semantic names | `scripts/test/portal-ui/repository-scope.spec.mjs` selects navigation links with `#nav > a` and text, while other links use role/name. The seven spec files contain 342 `.locator()` calls by textual inventory; layout assertions legitimately need structural access. | Convert interaction selectors section by section, retaining geometry/style assertions where layout is the subject. | Broad automatic replacement could change element matching; the largest spec is 1,393 lines and needs review by feature. |

## Remaining work and verification limits

| Element | State | Next action |
| --- | --- | --- |
| Full completion gate | Passed after Plans cleanup | The final settled-source `npm run check` passed 447 main checks, install collisions, 54 CI-group suites, package install, four Docker clean-machine suites, and 104 portal browser tests. |
| Windows installer parity | Not run locally; PowerShell unavailable | Verify through the Windows parity check in an environment with PowerShell. The local gate explicitly skipped it. |
| Remaining audit coverage | Unfinished | Continue into the remaining CLI/server, portal, installer, providers, build, maintenance, and test files. Plan-module static review is complete. Codex hooks and supporting configuration are excluded from this pass at the user's request. Inventory-only entries have not received a code review. |

## Original-session handoff checks

Focused passing checks include retention policy, all eight repository suites, telemetry
correctness, the new session-findings regression, agent-run policy, slash-command
characterization, orphan-test registration, plan citations, seven plan-suite checks,
and the plan-command check rerun with localhost access. Final checks passed for all 30
changed JavaScript modules' syntax, all 103 doctor checks, documentation references,
and whitespace (`git diff --check`). At that handoff, the full completion gate remained unpassed.

## Continuation — October 22, 2026

The starting status and diff were inspected before editing. The existing branch and all
previous changes were preserved.

| Additional change | Files | Verification |
| --- | --- | --- |
| Group public functions above private helpers without changing function bodies. | `modules/repositories/registry.mjs`, `schema.mjs`, `sources-schema.mjs`, `worktree-removal.mjs` | All eight repository suites pass; worktree lifecycle suite passes. An initial helper move matched the prefix of `validateSources` and produced a syntax error; corrected before the passing rerun. |
| Reuse the identical exported timestamp validator. | `modules/repositories/sources-schema.mjs` imports `safeIsoTimestamp` from `schema.mjs`. | Repository source/schema behavior passes in the eight-suite rerun; error wording and validation order preserved. |
| Replace historical traversal prose and correct cache/hardening comments. | `modules/repositories/discovery-walk.mjs`, `idle-git-cache.mjs`, `git-exec.mjs` | Comments checked against implementation. The idle-cache refresh policy remains unchanged. |
| Put repair entry points above their private helpers and correct the Git wrapper description. | `modules/plan-suite/repair.mjs`, `repair-prompt.mjs`, `plan-git.mjs` | Seven of eight plan-suite suites passed in the sandbox; `node scripts/test/plan-suite-commands-check.mjs` passed when rerun with localhost access after `listen EPERM`. |
| Restore the worktree's test dependencies using the CI workflow. | Ignored `node_modules`; package manifest and lockfile unchanged. | `npm ci --no-audit --no-fund` passed. Chromium availability probe passed. |

### Additional findings for discussion

| Finding | Evidence | Proposed next step | Why discuss |
| --- | --- | --- | --- |
| Plan record cache retains stale Git metadata after a commit | `readPlanRecord` in `modules/plan-suite/index.mjs` keys reuse on file mtime, repository root, namespaces, and lifecycle. In a real temporary repository, reading an untracked plan, committing it without editing it, then reading again returned `gitStatus="?? docs/plans/backlog/feature-cache.md"` and `gitLastChangedAt=null`, while direct Git reads returned clean status and a commit timestamp; file mtime was unchanged. | Keep parsed-document caching separate from Git observations; review status and review-state refresh together. Add a real-repository regression before changing behavior. | Fresh Git reads increase scan subprocess cost; cache ownership and invalidation belong in the proposed plan-index split. |
| Several synchronous Git readers bypass the hardened repository executor | `modules/plan-suite/index.mjs`, `scripts/cli/telemetry-capture.mjs`, and `scripts/cli/telemetry-markers.mjs` use `spawnSync("git", ...)` without a timeout; capture also has a separate diff fingerprint command. | Review each command and its error contract, then adopt the shared executor where compatible. | The read-only wrapper rejects some existing commands (`branch`, `diff`); timeout/error and environment changes require consumer-specific regression coverage. |

### Review boundaries

| Reviewed files | Result |
| --- | --- |
| All 27 files in `modules/repositories/` | Full static style review completed. Larger module-boundary findings and idle-cache correctness remain unresolved; passing tests do not settle them. |
| `modules/plan-suite/index.mjs` | Read all 874 lines. Parsing, discovery, Git observations, mutation, and output still share one module; split remains for discussion. |
| `modules/plan-suite/sync-base.mjs`, `landing-gate.mjs`, `repair-prompt.mjs`, `repair.mjs`, `plan-git.mjs`, `plan-id.mjs`, `section-synonyms.mjs`, `stop-servers.mjs`, `worktree-copy.mjs`, `review-gates.mjs`, `transition-checks.mjs`, `transition-rules.mjs` | Read each file in full; repair-helper placement and Git wrapper comment corrected. The domain-wide review remains partial because prior-session coverage is not a complete file-by-file record. |
| `modules/plan-suite/findings.mjs` | Read the complete catalog and constructors. The table is cohesive configuration; splitting it just by line count would not separate responsibilities. No change applied. |
| Runtime, portal, installer, providers, hooks, build, maintenance | Coverage remains as stated above; no full review claimed in this continuation. |

### Continuation verification

The first continuation gate reached 402 passing main checks and three failures caused by
`listen EPERM` (Runtime discovery, metadata suggestions, and plan commands). After all source
edits, the full gate passed with localhost access. The focused plan-command retry also passed.
The full gate ran package-install smoke and all four Docker clean-machine suites, plus all 104
portal UI tests in Chromium. Windows installer parity was explicitly skipped because PowerShell
was unavailable; this local pass does not establish Windows behavior.

```text
npm ci --no-audit --no-fund -> pass
node scripts/test/run-checks.mjs --filter repositories -> pass (8/8 before and after cleanup)
node scripts/test/worktree-lifecycle-check.mjs -> pass
node scripts/test/run-checks.mjs --filter plan-suite -> 7/8; command suite blocked by localhost sandbox
node scripts/test/plan-suite-commands-check.mjs -> pass with localhost access
node --check <each changed JavaScript module> -> pass (36 modules)
npm run check -> pass with localhost access (447 main; 54/54 CI-group; 104 browser tests)
bash scripts/doctor.sh --quiet -> pass (103 checks, within full gate)
node scripts/test/docs-reference-check.mjs -> pass after final log update
git diff --check -> pass after final log update
```

### Handoff before the Runtime pass

Stay in the existing audit worktree on `codex/code-style-audit`; read status and diff before
editing. All changes remain uncommitted. Continue from the coverage table and the explicit file
review list above. Keep the nine open discussion findings (seven original and two additional)
separate from routine cleanup; neither cache policy nor the large module splits were implemented.
The dependency blocker is resolved, and the full local gate passed for this continuation's source
changes. Further source edits need checks appropriate to their scope.

## Runtime continuation — October 22, 2026

The user requested continued auditing while another branch enables Codex hooks. This pass changes
Runtime modules, the existing Runtime history test, and this log only. Codex hooks, hook wiring,
harness/provider configuration, generated outputs, installers, and test orchestration are outside
this pass. The existing worktree and branch remain in use; earlier uncommitted changes are preserved.

### Coverage and applied changes

| Area | Evidence and result |
| --- | --- |
| All 28 existing Runtime modules | Read every file in `modules/developer-runtime/` in full, including discovery, snapshots, settings/schema, metadata/probes, Git, Docker, process metrics, health, history, identity, roles, provenance, and server stopping. This is static style review; it does not prove every runtime scenario. |
| History compaction correctness | Added cases to `scripts/test/developer-runtime-history-check.mjs`. Before the fix, the expired-invalid-record case failed: expected both recent events, but only the second survived. `compactHistory` in `modules/developer-runtime/history.mjs` now cuts the nonblank physical lines before parsing; corrupt prefixes no longer shift the cut into live events. It preserves the final valid event when the retained physical tail is corrupt. All three new cases and the existing suite pass. |
| Repeated command execution | Added `modules/developer-runtime/command-exec.mjs`; the listener, process, Docker discovery, Docker stats, and Docker mount providers import and re-export its `defaultRunCommand`. Existing names, per-provider timeouts, UTF-8 output, error propagation, and the 1 MiB output cap are preserved. A real subprocess smoke passed for stdout/stderr, nonzero exit, and timeout. |
| Snapshot reuse | `modules/developer-runtime/snapshot.mjs` reuses `labelFromId` and the stale-days default from `settings-schema.mjs`, and uses one private comparator for all three checkout-sort paths. Repository merge checks pass. |
| Public entry points and comments | Grouped public exports above private helpers in process metrics, snapshots, probe, schema, and discovery. Corrected stale identity/mount/timeout comments and shortened misplaced Compose-resolution commentary. No hook behavior or configuration was edited. |
| Tests | Read the complete Runtime history suite, added regressions there, and ran focused provider, Compose identity, process, health, Git, repository merge, retention, and history checks. Other Runtime tests are verification coverage, not claimed as fully reviewed test code. |

### Runtime findings for discussion

| Finding | Evidence | Proposed direction | Why discuss |
| --- | --- | --- | --- |
| Discovery combines scan orchestration with Compose resolution and placement | `modules/developer-runtime/discovery.mjs` contains `discoverInstances`, `collectGitForComposeProjects`, `classifyComposeProjects`, and exported `classifyComposeOwnership`. The latter operations account for most of the implementation beyond scan orchestration. | Move Compose repository resolution and checkout ownership into focused modules while retaining the current public API. | Manual placement, working_dir inference, bind-mount agreement, and shared Git/mount caches must retain their precedence and reuse. |
| Snapshot construction combines app matching, repository grouping, member shaping, ranking, and aggregation | `modules/developer-runtime/snapshot.mjs` is over 800 lines; `buildRepositories` alone spans multiple passes over active, Compose, unmatched, persisted, and known-worktree inputs. | Separate member projections/ranking from repository/root assembly and leave the entry point to coordinate them. | Consumers still use both legacy project collections and repository cards; moving or dropping either representation needs a consumer review. |
| Runtime settings mix persistence, migrations, mutations, and normalization | `modules/developer-runtime/settings.mjs` is 304 lines; `settings-schema.mjs` is 272 lines. Mutations include alias graph merges with conflict handling, separate from file I/O and version migrations. | Separate version migration and in-memory mutation responsibilities from persistence; review schema boundaries separately. | Migration backups, revision conflicts, alias merge errors, and validation order are existing observable behavior. |
| Metadata and probe modules mix network collection with substantial parsing | `modules/developer-runtime/metadata.mjs` is 334 lines and includes OpenAPI reference/schema handling; `probe.mjs` is 229 lines and includes bounded HTTP requests, redirect/TLS decisions, and HTML extraction. | Extract OpenAPI document parsing and response-document parsing from fetch/probe orchestration. | Network safety, per-source failure handling, suggestion deduplication, and response fields need independent regression coverage before a larger split. |
| Git collection remains above the style size limit | `modules/developer-runtime/git.mjs` is 253 lines despite already delegating pure ref parsing to `git-refs.mjs`; it still combines filesystem observations, branch-sync calls, and subprocess drift/status reads. | Review a focused split between filesystem observations and subprocess-derived observations. | Existing per-scan caching, null-on-unavailable semantics, and injected filesystem/path/Git seams must stay consistent. |

### Runtime verification

The new history regression failed before the fix and passes afterward. Targeted checks pass for
history, Docker discovery/stats/mounts, process metrics, Compose identity, health, Git context,
repository merging, and retention policy. Syntax passes for all 49 changed JavaScript modules;
plan-citation, documentation-reference, and whitespace checks pass.

The first full Runtime gate passed 446 main checks and failed `scripts/test/harness-registry-check.mjs`
at the fixture assertion "validated executable must be detected". That file and the harness discovery
implementation are unchanged by this audit. An isolated rerun with the same unrestricted access
passed. The cause is unconfirmed. A full gate retry against unchanged source passed all stages, with the
user's Codex-hook exclusion preserved. The retry included all 447 main checks, 54 CI-group suites,
package install, install collisions, four Docker suites, and all 104 portal browser tests. Windows
installer parity was explicitly skipped because PowerShell was unavailable.

```text
node scripts/test/developer-runtime-history-check.mjs -> failed before fix; passed after fix
node scripts/test/developer-runtime-{docker,docker-stats,docker-mounts,process,compose-identity,health,git,repository-merge}-check.mjs -> each passed
node scripts/test/retention-policy-check.mjs -> pass
node --check <each changed JavaScript module> -> pass (49 modules)
npm run check -> first run 446/447 main checks; unchanged-source retry PASS
node scripts/test/harness-registry-check.mjs -> isolated retry PASS; also passed in full retry
npm run check, final retry -> 447/447 main; 54/54 CI-group; 104/104 portal browser tests; all four Docker suites passed
bash scripts/doctor.sh --quiet -> pass (103 checks, within full gate)
node scripts/test/plan-citation-comments-check.mjs -> pass
node scripts/test/docs-reference-check.mjs -> pass after final log update
git diff --check -> pass after final log update
```

### Handoff before the Plans pass

All 28 existing Runtime modules have received a static style review; the new shared command executor
was also reviewed. The history corruption defect is fixed and covered by regression tests. Five
larger Runtime refactors join the nine prior discussion findings; their behavior and boundaries
remain unchanged. The overall audit remains partial: remaining plan-file coverage, most CLI/server
code, portal code, installers, build/maintenance code, and broad test review are still unfinished.
Codex hooks and their supporting configuration remain outside the current pass at the user's request.

Continue in the same audit worktree on `codex/code-style-audit`. The final Git recheck found commit
`f90f3fd8` (`code refactor`), containing all 52 files from the accumulated audit and Runtime changes.
The assistant did not create that commit. Only this log's final verification/handoff edits remain
uncommitted. Re-read status and diff before working; the earlier assumption that all source edits
were still uncommitted is superseded by this observed state.

A comparison against the original audit base confirms earlier audit source edits were preserved;
new changes in this pass are restricted to Runtime modules, its existing history check, and this log.
No Codex hook, harness configuration, installer, or generated-output edits were introduced.

## Plans continuation — October 22, 2026

Before editing, Git status, the full working diff, and recent commits matched the previous handoff:
`codex/code-style-audit` at `f90f3fd8`, with only this log modified. That commit and all pre-existing
log changes were preserved. No branch, worktree, merge, synchronization, or commit was created.

### Review coverage

| Area | Complete static reviews in this continuation |
| --- | --- |
| Remaining 13 plan modules | `modules/plan-suite/copy-integration.mjs`, `checkouts.mjs`, `repository-validation.mjs`, `review-freshness.mjs`, `review-record.mjs`, `canonical-scan.mjs`, `lifecycle-manifest.mjs`, `lifecycle-policy.mjs`, `naming.mjs`, `plan-authority.mjs`, `plan-copies.mjs`, `snapshot-fingerprint.mjs`, `transition.mjs`. Together with the 14 previously recorded complete file reviews, these close static coverage for all 27 modules. |
| Plans CLI and HTTP routing | `scripts/cli/plans-command.mjs`, `plans.mjs`, `portal-routes-plans.mjs`, `portal-routes-http.mjs`, `portal-router.mjs`, `portal-routes-developer-runtime.mjs`, `portal-routes-maintenance.mjs`, `portal-routes-metadata.mjs`, `portal-routes-repositories.mjs`, `portal-routes-scope.mjs`, `portal-routes-usage.mjs`, `portal-routes-telemetry.mjs`. The server composition root was searched to verify route-validation wiring; it was not fully reviewed. Config/settings routes remain excluded where they concern harness setup. |
| Plans browser JavaScript | All 14 JavaScript files in `portal/plans/`, including the four files under `elements/`. Read full bodies, including state/filtering, markup, lifecycle, drawer, popover, toast, and page orchestration. |
| Plans markup and styles | `portal/plans/index.html`, `plan-drawer-partial.html`, `styles.css`, `plan-drawer.css`. Static review covers templates, selectors, responsive rules, and ownership; it does not establish visual correctness at every viewport. |
| Tests | Read all of `scripts/test/plan-suite-authority-edge-check.mjs` and `scripts/test/portal-ui/plans-status.spec.mjs`. Read `scripts/test/portal-ui/run.mjs` to select the browser command; harness isolation and test startup remain excluded from edits. Other executed suites are verification, not additional static-review coverage. |

### Applied cleanup

| Change | Files | Behavior preserved |
| --- | --- | --- |
| Put public entry points and route tables above private helpers; group the reftable placeholder with module constants. | `modules/plan-suite/lifecycle-policy.mjs`, `plan-authority.mjs`; `scripts/cli/plans.mjs`, `portal-routes-plans.mjs`, `portal-routes-developer-runtime.mjs`, `portal-routes-repositories.mjs` | Function bodies, route definitions, lifecycle rules, and cache policies are unchanged. |
| Reuse the exported plan-config path constant. | `modules/plan-suite/naming.mjs` | Resolves the same repository-relative file. |
| Put private template and custom-element helpers after the primary API; remove an unused date-formatter import. | `portal/plans/templates.js`, `elements/plan-card.js`, `elements/plan-status.js` | Existing markup, callbacks, and rendering decisions remain unchanged. |
| Reuse the drawer's existing blocker-link renderer in the popover. | `portal/plans/blockers-popover.js` | Resolved links close the popover before opening the target; unresolved entries remain plain text. |
| Correct comments about completion ranking, merged badges, template options, and OpenAPI generation/startup ownership. | `portal/plans/state.js`, `templates.js`, `elements/plan-status.js`; `scripts/cli/portal-router.mjs` | No ranking, display, routing, or API behavior changed. In particular, no-checklist plans still sort below tracked 0% plans. |
| Shorten historical route commentary and remove obsolete breakpoint/dead-declaration comments. | `scripts/cli/portal-routes-developer-runtime.mjs`, `portal-routes-metadata.mjs`, `portal-routes-telemetry.mjs`; `portal/plans/styles.css` | Runtime CSS declarations and route behavior are unchanged. |

### Additional findings for discussion

These are style and ownership findings, not newly demonstrated correctness defects. The fourteen
previous findings remain open; the following two bring the discussion total to sixteen.

| Finding | Evidence | Proposed next step | Why discuss |
| --- | --- | --- | --- |
| Plans CLI combines command routing, argument parsing, output, and domain invocation | `scripts/cli/plans-command.mjs` is 293 lines covering validation, lifecycle transitions, preflight, approval, landing, base synchronization, server stopping, and repair. | Separate command-specific output from dispatch and shared argument/error handling, following the existing domain API. | Usage errors, JSON/text shapes, exit codes, and asynchronous operations are observable CLI contracts; a split needs command-by-command checks. |
| Plans browser boundaries still span independent responsibilities | `portal/plans/app.js` is 606 lines including filter drafts, sync polling, rendering, mutation coordination, stale recovery, and toasts; `state.js` is 306 lines including filters, sorting, URL state, progress, joins, and blocker relationships; `templates.js` is 352 lines covering cards, onboarding, menus, and drawer projections. | Review separate filter, mutation, and repository-sync controllers, with shared state and rendering pieces grouped by their consumers. | The drawer is shared with Home, status elements depend on record replacement to clear loading, and navigation/mutation races need browser regressions before moving ownership. |

### Verification and limits

The focused plan suite initially passed seven of eight checks; the command suite could not bind
`127.0.0.1` (`listen EPERM`). Its rerun with localhost access passed all eight suites without a
source change between attempts. Syntax checks passed for all fifteen changed JavaScript modules.
The initial full gate started before the final route/comment cleanup and passed 447 main checks,
54 CI-group suites, package install, install collisions, all four Docker suites, and 104 portal
browser tests. The final full gate against the settled source also passed every stage with the
same counts. Windows installer parity was skipped because PowerShell is unavailable.

No Codex-hook script, composition, harness/provider contract or configuration, installer/rendering
implementation, generated output, or test orchestration was changed. Package-enablement calls in
Plans were reviewed as consumers only; their implementation remains outside this pass.

### Next coverage

Continue through other CLI/server domains, then the other portal pages and tests.
Installer/provider/configuration areas that overlap Codex hooks remain excluded.
The overall audit is unfinished, and the sixteen larger discussion findings have not been
implemented. All new changes remain uncommitted on the existing audit branch.

### Final verification and handoff

```text
node scripts/test/run-checks.mjs --filter plan-suite -> initial 7/8 (localhost blocked); retry PASS 8/8
node --check <each changed JavaScript module> -> PASS (15 modules)
npm run check -> initial PASS; final settled-source PASS
  main: 447/447; CI-group: 54/54; portal browser: 104/104
  install collisions, package install, all four Docker clean-machine suites: PASS
  doctor: 103 checks passed; Windows installer parity: SKIPPED (PowerShell unavailable)
node scripts/test/plan-citation-comments-check.mjs -> PASS
node scripts/test/docs-reference-check.mjs -> PASS after final log update
git diff --check -> PASS after final log update
```

The existing `f90f3fd8` commit remains unchanged. The working diff contains fifteen JavaScript
modules, one Plans stylesheet (comments only), and this log; all seventeen files remain uncommitted.
The pre-existing log edits are preserved. The separate hooks worktree was searched read-only to
locate a later wording request; the user confirmed keeping this chat on the audit, so that worktree
was not edited. Continue from the coverage table; passing suites do not extend static review to
unread files.
