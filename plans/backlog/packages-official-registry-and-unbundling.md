---
id: f5exs0bd
next_action: Wait for Part 04 (jdsobwn) to land its source model and install store, then choose the official registry hosting and promote this plan with /plan-promote.
blocked_by: []
depends_on: ["jdsobwn"]
related: ["user-managed-packages-and-add-workflows", "74h2tlim"]
reviewed_commit: 46f37fbc51d551f49999d757a328694c176555b8
worktree:
---

# Package Management: Part 06 - Download Official Packages on Demand

## Summary

RoboRepo's npm package carries every optional package it offers, because `package.json` publishes
`globals/`. [[jdsobwn]] introduces package sources, provenance, and a managed install store while
leaving that distribution unchanged. This plan finishes the separation: RoboRepo's own packages move
to an official `registry` source, download when first enabled, and leave the npm artifact; and
`roborepo uninstall` learns which package state RoboRepo owns, so cleanup never touches user-owned
package folders.

It reuses [[jdsobwn]]'s product model (sources, provenance, collision rules, System/Custom/Third
Party tabs) and does not restate it.

## Context

What [[jdsobwn]] leaves in place when it lands:

- Packages are discovered through source adapters: a temporary `bundled` adapter over
  `globals/packages`, a `path` adapter over the workspace, and a `git` adapter for public GitHub repos.
- Selection and installation records carry source-qualified references and a provenance lock.
- A managed install store under `stateRoot` holds materialized remote packages.
- The trusted catalog ships as a data file inside the application.

What is true today and stays true until this plan:

- `package.json` lists `globals/` in `files`, so `npm pack` includes the full package library.
- `roborepo uninstall` (`scripts/cli/uninstall.mjs`) accepts `--dry-run`, `--yes`, and
  `--delete-workspace`. It removes RoboRepo-managed configuration and, in package mode, the npm package,
  preserves the workspace unless `--delete-workspace` is given and the workspace sits inside
  `stateRoot`, and has a portal preview that is preserve-only. It knows nothing about package sources.

## Goals

- RoboRepo's optional packages are available from an official `registry` source.
- The npm artifact carries the platform and only the packages it needs to boot or repair itself.
- A System package that has never been enabled downloads on first enable; offline, that enable fails
  clearly instead of half-installing.
- Package releases and platform releases have independent cadences.
- Remote installs are deterministic and integrity-checked; a failed fetch never damages prior state.
- `roborepo uninstall` previews and removes exactly what RoboRepo owns and reports what it preserved.

## Non-Goals

- Anything [[jdsobwn]] owns: the source contract, provenance, collision rules, the `git` source, and
  the service and CLI source surfaces.
- Signatures on registry artifacts in v1 (see Open Decisions).
- Dependency solving in the npm style.

## Proposed Design

### First Install After Unbundling

A new RoboRepo installation should install the platform and only the minimal assets required to start package management.

The initial experience should be:

1. Install RoboRepo through npm.
2. RoboRepo initializes machine-local state.
3. The official package source is configured by default.
4. RoboRepo refreshes or reads the official source catalog.
5. The user chooses packages or a preset.
6. Only selected remote package artifacts are downloaded.
7. Selected packages are activated through the existing harness application flow.

If a minimal bootstrap package is genuinely required for RoboRepo to function, it may remain bundled. "Convenient to have by default" is not sufficient reason to keep an optional package in the application artifact.

### Official Registry v1

A reasonable v1 is:

```text
separate package-library repository or release store
  |
  +--> versioned index document
  |
  +--> immutable package artifacts
```

The index only needs enough information for discovery and immutable resolution:

```json
{
  "schemaVersion": 1,
  "packages": [
    {
      "id": "code-style",
      "name": "Code Style",
      "latest": "1.4.0",
      "versions": {
        "1.4.0": {
          "artifact": "...",
          "integrity": "sha256-..."
        }
      }
    }
  ]
}
```

Do not make GitHub-specific API responses the domain contract. A GitHub repository/releases can host v1, while the `registry` adapter consumes a RoboRepo-owned index schema. This leaves room to move hosting later without changing package consumers.

### `registry` Source Type

Purpose:

- official RoboRepo catalog;
- organization/community catalogs using the same protocol.

Characteristics:

- remote index;
- immutable version/revision resolution;
- managed local cache/install copy;
- integrity required;
- supports refresh and offline cache.

### Platform Distribution

#### Target npm Artifact

Today `package.json` includes `globals/` in the published `files` list. After remote official packages are proven, optional package-library content should no longer be part of the platform artifact.

The target npm package contains:

- CLI/runtime code;
- portal/runtime assets;
- harness and package schemas;
- migration/bootstrap logic;
- default source metadata required to find the official registry;
- only package assets that are strictly required for RoboRepo itself to boot or repair its package manager.

It does not contain the entire optional package library.

#### Bootstrap Exception

If RoboRepo needs a small internal package to operate its own development harness or self-management, classify it explicitly as one of:

1. application runtime asset;
2. bootstrap package;
3. optional catalog package.

Do not leave an item bundled merely because it was historically under `globals/packages`.

This classification should happen before removing `globals/` from the npm package manifest.

#### Independent Release Cadence

Separating distribution allows:

- platform releases without republishing unchanged optional packages;
- official package releases without republishing the CLI;
- third-party source releases on their own cadence;
- users to update one installed package without replacing RoboRepo itself.

The first implementation does not need sophisticated compatibility solving. It does need package metadata capable of declaring any minimum RoboRepo/package-schema compatibility that is already necessary to prevent an obviously incompatible package from activating.

### Uninstall and Reset Ownership

`roborepo uninstall` already exists and, in package mode, removes the npm package after its own cleanup. This
plan extends it; it does not replace it or ask users to run `npm uninstall -g` separately. The
existing `--dry-run`, `--yes`, and `--delete-workspace` flags keep their meaning, and the portal
preview stays preserve-only.

What changes is the set of things the command knows about. Once packages come from several sources
it must tell apart:

- RoboRepo-managed state: source configuration, catalog caches, installed artifacts, the lock;
- downloaded System artifacts, which cleanup may delete because they can be downloaded again;
- user-owned `path` sources, including the workspace and any folder outside `stateRoot`, which it
  never deletes.

Proposed scopes, offered interactively and as flags (names settle during implementation):

| Scope | Removes | Preserves |
| --- | --- | --- |
| Reset state | Selection, applied, and source records | Installed downloads, all user paths |
| Remove state and downloads | The above plus catalog caches and installed artifacts | All user paths |
| Remove everything RoboRepo owns | Every record marked RoboRepo-owned, then the npm package | All user paths |

Each choice shows the paths it will delete, the paths it preserves, the configured user path
sources, and the active packages that stop being managed. `--dry-run` works with every scope.

The flag path never prompts when a scope flag is given, can emit machine-readable output, and uses
the same ownership inventory as the interactive path.

#### Workspace Safety

Never recursively delete `workspaceRoot` or another configured path source merely because RoboRepo has a pointer to it.

A path can be deleted only when:

- RoboRepo itself created the exact managed directory;
- ownership metadata marks it as RoboRepo-managed;
- the selected cleanup scope includes it.

User-authored workspace/path sources should be preserved and reported after cleanup.

Example:

```text
RoboRepo-managed state removed.

Preserved user-owned package sources:
  ~/projects/my-roborepo-packages
```

### Migrating Bundled Packages to the Official Source

Once official remote installation is stable:

1. publish the optional built-in packages to the official source;
2. resolve existing package selections to the official package identity;
3. verify equivalent package contents/versions;
4. update provenance records;
5. remove optional packages from the application distribution;
6. delete the temporary `bundled` adapter once no runtime path depends on it.

## Implementation Plan

### Stage 1 — Registry Source v1

- [ ] Define RoboRepo registry index schema v1.
- [ ] Implement the `registry` adapter: catalog fetch, schema validation, immutable resolution, and
      artifact download.
- [ ] Verify declared integrity before the install service sees the artifact; reject the same version
      with changed content.
- [ ] Cache the last valid catalog; stage downloads and promote them atomically.
- [ ] Handle timeouts, an unavailable registry, invalid JSON or schema, 404s, and integrity mismatch.
- [ ] Ensure activation makes no network request when the artifact is installed.
- [ ] Test with a fixture HTTP server or deterministic local transport: valid index and artifact,
      invalid index, unavailable registry, stale cache fallback, integrity mismatch, interrupted
      download, and offline activation.

### Stage 2 — Official Package Source

- [ ] Create the official package-library repository or storage and publish an index.
- [ ] Package the optional global packages as immutable versioned artifacts.
- [ ] Add the official source to default state, labeled official.
- [ ] Serve the trusted catalog from the registry so it updates without a platform release.
- [ ] Test installing representative packages from the official source, a fresh install with no
      prior catalog, and an update from one official version to the next.
- [ ] Verify metadata and harness compatibility match the bundled versions; document the
      publication workflow in `docs/internal/npm-release.md` or a sibling release doc.

### Stage 3 — Remove Optional Packages From the Platform Artifact

- [ ] Classify remaining `globals/` content as runtime asset, bootstrap package, or optional package.
- [ ] Remove optional package paths from `files` in `package.json`.
- [ ] Migrate selections from `builtin` to `official` provenance, then delete the `bundled` adapter.
- [ ] Make install and bootstrap initialize sources instead of assuming package files under `appRoot`.
- [ ] Add a packaging check that optional packages are absent from `npm run pack:dry-run`.
- [ ] Verify platform install completes offline, deferring package discovery until connectivity.
- [ ] Verify an update from the pre-separation package model keeps every selection.
- [ ] Extend `doctor` to check the catalog cache and installed-artifact integrity.

### Stage 4 — Ownership-Aware Uninstall

