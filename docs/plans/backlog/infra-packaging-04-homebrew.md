---
id: qjsbhel5
priority: low
next_action: Agree an immutable release archive/checksum contract with the existing npm release tooling, then verify external tap state before designing the formula.
blocked_by: []
depends_on: ["1rajbd5o"]
related: ["c7b7swuh", "46up8y7a"]
reviewed_commit: 57f8f2199b6db87d829af8d41e387800518024c9
---

# RoboRepo Packaging 04: Distribute Through Homebrew

## Scope ownership

This plan exclusively owns Homebrew distribution: the tap, formula, release archive and checksum,
Cellar/libexec layout, brew upgrade/uninstall behavior, formula validation, and Homebrew
documentation.

It does not own npm publication, shared install lifecycle behavior, or the local new-Mac tarball.
The formula installs application files and exposes the executable; RoboRepo's shared lifecycle
commands initialize or materialize user configuration after installation.

## Summary

Create a Homebrew tap and formula that install a versioned RoboRepo release on macOS without cloning
the repository and without mutating user configuration during `brew install`. The formula should
consume a reviewed release archive and checksum, install the Node application into a stable
Homebrew-managed layout, expose `roborepo`, and preserve workspace and state across brew upgrade and
uninstall.

## Context

RoboRepo's application/workspace/state split is compatible with Homebrew: the Cellar owns immutable
application files while `~/.roborepo` remains user-owned. No formula or tap currently exists. The
release artifact shape, Node dependency strategy, formula test, and interaction between brew
uninstall and RoboRepo-owned configuration still need to be defined.

Homebrew should not become a second implementation of setup or uninstall semantics. It should use
the lifecycle contract from `infra-packaging-02-install-lifecycle` and a stable release artifact from
the npm/release work.

## Goals

- Publish a tap and versioned formula for supported macOS systems.
- Install from a release archive with a verified SHA-256 checksum.
- Depend on a supported Node runtime without relying on the developer's nvm shell initialization.
- Keep runtime application files under Homebrew ownership.
- Expose one stable `roborepo` executable through Homebrew's normal linking behavior.
- Keep `brew install` noninteractive and free of writes to `~/.claude`, `~/.codex`, other harness
  homes, shell profiles, workspace, or state.
- Preserve workspace and state across `brew upgrade` and `brew uninstall`.
- Provide a meaningful `test do` block using a temporary home.
- Resolve Homebrew paths dynamically and never hardcode `/opt/homebrew` or `/usr/local`.
- Run the shared package-mode integration suite against the formula installation, not only a version check.
- Document install, setup, upgrade, uninstall, and troubleshooting.

## Non-goals

- Publishing npm packages.
- Reimplementing setup/apply/repair/uninstall logic in Ruby formula code.
- Deleting user workspace or machine state during `brew uninstall`.
- Supporting Linuxbrew unless explicitly validated in a later extension.
- Bundling Node into the RoboRepo release archive.

## Current state

- There is no `Formula/*.rb` file or RoboRepo tap.
- The application is a zero-runtime-dependency Node/ESM package with Node `>=20`.
- The CLI already has a `bin/roborepo` entry point.
- Package mode treats the application root as immutable and stores workspace/state separately.
- Local npm publication tooling exists; controlled CI/provenance and exact registry-artifact acceptance remain tracked by [[1rajbd5o]].

## Proposed design

### Release artifact

Use a tagged GitHub release archive or purpose-built source tarball whose contents match the reviewed
runtime allowlist. The formula records the archive URL and SHA-256. The artifact must be reproducible
enough that release automation can calculate and verify the checksum before updating the tap.

### Installation layout

```text
Homebrew Cellar keg
  libexec/        RoboRepo application files
  bin/roborepo    wrapper or symlink invoking libexec/bin/roborepo

User-owned
  ~/.roborepo/    workspace and state
  harness homes   generated configuration after explicit `roborepo setup/apply`
```

Use `libexec` when needed to preserve the package's internal directory layout and avoid exposing all
application files through Homebrew's global prefix. The executable must resolve `appRoot` from its
installed location rather than a source path.

### Install and setup separation

`brew install` performs only package-manager responsibilities:

- fetch and verify the release archive;
- install application files and Node dependency linkage;
- expose the executable;
- print concise caveats directing the user to `roborepo setup` and `roborepo doctor`.

It must not initialize or mutate user configuration during formula installation.

