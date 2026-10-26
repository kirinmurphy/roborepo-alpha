---
id: hr78g4sj
priority: high
next_action: Await explicit human approval of reviewed implementation d62ba4d5b9f3f987c2be3eea4410efd1c51e78f6.
blocked_by: []
depends_on: ["wjlt1zvf"]
related: ["4zyo2woj", "8bjltk2n", "46qth5z8", "7k3m9qd", "harness-capability-derived-resource-targeting"]
reviewed_commit: 890f56fe688b314408ee313af01b3601b747b019
worktree: harness-codex-provider-cleanup
---

# Keep local agent work within useful boundaries: Codex — Part 1: Provider cleanup

## Summary

Put the remaining Codex-specific hook and headless-command details behind the provider boundary
before adding credential protection or isolated browser execution. This is the prerequisite for
the other two parts of the series; it changes ownership and dispatch without widening permissions.

## Context

A provider is RoboRepo's adapter for one agent harness. Shared orchestration reads its manifest
and calls its adapters; provider code owns native paths, formats, and command syntax.

| Current touchpoint | Remaining work |
| --- | --- |
| `scripts/cli/hook-composition.mjs` | Main branches on Codex for both file routing and writing. Hook-readiness replaces both in its unlanded branch; consume that implementation after landing |
| `globals/system/hooks/codex/` | Codex scripts still live in the shared system tree. Move their sources provider-side while retaining installed paths and command strings |
| `scripts/cli/telemetry.mjs` | `findDeepReadCli` uses a fixed CLI list and `runDeepRead` passes `-p` to every CLI. Recorded Codex help identifies `-p` as profile selection, not its non-interactive prompt syntax |
| `scripts/cli/worktree-policy.mjs` and provider manifests | The optional Codex worktree-folder declaration depends on the Claude companion's `agentWorktreeDirs` contract and verified app provenance |

Historical preparation evidence (superseded by the execution record below): checked against local main `890f56fe688b314408ee313af01b3601b747b019` on October 24.
The configured origin is `kirinmurphy/roborepo-alpha`; the checkout directory is named `roborepo`.
No remote freshness or push status is inferred. Hook-readiness remains in review. Its authoritative
worktree tip `caa888b897fe0e2c9e4a6ad413b7e3d3e48b29d9` and frontmatter reviewed commit
`7d72487f8461f0243f6ba98e716c8713dba7bd32` are not ancestors of this main; branch containment
lists only its worktree branch. Its reviewed-commit field predates later implementation and review
records. The primary plan copy still describes unfinished work already present in that worktree.

The worktree's latest review records report a package-install smoke failure reproduced on clean
main, separate passing browser checks, and Windows parity deferred to its own plan. Those records
are historical evidence, not checks rerun during this preparation. Landing, current completion-gate
results, and the final accepted contract must be checked before implementation starts. Promotion
prepares this document; it does not clear the dependency recorded in `blocked_by`.

### Related-plan reconciliation

| Plan | Classification | Contract for this cleanup |
| --- | --- | --- |
| [[wjlt1zvf]] | Unlanded dependency; primary-copy and reviewed-commit prose drift | Wait for landing. Preserve manifest-backed routing/writing, Codex append order, optional core bundle, metadata, owned files, and trust safeguards. Its lifecycle stays under its own review workflow |
| [[4zyo2woj]] | Unlanded downstream dependency; backlog | Part 2 depends on this plan and owns native credential denial. Its existing path and original id remain valid |
| [[8bjltk2n]] | Unlanded downstream dependency; backlog | Part 3 depends on Parts 1 and 2 and owns isolated browser execution |
| [[46qth5z8]] | Plan-vs-plan ownership drift; unlanded adjacent story | Its older prose assigns Codex relocation to Part 2. The series split assigns relocation here; Claude relocation and `agentWorktreeDirs` stay with that companion. Separate prose cleanup is needed there |
| [[7k3m9qd]] | Unlanded adjacent story | Retains delivery redesign. Relocation consumes the landed installer contract without adding a delivery planner |
| [[harness-capability-derived-resource-targeting]] | Unlanded adjacent story | Retains resource target selection. Headless eligibility uses enabled providers, independent of package-resource targeting |

