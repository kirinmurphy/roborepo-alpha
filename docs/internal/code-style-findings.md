# Code Style Findings

## Purpose

These are the open findings from the code style audit: defects and design questions that need a
decision before anyone changes code. Each one is judged against the installed `code-style`,
`javascript-typescript`, and `test-harness` skills. Modules are split where responsibilities change
for different reasons, serve different consumers, or need isolated tests — never because a file is
long.

What has been reviewed, what has already changed, and how it was verified live in the
[Code Style Audit Log](code-style-audit.md). A finding leaves this page once it is resolved, and the
pass that resolves it records the change in the log.

## Summary

| ID | Finding | Kind |
| --- | --- | --- |
| F1 | Idle Git cache can report a clean checkout after a tracked file is edited | Correctness |
| F2 | Plan record cache keeps stale Git metadata after a commit | Correctness |
| F3 | Synchronous Git readers bypass the hardened executor | Correctness |
| F4 | Repository identity mixes identity derivation with Git filesystem resolution | Boundary |
| F5 | Repository registry combines persistence with several mutation families | Boundary |
| F6 | Repository schema serves registry validation and shared field validators | Boundary |
| F7 | Plan domain index mixes parsing, discovery, mutation, and presentation | Boundary |
| F8 | Runtime discovery combines scan orchestration with Compose resolution and placement | Boundary |
| F9 | Runtime snapshot construction combines matching, grouping, shaping, and ranking | Boundary |
| F10 | Runtime settings mix persistence, migration, mutation, and normalization | Boundary |
| F11 | Runtime metadata and probe modules mix network collection with document parsing | Boundary |
| F12 | Runtime Git collection mixes filesystem observations with subprocess reads | Boundary |
| F13 | Plans CLI combines dispatch, argument handling, output, and domain calls | Boundary |
| F14 | Plans browser modules span independent controllers | Boundary |
| F15 | Tokens page builds multi-element markup in JavaScript | Markup |
| F16 | Browser suites use structural selectors for named controls | Tests |

## Correctness

### F1 — Idle Git cache can report a clean checkout after a tracked file is edited

- **Evidence:** `modules/repositories/idle-git-cache.mjs` fingerprints the mtimes of the Git
  directory, `HEAD`, `index`, and `packed-refs`. `readIdleGit` in `scripts/cli/developer-runtime.mjs`
  caches the whole `collectGitContext` result, including dirty state. In a real temporary
  repository, after a tracked file was edited, the cached read still reported clean while a fresh
  read reported dirty: the edit did not change the fingerprint.
- **Next step:** add a real-filesystem regression, then either bound the cache lifetime or keep
  working-tree state out of the cache and cache only ref state.
- **Why discuss:** correctness against polling cost. The existing fake-filesystem cache tests assert
  read counts and cannot reach this path.

### F2 — Plan record cache keeps stale Git metadata after a commit

- **Evidence:** `readPlanRecord` in `modules/plan-suite/index.mjs` reuses a record while file mtime,
  repository root, namespaces, and lifecycle match. Committing an untracked plan without editing
  it leaves the mtime unchanged, so a later read still reported `gitStatus="?? <plan path>"` and
  `gitLastChangedAt=null` while Git reported a clean, committed file.
- **Next step:** cache the parsed document separately from Git observations, and review status and
  review-state refresh together. Add a real-repository regression before changing behavior.
- **Why discuss:** fresh Git reads add subprocess cost to every scan. Cache ownership belongs with F7.

### F3 — Synchronous Git readers bypass the hardened executor

- **Evidence:** `modules/plan-suite/index.mjs`, `scripts/cli/telemetry-capture.mjs`, and
  `scripts/cli/telemetry-markers.mjs` call `spawnSync("git", ...)` with no timeout, so a hung Git
  process blocks the caller indefinitely. Capture also runs its own diff-fingerprint command.
- **Next step:** review each command and its error contract, then move compatible calls to
  `defaultRunGitSync` or `runGitProcessSync` in `modules/repositories/git-exec.mjs`.
- **Why discuss:** the read-only allow-list refuses some of these commands (`branch`, `diff`), and
  changing timeout, error, or environment behavior needs per-consumer regressions.

## Module boundaries

