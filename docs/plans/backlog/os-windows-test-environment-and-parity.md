---
id: l1mz96d9
priority: medium
next_action: Inventory the repository's current test and behavior surfaces, classify their Windows coverage, and define the first windows-latest CI matrix.
blocked_by: []
depends_on: []
related:
  - pljvmyh
  - windows-provider-path-schema
reviewed_commit:
worktree:
---

# Windows Test Environment and Behavior Parity

## Summary

RoboRepo is developed primarily on macOS. CI runs the full local parity gate on Ubuntu and macOS,
while its Windows job currently checks only that `install-windows.ps1` parses and that its provider
list matches the manifests. That leaves the rest of RoboRepo's behavior without a repeatable Windows
environment or an explicit record of what is supported, unsupported, or still unverified.

This story establishes Windows as a first-class test target. It adds a reproducible `windows-latest`
runner, inventories the repository's observable behavior, runs the appropriate suites on Windows,
and records every gap with an owner or follow-up plan. The result is a durable compatibility matrix,
not a green job that silently skips platform-specific work.

## Goals

- Use a maintained GitHub Actions Windows runner as the canonical shared test environment; document
  local prerequisites for contributors who have Windows access, but do not require a Windows machine
  for ordinary macOS/Linux development.
- Run a Windows-native test entry point that does not depend on Bash, POSIX path syntax, or Unix-only
  process and filesystem behavior.
- Inventory all user-visible and operational RoboRepo behavior and assign each area an explicit
  Windows result: passed, expected unsupported, not applicable, or blocked with a follow-up.
- Exercise Windows-specific paths, environment variables, temporary directories, process execution,
  PowerShell integration, package lifecycle, configuration projection, portal behavior, Plans,
  repository sources, Runtime, and telemetry where the behavior is supported there.
- Make unsupported behavior deliberate and user-visible, with a test that pins the explanation and
  a linked plan when support is intended later.
- Preserve the existing Linux/macOS parity gate and the current static Windows installer check;
  this story adds coverage rather than replacing those signals.

## Non-goals

- Claiming that every macOS-only Runtime capability, Docker integration, or agent CLI has a Windows
  implementation before its platform dependencies exist.
- Rewriting every Bash installer or replacing the existing `scripts/test/windows-installer-check.ps1`
  static guard as part of the initial environment setup.
- Making the existing `os-windows-provider-path-schema` plan or any other platform-specific repair
  disappear into this story; those plans remain responsible for their implementation changes.
- Requiring contributors without Windows access to maintain a local VM or self-hosted runner.
- Making the Windows job depend on real Claude, Codex, or Gemini installations; fake harnesses and
  deterministic fixtures remain the default for configuration and lifecycle tests.

## Current state

- `.github/workflows/ci.yml` runs the full `npm run check` gate on `ubuntu-latest` and
  `macos-latest`.
- The existing `windows-installer` job runs `scripts/test/windows-installer-check.ps1`. It parses
  `scripts/install/install-windows.ps1` and checks provider-manifest parity, but it does not install
  RoboRepo, run the CLI, exercise the portal, or execute the repository's test groups on Windows.
- The repository's main test entry points include Bash scripts, Docker sandboxes, Node check runners,
  Playwright browser tests, and PowerShell checks. They do not yet have one Windows-safe orchestrator
  that reports what was run and what was intentionally omitted.
- Runtime capability reporting currently identifies automatic localhost discovery as macOS-only in
  `modules/developer-runtime/capabilities.mjs`. That behavior needs an explicit Windows result rather
  than being mistaken for missing test coverage.
- `docs/plans/backlog/os-windows-provider-path-schema.md` already tracks a Windows provider-manifest
  path contract that has no end-to-end Windows verification. This story supplies the environment and
  matrix; that plan owns the path-schema implementation.
- The repository has no single compatibility ledger showing whether CLI commands, package lifecycle,
  harness projection, portal routes, Plans, repository sources, Runtime, and telemetry have been
  observed on Windows.

## Proposed design

### Canonical Windows environment

Use a dedicated `windows-latest` GitHub Actions job as the required environment for Windows coverage.
Pin the Node major version to the repository's current CI version, install from `package-lock.json`,
and keep Windows-specific setup in PowerShell or cross-platform Node. Do not invoke the Bash CI
orchestrator from the Windows job.