Desktop discovery is already landed: `cc4d97b2` is an ancestor of this main, and
`scripts/harnesses/discovery.mjs` exposes `selectedHarnessExecutable`, preferring a validated PATH
executable before a desktop runtime. Reuse it rather than restoring telemetry's `which` loop.

## Series and prerequisites

```mermaid
flowchart LR
  H[Hook readiness] -->|must land before| P1[Part 1: Provider cleanup]
  P1 -->|must land before| P2[Part 2: Credential protection]
  P1 -->|must land before| P3[Part 3: Isolated browser testing]
  P2 -->|must land before| P3
```

| Part | Plan | Ownership |
| --- | --- | --- |
| 1 | This plan | Provider cleanup |
| 2 | [[4zyo2woj]] | Native credential denial; retains the original plan id and probe evidence |
| 3 | [[8bjltk2n]] | One constrained offline app/browser workflow |

`46qth5z8` owns Claude source relocation and the worktree-folder contract. `7k3m9qd` owns package
delivery redesign; capability-derived targeting owns resource selection. These adjacent backlog
plans do not authorize a delivery or permissions-model redesign here.

## Goals

- Shared hook routing consumes provider manifest paths, preserving hook-readiness's contract.
- Codex hook sources have one provider-owned home, with unchanged install destinations.
- Eligible headless providers declare validated argv templates; selection works for a synthetic
  provider without editing a fixed harness list.
- Parts 2 and 3 start only after this prerequisite has landed and been rechecked.

## Proposed design

| Concern | Required implementation |
| --- | --- |
| Hook routing | Consume `hasHarnessPath` / `resolveHarnessPath` routing from hook-readiness. Preserve root-config fixture overrides, checkout-link protection, and `recordConfigWrite`; add only missing regression coverage |
| Hook source ownership | Move `globals/system/hooks/codex/*` to `globals/harnesses/codex/hooks/`. Repoint the dependency's per-file-owned `managed_files` row, preserving `~/.codex/hooks`, native labels, command strings, removal semantics, and standalone manifest discovery/state-root overrides |
| Hook order and trust | Retain appended fragments and existing positions. Preserve foreign-file/symlink conflict handling; never write trust records or restore directory-wide copying |
| Headless invocation | Add `extensions.app.headlessPromptArgs` with one whole-argument prompt placeholder, validated by schema and runtime contract. Discover enabled eligible providers in registry order with existing executable selection, including desktop-only runtimes. Spawn argv directly; preserve public `deepread_cli` report values |
| Worktree folders | Add the Codex declaration only after the companion's field lands and app provenance is verified. Otherwise record the conditional item as deferred; do not invent a second field or block the mandatory cleanup on Claude research |

### Headless contract and ownership

Keep selection and invocation beside their telemetry consumer in `scripts/cli/telemetry.mjs`.
Use `createHarnessRuntime().enabledProviders()` from `scripts/harnesses/harness-runtime.mjs` for
registry-ordered enablement and `selectedHarnessExecutable` for the executable path. The current
`deepread_cli` report field and result `cli` field contain provider command names, not executable
paths; preserve those values while spawning the resolved path. Preserve the existing 60-second
timeout, summary-only prompt, and best-effort error/empty-output handling.

Define `extensions.app.headlessPromptArgs` as a nonempty array of nonempty strings containing
exactly one whole argument `{prompt}`. Reject missing, embedded, or repeated placeholders and
nonstring entries when the field is present; omission means ineligible. Add the same constraints
to `scripts/harnesses/provider-manifest.schema.json` and `scripts/harnesses/contract.mjs`.
The runtime must not spawn an ineligible provider, including malformed data supplied by a fixture.
Substitute the summary prompt as one literal argv element without shell expansion. Real-provider
templates are added only after their selected executable's own help confirms the headless syntax;
this preparation does not claim successful native synthesis.