### F4 — Repository identity mixes identity derivation with Git filesystem resolution

- **Responsibilities:** `modules/repositories/identity.mjs` normalizes remotes and derives
  repository ids (pure string rules) and also resolves Git directories from the filesystem
  (`resolveGitDir`, `resolveProjectIdentity`).
- **Why split:** the two halves need different test seams — string fixtures against an injected
  filesystem — and the filesystem half changes when Git layouts change, not when id rules do.
- **Next step:** review consumers, then move filesystem resolution beside its callers and keep
  identity normalization pure.
- **Why discuss:** repository services import identity helpers widely, so the dependency direction
  must stay acyclic.

### F5 — Repository registry combines persistence with several mutation families

- **Responsibilities:** `modules/repositories/registry.mjs` owns file I/O and revisioned writes,
  plus mutations for discovery provenance, checkout ownership, enrollment, visibility, and aliases.
- **Why split:** persistence changes for storage reasons; each mutation family changes for its own
  product reason and has a different set of service callers.
- **Next step:** separate persistence from discovery/checkout mutations and repository-preference
  mutations, keeping one public API.
- **Why discuss:** several services share these operations; a split needs a consumer and dependency
  review first.

### F6 — Repository schema serves registry validation and shared field validators

- **Responsibilities:** `modules/repositories/schema.mjs` validates registry records, roots,
  discoveries, enrollments, and the alias graph. It also exports the field validators other stores
  use: `safeIsoTimestamp` and `safeAbsolutePath` serve the repository-sources store, and
  `safeAbsolutePath` validates new Runtime `repoPath` input.
- **Why split:** the field validators now have consumers outside the registry, and the alias-graph
  rules change independently of record shape.
- **Next step:** move the shared field validators into their own module; then separate record
  validation from registry graph validation, preserving validation order and messages.
- **Why discuss:** validation messages are observable in CLI and server responses and in tests.

### F7 — Plan domain index mixes parsing, discovery, mutation, and presentation

- **Responsibilities:** `modules/plan-suite/index.mjs` parses frontmatter, discovers plan files,
  reads Git observations, applies mutations, renders document HTML, and builds public projections.
  It imports the CLI Markdown renderer, so presentation for one consumer lives in the shared domain
  module.
- **Why split:** the HTML belongs to the portal consumer; parsing and mutation have their own
  tests; F2's cache fix needs a clear owner for Git observations.
- **Next step:** separate parsing, file operations, mutations, and presentation; trace document
  consumers before moving HTML rendering.
- **Why discuss:** crosses module and consumer boundaries and needs a broad dependency review.

### F8 — Runtime discovery combines scan orchestration with Compose resolution and placement

- **Responsibilities:** `modules/developer-runtime/discovery.mjs` orchestrates the whole scan in
  `discoverInstances`, and also implements Compose repository resolution
  (`collectGitForComposeProjects`) and checkout ownership (`classifyComposeProjects`,
  `classifyComposeOwnership`).
- **Why split:** Compose placement rules change on their own and are tested through their own
  suite; the orchestrator should read as a list of steps.
- **Next step:** move Compose resolution and ownership into a focused module, keeping the public
  API.
- **Why discuss:** manual placement, `working_dir` inference, bind-mount agreement, and the shared Git
  and mount caches must keep their precedence and reuse.

### F9 — Runtime snapshot construction combines matching, grouping, shaping, and ranking

- **Responsibilities:** `modules/developer-runtime/snapshot.mjs` matches apps, groups repositories
  and checkout roots, shapes members, ranks, and aggregates. `buildRepositories` alone makes
  separate passes over active, Compose, unmatched, persisted, and known-worktree inputs.
- **Why split:** member projection and ranking change with display rules; repository and root
  assembly changes with registry shape.
- **Next step:** separate member projection and ranking from repository/root assembly, leaving the
  entry point to coordinate them.
- **Why discuss:** the portal still reads both the legacy project collections and the repository
  cards, so moving or dropping either needs a consumer review.

### F10 — Runtime settings mix persistence, migration, mutation, and normalization

- **Responsibilities:** `modules/developer-runtime/settings.mjs` reads and writes the settings file,
  migrates versions with backups, and applies mutations including alias-graph merges with conflict
  handling. `settings-schema.mjs` holds validation and normalization.