The runner should provide isolated, disposable values for the state and user locations used by
RoboRepo:

| Surface | Windows test treatment |
| --- | --- |
| `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP` | Redirect to a per-job fixture root where the test controls cleanup and can assert ownership. |
| npm prefix and cache | Use per-job temporary locations so install and uninstall cannot touch the runner's shared state. |
| Git repositories | Create fixtures with drive-letter paths, spaces, nested folders, and linked worktrees where the runner permits them. |
| Harnesses | Use fake provider executables and fixture homes; real agent CLIs are not prerequisites. |
| Browser | Install the repository's supported Playwright browser and run only the portal tests that are meaningful on Windows. |
| Docker/Compose | Classify separately; run only when the Windows runner and Docker dependency are intentionally provisioned. |

The job must upload the compatibility ledger and failure logs on every run, including failed runs.

### Behavior inventory and result contract

Create one Windows test entry point and one checked-in inventory. The entry point should emit one
stable result per behavior group, never silently swallowing a platform skip:

| Result | Meaning | Required evidence |
| --- | --- | --- |
| `passed` | The observable behavior ran and passed on Windows. | Test output and the named suite. |
| `expected-unsupported` | The product deliberately does not support this behavior on Windows. | User-visible capability/diagnostic assertion and rationale in the inventory. |
| `not-applicable` | The behavior has no Windows analogue or is guarded by an unavailable external dependency. | Explicit reason; no pretending that it was tested. |
| `blocked` | The behavior should be covered but the environment or implementation currently prevents it. | Failure output, owner, and linked follow-up plan. |

The inventory should cover at least these areas:

| Area | Initial Windows coverage target |
| --- | --- |
| CLI and package lifecycle | Help, version, init, update, doctor, package enable/disable, install, uninstall, and collision preservation. |
| Filesystem and paths | Drive letters, separators, spaces, Unicode, case behavior, CRLF, junction/symlink fallbacks, and path privacy. |
| Harness configuration | Provider discovery, generated config, permissions, skills, commands, MCP state, and cleanup using fake harnesses. |
| Portal and HTTP | Server startup, loopback routes, mutation guards, portal API payloads, and supported Playwright flows. |
| Plans | Validation, repair, lifecycle commands, worktree metadata, path-bearing fixtures, and plan discovery. |
| Repositories and sources | Registry persistence, source paths, canonical identity, folder discovery, local roots, and Windows path errors. |
| Runtime | Capability reporting, supported Git/process behavior, explicit unsupported discovery paths, and state persistence. |
| Telemetry | State locations, capture/retention/repair behavior, path-free payloads, and CLI/portal reporting. |
| External integrations | Docker, browser binaries, and real harnesses classified with explicit environment requirements. |

### Ownership and follow-up policy

The ledger is the source of truth for coverage status, while implementation plans own fixes. A
`blocked` row cannot be left as an unexplained red CI line: it must either become a supported test,
be converted to an asserted expected-unsupported result, or link to a focused backlog story.

Windows-only fixes should remain in the owning domain. Shared test setup belongs in the Windows test
runner and fixture helpers; provider path logic belongs in the harness/provider layer; Runtime
capability behavior belongs in the developer-runtime layer; and portal assertions stay with the
portal test suite. Keep orchestration separate from individual behavior checks so a new row can be
added without duplicating runner setup.

## Implementation plan

### Phase 1 — Windows runner and fixture contract

- [ ] Add a Windows-native test entry point and package script that runs from PowerShell/Node without
      depending on `scripts/test/ci.sh` or Bash-only helpers.
- [ ] Define isolated state, home, temp, npm-prefix, npm-cache, and workspace locations for each
      Windows job; assert cleanup and ownership at the end of the run.
- [ ] Install Node, npm dependencies, PowerShell prerequisites, and the supported Playwright browser
      using the same versions as the existing CI matrix.
- [ ] Add reusable Windows fixture helpers for drive-letter paths, spaces, Unicode, CRLF, fake
      harnesses, Git repositories, and linked worktrees.
- [ ] Make the `windows-latest` job upload the ledger and diagnostic logs on success and failure.

### Phase 2 — Behavior inventory and first coverage pass