### Source relocation and ownership

Main still uses `managed_copy` for the Codex script directory. The dependency's worktree uses
`managed_files`, handled by `scripts/cli/shared-target-rows.mjs` and
`scripts/cli/managed-files-row.mjs`. Repoint that landed row rather than reintroducing a directory
copy. `permission-check.mjs` must remain standalone with Node built-ins, preserving `REPO_ROOT`,
`ROBOREPO_STATE_ROOT`, `ROBOREPO_STATE_DIR`, app-root/install-state discovery, and missing-manifest
behavior. Relocation changes source ownership, not the permission classification or trust policy.

Missing or malformed templates, disabled providers, and unavailable runtimes remain explicitly
ineligible. Verify each real argv template with the selected executable's own help; a synthetic
process test proves argument transport, not successful native model synthesis.

## Implementation plan

- [x] Confirm `wjlt1zvf` has landed and inspect current routing, source ownership, trust safeguards,
      config-write logging, and tests. Verify Git ancestry and current behavior before clearing
      `blocked_by`. If unlanded, stop implementation without merging its branch or recreating it.
- [x] Add missing source-relocation and install/remove/idempotence coverage before moving scripts.
- [x] Move Codex sources provider-side and update `manifests/platform/manifest.tsv`, source-path
      references in `scripts/test/test-cli.sh`, and affected docs; preserve installed commands.
- [x] Add failing headless selection/argv cases for omitted/malformed templates, disabled and
      unavailable providers, desktop-only discovery, shell metacharacters, and a synthetic provider.
- [x] Validate the optional template in schema and runtime contract. Extend
      `scripts/test/harness-registry-check.mjs` with valid and invalid manifest fixtures; use existing
      discovery fixtures for PATH preference and desktop fallback, without probing real model calls.
- [x] Add verified eligible-provider templates and migrate both headless selection and invocation.
      Extend `scripts/test/telemetry-synthetic-provider-check.mjs` for a literal prompt argument.
- [x] Recheck the conditional worktree-folder contract; implement only if its prerequisites hold,
      otherwise record why it remains with the companion and does not block Parts 2 and 3.
- [x] Run focused checks and the full local parity gate; document any native synthesis checks
      that need separate authorization rather than making an unapproved model call.
- [x] Update the documentation listed below and scan current source/test/doc references for the
      old source path. Follow the moved file in adjacent backlog plans; preserve historical evidence
      in completed plans and keep their lifecycle unchanged.

## Validation

- Shared hook routing contains neither `harness === "codex"` nor `codexHooksPath` and retains
  manifest-backed synthetic-provider behavior.
- Clean installation and removal preserve user-owned files, native labels, positions, trust
  safeguards, config-write logging, and the existing installed script destinations/commands.
- A synthetic headless provider receives exactly one literal prompt argument. Invalid or missing
  templates degrade gracefully, and no fixed CLI list or shell-string interpolation remains.
- Disabled and unavailable providers are skipped in registry order. PATH and desktop-only fixtures
  receive the resolved executable path; `deepread_cli` and result `cli` retain command-name values.
  Cover whitespace, quotes, newlines, leading dashes, and shell metacharacters in a single prompt,
  plus timeout, nonzero exit, and empty output, without contacting a model service.
- Run `node scripts/test/hook-composition-check.mjs`,
  `node scripts/test/harness-registry-check.mjs`,
  `node scripts/test/telemetry-synthetic-provider-check.mjs`,
  the dependency's `node scripts/test/shared-target-rows-check.mjs`,
  `bash scripts/test/test-cli.sh --quiet`, `bash scripts/test/test-install-collisions.sh --quiet`,
  `env CLEAN_MACHINE_STRICT=1 npm run test:clean-machine-permissions-sandbox`,
  `bash scripts/doctor.sh --quiet`, `git diff --check`, and `npm run check` before handoff.

## Documentation impact