- **Why split:** migrations change when the file format changes; mutations change with features;
  file I/O changes with storage rules.
- **Next step:** separate version migration and in-memory mutation from persistence; review the
  schema boundary separately.
- **Why discuss:** migration backups, revision conflicts, alias merge errors, and validation order are
  observable behavior. `loadSettings` throws on any invalid stored value, which stops every Runtime
  snapshot, so stricter stored-value rules need a migration rather than a validator change.

### F11 — Runtime metadata and probe modules mix network collection with document parsing

- **Responsibilities:** `modules/developer-runtime/metadata.mjs` fetches metadata sources and parses
  OpenAPI references and schemas. `probe.mjs` makes bounded HTTP requests, decides redirects and
  TLS handling, and extracts HTML.
- **Why split:** the parsers are pure and can be tested with fixture documents; the network code
  needs request fakes and safety tests.
- **Next step:** extract OpenAPI parsing and response-document parsing from fetch and probe
  orchestration.
- **Why discuss:** network safety, per-source failure handling, suggestion deduplication, and response
  fields need independent regressions before the split.

### F12 — Runtime Git collection mixes filesystem observations with subprocess reads

- **Responsibilities:** `modules/developer-runtime/git.mjs` reads filesystem observations, calls
  branch-sync, and runs subprocess drift and status reads. Pure ref parsing already lives in
  `git-refs.mjs`.
- **Why split:** the two halves have different test seams (injected `fsApi` against `runGit`) and
  different failure modes (missing files against slow or failing subprocesses).
- **Next step:** confirm the halves change separately before splitting; if they do, separate
  filesystem observations from subprocess observations.
- **Why discuss:** per-scan caching, null-on-unavailable results, and the injected filesystem, path,
  and Git seams must stay consistent. This is the weakest boundary finding; drop it if the halves
  change together.

### F13 — Plans CLI combines dispatch, argument handling, output, and domain calls

- **Responsibilities:** `scripts/cli/plans-command.mjs` routes subcommands, parses and validates
  arguments, formats output, and invokes lifecycle transitions, preflight, approval, landing, base
  synchronization, server stopping, and repair.
- **Why split:** each command's output format changes with that command; argument and error
  handling is shared by all of them.
- **Next step:** separate command-specific output from dispatch and shared argument/error handling,
  following the existing domain API.
- **Why discuss:** usage errors, JSON and text output, exit codes, and asynchronous operations are CLI
  contracts; a split needs command-by-command checks.

### F14 — Plans browser modules span independent controllers

- **Responsibilities:** `portal/plans/app.js` handles filter drafts, sync polling, rendering,
  mutation coordination, stale recovery, and toasts. `state.js` covers filters, sorting, URL state,
  progress, joins, and blocker relationships. `templates.js` covers cards, onboarding, menus, and
  drawer projections.
- **Why split:** filters, mutations, and repository sync change for different reasons and race in
  different ways.
- **Next step:** review separate filter, mutation, and repository-sync controllers, grouping shared
  state and rendering by consumer.
- **Why discuss:** the drawer is shared with Home, status elements rely on record replacement to clear
  loading, and navigation/mutation races need browser regressions first.

## Markup and tests

### F15 — Tokens page builds multi-element markup in JavaScript

- **Evidence:** `portal/tokens/app.js` uses `innerHTML` for session findings, turns, waste cards,
  investigation sections, and raw tables.
- **Next step:** move each rendered unit into HTML templates and split rendering from page
  orchestration, following the framework-less markup convention.
- **Why discuss:** spans many interactive views and needs browser coverage. Moving strings into
  template variables would not satisfy the convention.

### F16 — Browser suites use structural selectors for named controls

- **Evidence:** `scripts/test/portal-ui/repository-scope.spec.mjs` selects navigation links with
  `#nav > a` and text, while other links use role and name. The seven specs contain 342
  `.locator()` calls; layout assertions legitimately need structural access.
- **Next step:** convert interaction selectors to role/name section by section, keeping structural
  selectors where geometry or style is under test.
- **Why discuss:** broad automatic replacement could change which element matches; each spec needs
  review by feature.