- [ ] Add a checked-in Windows compatibility inventory covering every area in the proposed design,
      with an explicit result contract and links to the owning test or follow-up plan.
- [ ] Map existing `scripts/test/*`, package scripts, CI jobs, and platform capability branches to
      inventory rows; identify Bash-only and macOS-only assumptions rather than silently skipping them.
- [ ] Run the CLI, package lifecycle, filesystem, harness projection, Plans, repository/source,
      portal, Runtime, and telemetry groups on Windows where their dependencies are available.
- [ ] Extend the existing Windows installer check only where it is needed to distinguish static
      parity from real installer behavior; keep its current guardrails intact.
- [ ] Add observable assertions for every expected-unsupported Windows behavior, including the
      current Runtime discovery capability message and source-path rejection behavior.

### Phase 3 — Gap resolution and follow-up stories

- [ ] Triage every `blocked` or failing inventory row into an in-scope portability fix, an
      `expected-unsupported` contract, or a focused follow-up plan.
- [ ] Link existing Windows work, including `os-windows-provider-path-schema`, to the affected
      inventory rows and record which checks become available after each plan lands.
- [ ] Ensure the Windows job fails on an unexpected missing or skipped row, while allowing only
      inventory-backed expected skips.
- [ ] Document how contributors read the ledger, reproduce a Windows failure, and add a new behavior
      row without weakening the coverage contract.

## Validation

The repository's native checks remain the baseline on macOS/Linux. The new Windows job must also
produce a complete ledger and pass the Windows-specific entry point.

```text
Windows:
npm run test:windows
pwsh -File scripts/test/windows-installer-check.ps1

macOS/Linux baseline:
npm run check
```

The exact command names may be adjusted during Phase 1 to match the repository's existing runner
conventions, but the final command must be discoverable from `package.json` and CI rather than being
an undocumented workflow-only script.

## Decision Log

| Decision | Alternatives | Why |
| --- | --- | --- |
| Use `windows-latest` GitHub Actions as the canonical environment | Require a self-hosted Windows machine; rely on manual confirmation | It is reproducible for the project and available to contributors without Windows hardware. |
| Use a Windows-native Node/PowerShell runner | Invoke the Bash CI wrapper through Git Bash | The goal is to expose Windows path, shell, and filesystem assumptions rather than hide them behind a compatibility layer. |
| Record explicit expected-unsupported and not-applicable results | Treat every non-run suite as a pass; require every feature to run identically | Platform differences are legitimate, but they must be visible, tested where possible, and linked to ownership. |
| Keep fixes in focused domain plans | Put every Windows repair into this one broad story | The environment and ledger are shared infrastructure; product/domain behavior needs focused design and review. |

## Open Questions

None are blocking for backlog creation. Phase 1 should confirm the exact Windows runner setup and
whether Docker/Compose coverage is worth provisioning before it is added to the required matrix.

## Risks

| Risk | Mitigation |
| --- | --- |
| A broad matrix becomes slow or flaky | Group by failure meaning, cache dependencies, keep fixtures disposable, and make external integrations optional with explicit results. |
| Windows-only skips become permanent blind spots | Require every skip to be typed, explained, and linked to a capability contract or follow-up plan. |
| CI cost grows with browser and install coverage | Reuse one setup per job, cache Node/Playwright dependencies, and separate expensive external integrations from the required core matrix. |
| Windows filesystem semantics differ from the runner's permissions | Test junction/symlink fallbacks explicitly and record capability-dependent cases instead of assuming privileged links. |

## Acceptance Criteria

- A required `windows-latest` job runs a discoverable Windows-native test command with isolated state and uploads its ledger/logs.
- The inventory covers every current behavior area listed in the proposed design and assigns each row a non-silent result.
- The Windows run exercises the supported CLI, package lifecycle, filesystem, harness, Plans, repositories, portal, Runtime, and telemetry behavior available on the runner.
- Expected-unsupported behavior has user-visible assertions and does not appear as an unexplained failure or silent skip.
- Every blocked or failing row has an owner and a focused follow-up plan, including links to existing Windows plans where applicable.
- The existing Linux/macOS `npm run check` gate and static Windows installer parity check continue to pass.
- A contributor can add or investigate a Windows coverage row using repository documentation and the recorded fixture contract.