- `docs/user/reference/architecture.md`: update Codex source ownership and retain install paths.
- `docs/internal/hooks-internals.md`, `docs/internal/harness-anatomy.md`,
  `docs/internal/harnesses-explained.md`, `docs/internal/backlog-review.md`: update moved source paths.
- `docs/internal/harness-provider-interface.md`: document headless argv eligibility and templates.
- `docs/user/reference/telemetry.md`: replace the fixed installed-CLI fallback description with
  enabled-provider eligibility, graceful unavailability, and summary-only synthesis.
- `docs/internal/telemetry-internals.md`: document selection, resolved executable invocation,
  unchanged report identifiers, and fixture versus native verification.

## Risks

| Risk | Mitigation |
| --- | --- |
| Hook-readiness advances before cleanup starts | Reinspect landed code; preserve its routing, ownership, ordering, logging, and trust contracts |
| Relocation loses installed standalone manifest discovery | Test installed command strings and state-root overrides, not just source imports |
| Headless argv is mistaken for permission to call a model | Verify transport synthetically; obtain separate authorization for real synthesis when needed |

## Decision Log

- October 24: split provider cleanup out of the combined Codex boundary plan. The user made it
  a prerequisite for all credential and runner implementation. Parts share the same base title,
  with numbered descriptions. The optional Claude-owned folder contract remains conditional.
- October 24 preparation: verified main and the authoritative hook-readiness worktree. Recorded
  the unlanded dependency as an implementation blocker, reconciled the companion's stale ownership
  prose, and made headless validation, state/discovery reuse, report compatibility, and documentation
  touchpoints explicit. The optional folder declaration is still conditional; no code was implemented.

### Additional implementation decisions

- Use the existing runtime and discovery functions beside the telemetry consumer, as specified;
  retain command-name report identifiers while spawning the resolved path.
- Verify Claude and Codex templates from local help and leave Gemini ineligible. Adding an
  unverified template would violate the contract; omission is explicitly supported.
- Use schema draft 2020-12 so `minContains` / `maxContains` enforce exactly one placeholder.
  The existing schema already uses `$defs`; no external draft-07 validator consumer was found in
  scripts. Runtime contract separately rejects malformed templates supplied outside schema validation.
- Correct the standalone source-root fallback to four parent directories. Source-relative lookup
  otherwise resolves `globals/`; explicit repo root, both state-root overrides, recorded app-root,
  install-state, and missing-manifest behavior have executed standalone tests.
- Defer optional Codex worktree-folder declaration: `agentWorktreeDirs` is still proposed in the
  Claude companion backlog and absent from current code. Do not invent a parallel contract.


## Open questions

None. Hook-readiness landing was verified before implementation; no design decision is blocked.

## Execution record

- Start: main `374936e746d7d1a8ab7818a2ece7b1a9d5a96a23`; hook-readiness squash merge
  `b134ef42` is an ancestor, its plan is completed, and current shared hook routing uses
  `hasHarnessPath` / `resolveHarnessPath`. The platform row uses `managed_files`.
- Branch: `codex/harness-codex-provider-cleanup`; Git worktree name:
  `harness-codex-provider-cleanup`. Start transition `b183753b` passed all six checks with zero
  correction passes. Base main's pre-existing telemetry and repository-scope edits are untouched.
- Enabled paired skills: code-style, javascript-typescript, test-harness. React does not apply.
- Provider sources relocated; installed commands and generated hook definitions unchanged.
- Ran local selected-executable help only: Claude desktop runtime `2.1.308` documents `-p`;
  Codex desktop runtime documents `exec [OPTIONS] [PROMPT]`. Gemini has no selected executable.
- Headless template rejection was observed failing before implementation (empty array accepted),
  then passing after implementation. Source-relocation suite initially failed on the missing new
  provider source directory, then passed after relocation.
- Focused assertions passed: hook composition, registry, synthetic headless processes, desktop
  discovery and invocation, and shared-target install/removal/idempotence/conflict handling.
- Strict Docker permissions sandbox passed after retry with Docker access. Doctor passed 107 checks.