### Upgrade and uninstall

- `brew upgrade` replaces the keg and leaves `~/.roborepo` untouched.
- The first subsequent `roborepo apply` uses the shared lifecycle compatibility checks.
- `brew uninstall` removes only the keg and linked executable.
- Removing RoboRepo-generated harness configuration or machine state remains an explicit RoboRepo
  lifecycle action, not a formula uninstall hook.

## Implementation plan

### Phase 1 — Artifact and tap design

- [ ] Choose the tap repository and formula path.
- [ ] Choose the release archive produced by the release workflow.
- [ ] Verify the archive contains only required runtime files.
- [ ] Decide whether the formula installs directly or under `libexec`.
- [ ] Confirm the supported macOS architectures and minimum versions.
- [ ] Verify every formula and wrapper path derives from Homebrew-provided prefixes rather than hardcoded `/opt/homebrew` or `/usr/local` values.

### Phase 2 — Formula implementation

- [ ] Add the formula with URL, version, checksum, license, and Node dependency.
- [ ] Install the application into the chosen keg layout.
- [ ] Expose `roborepo` through Homebrew's standard binary linking.
- [ ] Add caveats for `roborepo setup`, `roborepo doctor`, and workspace preservation.
- [ ] Avoid `post_install` writes to user configuration unless a future plan proves they are both
      necessary and Homebrew-compliant.

### Phase 3 — Formula tests

- [ ] Add `test do` coverage for `roborepo version` in package mode.
- [ ] Run the shared package-mode install/setup/workspace/apply/doctor integration suite against the installed formula artifact.
- [ ] Use temporary HOME/workspace/state roots for any setup or doctor assertion.
- [ ] Confirm the test does not read a developer checkout or real harness homes.
- [ ] Test on supported Apple Silicon and Intel runners where available.
- [ ] Run `brew audit --strict` and the relevant style checks.

### Phase 4 — Upgrade and uninstall verification

- [ ] Install one fixture/released version, initialize temporary user state, then upgrade to the next.
- [ ] Confirm workspace/state remain outside both old and new kegs.
- [ ] Confirm application-root links do not point at the previous keg after upgrade.
- [ ] Confirm `brew uninstall` leaves user-owned data untouched.
- [ ] Verify shared RoboRepo repair/uninstall commands still operate after a brew-managed install.

### Phase 5 — Release automation and documentation

- [ ] Automate formula version/checksum updates from an approved stable release.
- [ ] Require review before merging tap updates.
- [ ] Document tap installation, upgrades, uninstall, setup, doctor, and command-path diagnostics.
- [ ] Explain coexistence and precedence when npm and Homebrew installations are both present.

## Validation

- `brew install` succeeds on a clean supported macOS environment without cloning RoboRepo.
- `command -v roborepo` resolves to the Homebrew-linked executable.
- `roborepo version` reports package mode and an application root inside the active keg.
- The shared package-mode integration suite passes against the formula-installed application.
- Formula and wrapper logic pass on both common Homebrew prefixes without literal prefix assumptions.
- The formula test runs with an isolated home and no installed harness requirement.
- `brew upgrade` replaces the application while preserving workspace/state.
- `brew uninstall` removes the application but not personal RoboRepo data.
- `brew audit --strict` and formula tests pass.
- No install or uninstall hook mutates user harness configuration implicitly.

## Risks

- nvm-managed Node is not available to noninteractive Homebrew formula execution; the formula must
  use Homebrew's declared Node dependency.
- A generic GitHub source archive may include development-only files that npm's allowlist excludes.
- Simultaneous npm and Homebrew installs can make shell resolution ambiguous.
- Homebrew policy may reject side effects or layout choices that seem convenient locally.
- Formula auto-update automation can publish a checksum for an unverified or mutable artifact.

## Decisions

- Homebrew installation is application-only; user setup remains an explicit RoboRepo command.
- User workspace and state are never owned by the keg.
- The formula consumes a stable, versioned, checksummed release artifact.
- npm and Homebrew remain separate channels over the same application/lifecycle architecture.

## Release prerequisite

The shared lifecycle implementation [[46up8y7a]] is complete. Agree a reviewed immutable release
archive, checksum, and version/source evidence with [[1rajbd5o]] before formula implementation.
No formula is tracked in this checkout; external tap availability was not checked during the
backlog sync. Verify ownership/current state before creating or publishing any external tap.
