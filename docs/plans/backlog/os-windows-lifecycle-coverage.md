---
id: 0pzhhong
priority: low
next_action: Define real lifecycle scenarios against the shared Windows environment contract and prove isolation before invoking installation.
blocked_by: []
depends_on: ["l1mz96d9"]
related: ["windows-provider-path-schema"]
reviewed_commit: 57f8f2199b6db87d829af8d41e387800518024c9
---

# Verify installation, updates, and removal on Windows

## Summary

Add automated Windows lifecycle coverage that runs real installation, update, and uninstall
commands and checks their filesystem effects. A green Windows job should establish that managed
configuration is applied correctly and user-owned files survive removal.

## Context

[Platform coverage](../../internal/testing.md#platform-coverage) describes the existing macOS,
Linux, and Windows checks. The current Windows job in `.github/workflows/ci.yml` runs
`scripts/test/windows-installer-check.ps1`: it checks PowerShell syntax and provider-list parity,
but does not install or remove anything. The supported setup prerequisites are documented in
[First-Time Setup](../../user/guides/first-time-setup.md#windows).

The related [provider path-schema plan](os-windows-provider-path-schema.md) concerns manifest-based
path resolution. Lifecycle tests can begin against the current installer independently; any path
failure should first be reproduced before deciding whether that separate change is needed.

## Goals

- Exercise checkout installation and the shipped package's lifecycle on real Windows.
- Verify repeat installation/update, configuration ownership, and removal through public commands.
- Make missing Windows prerequisites and incomplete scenarios visible failures in the CI job.
- Preserve the existing fast PowerShell syntax/provider check and macOS/Linux coverage.

## Proposed design

Use a disposable `windows-latest` runner with Node, PowerShell, and Git Bash. Each scenario receives
a fresh profile, app-data directories, npm prefix/cache, state root, workspace, and command path.
Establish which environment variables and OS profile APIs the actual commands read before relying
on redirection. Seed a sentinel outside the scenario roots and assert it is unchanged afterward.
If profile redirection is incomplete, use a separate disposable Windows account or VM boundary.

```mermaid
flowchart LR
    runner[Disposable Windows runner] -->|create isolated roots| scenario[Lifecycle scenario]
    scenario -->|invoke public commands| install[Install]
    install -->|verify managed files and repeat| update[Update or apply]
    update -->|preserve user edits and remove managed state| uninstall[Uninstall]
    uninstall -->|assert retained and removed paths| checks[Filesystem assertions]
    checks -->|publish failures and destroy roots| finish[Job result]
```

| Proposed owner | Responsibility |
| --- | --- |
| `scripts/test/windows-lifecycle-check.ps1` | Preflight, scenario selection, timeout handling, and result summary. |
| Shared Windows environment from [[l1mz96d9]] | Runner/profile isolation, prerequisites, state/workspace roots, and shared execution helpers. Lifecycle scenarios add only their own child execution and cleanup. |
| `scripts/test/windows-lifecycle/checkout.ps1` | Checkout installer and update scenarios using `scripts/install/install-windows.ps1` and the public lifecycle commands. |
| `scripts/test/windows-lifecycle/package.ps1` | Local tarball installation, package initialization/apply/update, uninstall, and npm removal. |
| `scripts/test/windows-lifecycle/ownership.ps1` | Assertions for managed links/config and user-owned sentinels, shared where the two install modes have the same contract. |
| Shared Windows job in `.github/workflows/ci.yml` | Consume provisioning, prerequisites, ledger, and artifact upload owned by [[l1mz96d9]]; add lifecycle scenario results to that job. |
| `docs/internal/testing.md` | Verified platform matrix and the Windows reproduction command. |

The proposed files are new. Keep each focused; split scenario families when
setup or failure meaning differs. Invoke shipping commands instead of reproducing installer logic
inside the tests. Pack the checkout once and use that local tarball for package scenarios.

## Implementation plan

- [ ] Inventory public install/update/uninstall dispatch on Windows for checkout and package modes;
      record the exact commands and prerequisites as the scenario matrix.
- [ ] Consume the shared environment owner's isolation, symlink, and Git Bash prerequisites; prove
      lifecycle-scenario cleanup with an intentionally failing child process before installation.
- [ ] Add a failing clean-install scenario, then make it pass through the production entry points.
      Check configured harness roots, managed links, generated configuration, and CLI availability.
- [ ] Cover repeated install/update and a local fixture change. Assert convergence without duplicate
      hooks or links, preserving unrelated user config and handling owned-file edits explicitly.
- [ ] Cover uninstall and repeated uninstall. Assert managed state is removed, user-owned sentinels
      remain, and package removal deletes app files without deleting retained user resources.
- [ ] Add a path containing spaces, existing user configuration, and missing symlink permission
      cases. Check the documented failure/recovery behavior rather than skipping these cases.
- [ ] Wire lifecycle scenarios into the shared Windows behavior job and its bounded failure
      artifacts/ledger. Preserve the existing fast static check for parser/provider drift.
- [ ] Update platform coverage only after the real Windows scenarios pass; record remaining gaps.

## Validation

Proposed Windows command after implementation:

```powershell
pwsh -File scripts/test/windows-lifecycle-check.ps1
```

Run the existing static check as well:

```powershell
pwsh -File scripts/test/windows-installer-check.ps1
```

Acceptance requires both checkout and package scenarios passing on Windows, including update,
uninstall, idempotence, ownership, paths with spaces, expected prerequisite failure, and cleanup
after failure. No prerequisite or lifecycle scenario may silently skip in the required CI job.
Run `npm run check` on the existing macOS/Linux matrix after shared lifecycle changes; a local
PowerShell parser pass alone does not satisfy this plan.

## Risks

| Risk | Mitigation |
| --- | --- |
| A process resolves the real runner profile despite environment overrides. | Prove sentinel isolation first; use a disposable account/VM when redirection cannot contain writes. |
| Runner symlink privileges hide normal-user failures. | Exercise both a supported setup and an explicit missing-permission case. |
| Bash and PowerShell disagree on paths or quoting. | Run public entry points against roots with spaces and inspect resulting paths. |
| Tests drift into a second installer implementation. | Assert observable files and command results; keep setup limited to synthetic prerequisites. |

## Open questions

The initial inventory must establish whether package-mode dispatch runs unchanged under Git Bash
on Windows and whether all profile reads can be isolated. Failures discovered there determine the
implementation effort; the current estimate is 1–3 days for initial coverage and fixes, not a
commitment to resolve every platform discrepancy within that time.

## Shared environment contract

[[l1mz96d9]] owns runner provisioning, isolation, prerequisites, compatibility results, and artifact
uploads. This plan supplies lifecycle scenario modules and their outcome rows to that shared job.
Its initial command/isolation characterization can inform the environment contract; do not create
a competing runner framework. [[windows-provider-path-schema]] owns verified path-resolution
changes, not the lifecycle assertions that discover them.