- Package build: `npm run build` passed (pack dry run). No running UI is needed for this source
  ownership and argv change; fixture processes exercise invocation and the package build is the
  reviewable delivery artifact. No shareable server URL applies.
- The first full gate encountered localhost `listen EPERM` in the sandbox. The final full gate passed
  with required local-server and Docker access; the first run is not counted as passing.

- Full-gate follow-ups: authorized run had four rules-package assertions fail; the original
  prefix through those assertions passed 146/146 on replay, and the next full run did not repeat
  them. No cause or baseline classification is claimed for those failures.
- The next full run had one existing discovery assertion fail. Instrumented repetition reproduced
  a valid fixture executable's `ETIMEDOUT` at the production two-second probe deadline. The fake
  manifest now grants ten seconds for validity checks; production discovery timing is unchanged.
  The failing assertion and discovery implementation precede this change; the fixture correction
  is included because this run extends the same suite. Diagnostic repetition observed a valid
  executable time out at the production two-second deadline.
- Validation pass 1 at `71af81cf`: fresh-context validator reported no fix/escalate findings after
  reviewing the full diff, acceptance criteria, docs, schema/runtime parity, and skills; reran
  registry, synthetic provider, desktop runtime, shared-target rows, and diff checks successfully.
  Full-gate evidence was pending, so this was not a completion claim.

## Review

### Findings

No implementation fix or escalate findings in the validation passes.

- [x] Durable review evidence contained temporary log paths; replaced them with the observed
  outcomes required by the updated review guidance (d62ba4d5).

### Verification

- Pass 1: clean at `71af81cf`; full parity evidence pending at review time.
- Pass 2: clean at `7997eb72`; independently rechecked the full diff, acceptance criteria, docs,
  schema/runtime constraints, ownership/trust preservation, and paired skills. Registry, synthetic
  provider, desktop runtime, shared-target rows, and diff checks passed. Full parity evidence was
  still pending at review time.

### Completion evidence

- October 25: `npm run check` passed on implementation `7997eb72`, exit 0. It includes doctor
  (107 checks), CLI smoke (457 passed, zero failed), all install-collision checks, 60/60 grouped
  suites, package-install smoke, four strict Docker scenarios, and 130 browser tests.
  The executed gate exited successfully; counts and platform exclusions are recorded here.
- Windows installer parity was skipped because `pwsh` is unavailable. The optional active-root
  verification fixture also reported `uvx` unavailable. Those optional platform/dependency checks
  are not claimed as passed; wider Windows parity remains in its adjacent backlog plan.
- `npm run build`, focused hook composition, registry, synthetic headless invocation, desktop
  runtime, shared-target rows, strict permissions sandbox, and `git diff --check` passed.
- Current source/test/docs scan found no retired Codex source path outside this plan's historical
  context and completed/archived records. All listed docs of record and adjacent backlog pointers
  were updated. No generated hook commands or trust records changed.
- Validation: clean on pass 2 at `7997eb72`, fresh-context subagent; zero fix/escalate findings,
  zero verified base failures, no open questions. Conditional worktree-folder declaration deferred
  as designed. No runtime server is needed for this non-UI change; package build and executed
  fixture processes provide the verification environment, without a persistent shareable URL.
- Implementation commits: `71af81cf` (provider cleanup) and `7997eb72` (fixture startup allowance).
  No push, merge, publication, or native model call was performed.

### Human-review round — October 25

- Base synchronization: user explicitly authorized `roborepo plans sync-base`; merged main
  `6b6521d54433113b4b7afcfc224f09ed6e0104cd` as
  `576f295064e05a5c99f3a4466475bbd69725b7d4`, without conflicts.
- Independent Validator pass: clean at the synchronized commit; zero fix findings and zero
  escalations. Checked every acceptance criterion, docs of record, observable test coverage,
  flow/cohesion, data/state, and comments/abstractions. Registry, synthetic-provider, desktop-runtime,
  shared-target-rows, hook-composition, and diff checks passed.