- [ ] Build an ownership inventory from state records.
- [ ] Add the cleanup scopes to `roborepo uninstall`, interactively and as flags, keeping existing flags.
- [ ] Preserve every user-owned path source and report preserved paths afterwards.
- [ ] Test with temporary roots only: dry-run mutates nothing; each scope deletes exactly its set;
      a path source outside `stateRoot` survives; a symlink or traversal cannot widen the delete
      set; an interrupted cleanup can be rerun safely; a scope flag runs without any prompt;
      machine-readable output parses; the interactive and flag paths report the same delete set.

Suggested focused checks, named to follow existing conventions: `package-registry-check.mjs`,
`package-distribution-check.mjs` (what the npm artifact contains), and `package-uninstall-check.mjs`,
registered in `scripts/test/check-groups.json`.

Checks for every stage:

```bash
node scripts/test/package-catalog-check.mjs
node scripts/test/package-lifecycle-check.mjs
npm run test:package-install
npm run pack:dry-run
npm test
```

## Acceptance Criteria

- [ ] The official package library is available through the `registry` source.
- [ ] Remote package versions resolve to immutable artifacts with integrity verification.
- [ ] Remote catalog refresh cannot corrupt the last valid cache.
- [ ] Optional official packages are no longer in the npm platform artifact.
- [ ] A never-enabled System package downloads on first enable, and fails clearly offline.
- [ ] A platform update does not overwrite `stateRoot` package installs or user-owned path sources.
- [ ] `roborepo uninstall --dry-run` reports exactly what a selected cleanup scope would delete.
- [ ] Every cleanup scope preserves user-owned workspace and path-source content.
- [ ] Scope flags run without prompts and report the same delete set as the interactive choice.
- [ ] The checks above and a fresh-install smoke test pass.

## Risks and Mitigations

| Risk | Consequence | Mitigation |
| --- | --- | --- |
| Registry compromise or corrupted artifact | Untrusted config/code reaches harness | HTTPS transport, immutable resolution, integrity verification, validation before activation |
| Platform update deletes packages | Loss of user state | Keep installs in `stateRoot`; treat `appRoot` as replaceable only |
| Purge deletes a custom workspace path | User data loss | Ownership inventory; user path sources preserved in every scope; dry-run |
| Hosting choice leaks into domain code | Later migration is expensive | RoboRepo-owned index schema; the adapter hides transport |
| Package releases outpace older clients | Broken installs | Minimum compatibility metadata in the index before independent releases are relied on |

## Decisions Made by This Plan

1. **The first remote source is a RoboRepo-owned registry protocol, even if GitHub hosts it.**
2. **Remote artifacts require integrity verification.**
3. **Optional packages leave the npm artifact only after the source and install abstraction works.**
4. **`roborepo uninstall` owns cleanup; nothing depends on npm uninstall hooks.**

## Decision Log

- **2026-11-22: Split out of [[jdsobwn]].** Decided by the user, so the local source model could
  ship first while the registry hosting choice stays open.

## Coordination

| Plan | Relationship | What it means here |
| --- | --- | --- |
| [[jdsobwn]] Get Packages From GitHub, Catalogs, and Local Folders | Unlanded dependency | Supplies sources, provenance, and the install store |
| [[74h2tlim]] Preserve User Data Across Installations and Macs | Backlog | Agree owned caches versus authored path sources and the cleanup scopes before either plan migrates storage |

## Open Decisions

### Official Registry Hosting

Recommended starting point: a separate GitHub repository plus immutable release artifacts or an equivalent static artifact host.

The requirement is that the `registry` adapter consumes RoboRepo's index schema rather than GitHub-specific domain objects.

### Package Artifact Format

Recommended starting point: a deterministic archive containing one existing RoboRepo package directory, preserving the current package manifest/content contract.

Choose the exact archive format based on current release tooling and reproducible hashing support.

### Version Selector Surface

Recommended starting point: exact versions for install/lock and a small convenience selector such as latest for user requests. Resolve convenience selectors immediately to an exact version before installation.

Do not implement npm-style semver dependency solving unless a future package-dependency feature requires it.

### Signature Verification

Recommended v1: integrity hash plus trusted HTTPS distribution for the official source, with schema fields reserved for future signatures if helpful.

Revisit signatures before treating arbitrary public third-party registries as equally trusted.


## Documentation impact

| Document | Change |
| --- | --- |
| `docs/architecture/config-code-separation.md` | Installed artifacts versus the application |
| `docs/user/reference/roborepo-cli.md` | Uninstall scopes; first-enable download |
| `docs/internal/npm-release.md` | Separate platform and official-package publication |
| The registry schema reference | New; the single source for the index schema |

## References

External behavior relevant to cleanup:

- npm documents that uninstall lifecycle scripts present in npm v6 are not implemented from npm v7 onward, so RoboRepo cannot rely on `npm uninstall` to invoke application-controlled cleanup: <https://docs.npmjs.com/cli/using-npm/scripts/>
- npm's uninstall command removes the package content npm installed on the package's behalf: <https://docs.npmjs.com/cli/uninstall/>