- Base failure: `npm run check` stops in doctor because `generated/claude/CLAUDE.md` differs from
  rendered rules. `git diff main...HEAD -- globals/system/rules generated` is empty: the failing
  inputs are identical on synchronized main. The command exited 1 at the doctor stage.
- Remaining gate stages are being checked separately. Initial sandbox runs hit local-server
  `listen EPERM` and npm access restrictions; authorized retries are pending. No initial failed
  attempt is counted as passing.
- Review made no implementation fixes. Primary checkout has unrelated edits; they remain outside
  this worktree and are not part of review commits.

### Result
- Status: complete
- Reviewed implementation commit: d62ba4d5b9f3f987c2be3eea4410efd1c51e78f6
- Base commit: 9211dab11354fbf36de3275584b5481987f15481

### Approval
- Decision: requested

### Current review evidence

- Final `npm run check` passed, exit 0, on the synchronized implementation, with only plan-record
  commits afterward. Health: 106 checks; CLI: 457 passed, zero failed; install collisions: all
  passed; grouped CI suites: 60/60; package-install smoke: passed; strict Docker clean-machine,
  install, permissions, and onboarding scenarios: all passed; browser assertions: 130 passed.
  `git diff --check` passed. Windows installer parity was skipped because `pwsh` is unavailable;
  the optional active-root fixture reported `uvx` unavailable. Neither is claimed as passed.
- Earlier generated-rules base failures are historical and resolved in synchronized main. No
  current base failures, open implementation findings, escalations, or required manual checks
  remain. Both primary and worktree statuses were clean before committing this final evidence.
- Review commits: `8b6a424e` recorded the initial review; `d62ba4d5` recorded the second-sync
  acceptance evidence and the sole documentation correction. No implementation fix commit exists.
- Main advanced while verification ran. A second authorized synchronization merged base
  `9211dab11354fbf36de3275584b5481987f15481` without conflicts, producing implementation
  `cdb37fda4d3f31400ab126586e6057f4dee47df5`. That base repairs the earlier generated-rules drift.
- Validator pass 2 found no implementation issues or escalations. Its sole plan-record finding
  was removal of temporary-log references; those now record actual outcomes instead. Incoming
  telemetry projection caching is separate from headless invocation. Synthetic-provider and
  repository-scope assertions passed again.
- The isolated hook-readiness suite passed after the earlier grouped run reported `missing`
  instead of `active`. No cause is claimed for that earlier failure; the final full gate remains
  the completion check.
- Before the second synchronization, all 130 browser tests, the strict permissions Docker
  sandbox, and install-collision tests passed. Other lifecycle failures referred to the now-fixed
  generated-rules drift. These results describe the previous synchronized implementation.
- No code or test fixes were made in review. The optional folder declaration remains deferred by
  design. Real model synthesis is excluded from required manual checks for this cleanup.

| Acceptance area | Code and executed evidence |
| --- | --- |
| Manifest-backed hook routing | Existing shared composition retains path overrides, link protection, and logging; hook-composition assertions passed |
| Provider-owned sources and installed behavior | Provider hook directory and per-file manifest row; shared-target assertions cover install, removal, ownership, conflicts, and standalone lookup |
| Validated headless contract | Schema and runtime contract reject omitted/malformed eligibility; registry and synthetic-provider assertions passed |
| Literal summary transport and failures | Telemetry consumer spawns resolved executable argv; synthetic processes assert summary-only input, metacharacters, timeout, empty output, and nonzero exit |
| Enablement, order, desktop/PATH selection | Runtime registry filtering and discovery; synthetic-provider and desktop-runtime assertions passed |
| Documentation and conditional scope | Architecture, hook, provider, and telemetry docs follow current behavior; old source-path scan found no active source/test/doc references |

## Not tested

- Deferred, optional: native model synthesis using the real provider templates. Local help and synthetic processes
      verify syntax and transport; a real model call requires separate authorization and is not
      needed for the provider cleanup's automated acceptance checks.
