---
id: qk4mz7t2
priority: high
next_action:
blocked_by: []
depends_on: []
related:
  - ia1q1z9
  - 46up8y7a
  - 3jp3yhtq
  - l1mz96d9
reviewed_commit: 6072b52
worktree:
---

# Prove Clean-Machine Install Behavior

## Summary

A redirected `HOME` is useful, but it is not a clean machine. It still inherits the host's real
`PATH`, harness binaries, Docker state, and package-manager behavior. The clean-machine sandbox
turns install verification into a repeatable test: pack the current repository, install that tarball
in a container, initialize RoboRepo with no harnesses present, run `doctor`, run managed uninstall,
then remove the npm package and prove the `roborepo` binary is gone.

This plan grew out of [[agent-config-repo-scoped-write-permissions]] (now completed). That work added
home-relative credential denies, and `test:package-install` caught a deterministic package-mode
drift before any browser or live harness test did. The Docker sandboxes are the next layer: they
exercise the same package artifact under a cleaner `HOME` and `PATH`, with a colliding npm prefix
case.

## Completion Summary

Four Docker suites now prove install behavior on a clean machine: the container install matrix,
the narrow install sandbox, the permissions sandbox, and the onboarding sandbox. Each installs the
packed tarball in a fresh container with no harness on `PATH`. CI runs all four on the Ubuntu leg
through `npm run check`, and that leg now fails rather than skips when Docker is missing.

Adding hook-behavior checks to the permissions sandbox found two bugs that affected every npm
install, and both are fixed:

- Claude's repository-boundary hook could not find the platform manifest, so it never asked
  before a write into another repository.
- Codex's hook scripts were never installed, so `~/.codex/hooks.json` pointed at missing files.

The work landed on `main` in `be7e441` and `066fd0b`. Windows installer verification of the
restored Codex hooks row moved to [[l1mz96d9]].

## Goals

- Prove a packed tarball installs and initializes on a machine with no harness binaries on `PATH`.
- Prove package-mode `doctor` passes in that clean-machine shape.
- Prove managed uninstall preserves the workspace and leaves npm-owned application removal to npm.
- Prove npm uninstall removes the `roborepo` binary, including when npm's prefix collides with
  `~/.local`.
- Run the clean-machine checks in CI.
- Leave local development usable when Docker is unavailable.

## Non-goals

- Browser or portal UI verification.
- Real macOS hardware replacement. The sandbox complements the existing macOS CI leg; it does not
  claim every platform-specific installer behavior is covered.
- Changing current uninstall ownership. The current CLI explicitly removes managed configuration
  and tells the user to remove the application with `npm uninstall -g codethings-roborepo-alpha`.

## Current State

Four Docker suites now exist. Each packs the current repository once and runs fresh
`node:22-bookworm-slim` containers with `--network=none`:

| Suite | Script | Owns |
| --- | --- | --- |
| `test:clean-machine` | `scripts/test/clean-machine-container-check.mjs` | End-to-end install matrix: default prefix with zero harnesses, colliding `~/.local` prefix, and harness-count stages 1 through N with `harness detected` / `harness list` presentation asserts |
| `test:clean-machine-install-sandbox` | `scripts/test/clean-machine-install-sandbox.mjs` | Narrow install/init/doctor/uninstall/npm-uninstall cycle, standard and colliding prefix |
| `test:clean-machine-permissions-sandbox` | `scripts/test/clean-machine-permissions-sandbox.mjs` | Fake-harness permission projection for Claude, Codex, and Gemini |
| `test:clean-machine-onboarding-sandbox` | `scripts/test/clean-machine-onboarding-sandbox.mjs` | First-run and init-lifecycle machine states, including harness homes without a root config |

`scripts/test/lib/docker-sandbox.mjs` owns the shared Docker mechanics: strict/local skip behavior,
base image selection, `/tmp` artifact root, pack-once setup, `docker run --network=none`, timeout,
and failure reporting. `docs/internal/docker-test-sandboxes.md` records the ownership split above
and the rule to add assertions inside an existing installed container before adding another full
install loop.

Strict mode is `CLEAN_MACHINE_STRICT=1`; the artifact root override is `CLEAN_MACHINE_TMPDIR`. A
local run without Docker prints a skip line and exits 0.

The workflow has no dedicated clean-machine step. Both CI legs run `npm run check`
(`scripts/test/ci.sh`), which runs all four suites with `CLEAN_MACHINE_STRICT=1` when `docker info`
succeeds. When Docker is unavailable it fails on a Linux CI runner, because that leg is the only
place the suites run in CI. Everywhere else (macOS CI and local runs) it prints
`skip: clean-machine container suite (docker unavailable)`.

Earlier local runs against Docker Desktop caught two issues, both fixed:

- Docker Desktop can hang before container creation when a bind mount points at macOS'
  per-user `/var/folders/...` temp directory. Pack artifacts now go under `/tmp` by default.
- `roborepo uninstall --yes` reported the npm-owned `~/.local/bin/roborepo` symlink as a managed
  remnant when the npm prefix collided with clean `HOME/.local`. The remnant check now exempts the
  package-managed binary.

The permissions sandbox asserts the projection rules from `docs/internal/docker-test-sandboxes.md`:

- Claude's settings contain the home-relative `Read(~/.ssh/**)` deny, the `Read|Write|Edit`
  matcher, and `repo-write-scope.mjs` hook wiring.
- Codex uses `managed-workspace` profile roots instead of legacy `sandbox_mode`.
- Gemini names the write tools in exactly one rule, the `write-files` gate. Gemini's Policy Engine
  has no path predicate, so the gate's whole-tool allow is the documented degradation, and the
  renderer deliberately skips `repo-scope`. The assertion keeps `write-scope` and `repo-scope` from
  adding further write allows.
- No projected file contains the expanded sandbox `HOME` or a `~/projects/**` scope.
- The `repo-write-scope` hook, run through the command string Claude's settings wire, allows a
  write inside the current repository and asks for a write or read in a sibling repository.

Writing the sibling-repository cases exposed a product gap, now fixed. In a package install, the
hook deferred instead of asking. It learns the outside-repository bucket from
`manifests/inventory/agent-permissions.json`, and none of its three lookups resolved in package mode:

- `REPO_ROOT` was unset.
- `install-state.json` did not exist, because only the development installer writes it. The hook
  also read it from `ROBOREPO_STATE_DIR` or `~/.roborepo` and ignored `ROBOREPO_STATE_ROOT`.
- The hook is a copy at `~/.claude/hooks/provider/`, so walking back from its own location never
  reached the package. The manifest ships at `<prefix>/lib/node_modules/codethings-roborepo-alpha/`.

The fix records the app root in `<stateRoot>/app-root.json`:

- `recordAppRoot()` in `scripts/cli/state-paths.mjs` writes it. First-run bootstrap
  (`ensureInitialized`, shared by `init` and `web`) and `renderPermissionsToHome` call it.
  `renderPermissionsToHome` is the live render path that installs the hook, used by both
  `config permissions` and `update`.
- `repo-write-scope.mjs` and `codex/permission-check.mjs` read that record after `REPO_ROOT` and
  before `install-state.json`. They resolve the state root as `ROBOREPO_STATE_ROOT`, then
  `ROBOREPO_STATE_DIR`, then `~/.roborepo`, matching `scripts/cli/roots.mjs`.
- The Codex hook's command-overrides path now follows that state root instead of a hardcoded
  `~/.roborepo`.
- Managed uninstall removes `app-root.json`, and its remnant check lists the file.
- The record holds the concrete npm install directory, which moves when npm reinstalls under a
  different Node version. Every `roborepo` run (`scripts/cli/main.mjs`) rewrites an existing record
  whose path is stale. It never creates one, so a command run after uninstall cannot bring the file
  back. A stale record only makes the hooks defer, as they did before this fix.
- `test:package-install` forbids the install directory in generated files. Its exemption now
  covers both state-root pointer files, `install-state.json` and `app-root.json`, and the reason
  for each is recorded in `scripts/test/package-install-smoke/coupling-scan.mjs`.

The Codex hook failed differently: with no manifest it asks on every shell command. A second gap
hid that one. When `globals/codex/hooks` moved to `globals/system/hooks/codex`, the
`codex managed_copy ... hooks` row was dropped from `manifests/platform/manifest.tsv`, and the
`hooks` preset bundle only ever listed `codex:hooks.json`. So `~/.codex/hooks.json` pointed at
`permission-check.mjs` and `minimize-bash-output.mjs`, but no install path copied them. The fixes:

- Restore the row as `codex managed_copy globals/system/hooks/codex hooks`.
- Add `codex:hooks` to the `hooks` bundle.
- Make preset apply record the app root, so any bundle that installs these hooks also installs the
  record they read.

The permissions sandbox now applies the `hooks` preset and runs the Codex hook through its wired
`hooks.json` command. `git push --force` returns `deny`, and an unclassified command returns no
decision. Without the restored row, that step fails with `Cannot find module
'/tmp/rr-permissions-home/.codex/hooks/permission-check.mjs'`.

[[3jp3yhtq]] (`codex/harness-desktop-runtime-discovery`, unmerged) changes this area in two ways:

- It adds a sixth `confidence` column to `harness detected`, and its copy of
  `clean-machine-container-check.mjs` asserts `confirmed` / `probable` per stage. When it merges,
  the container matrix depends on that column.
- On macOS it counts a validated Claude or Codex desktop app runtime as the harness executable. On
  a real Mac, "no harness binary on `PATH`" will no longer mean "no harness present". The Linux
  containers have no desktop apps, so the sandboxes are unaffected. Any manual clean-Mac pass has
  to account for installed desktop apps.

## Implementation Plan

- [x] Add a packed-tarball clean-machine sandbox runner.
- [x] Add the standard-prefix install/init/doctor/uninstall/npm-uninstall case.
- [x] Add the colliding-prefix case under clean `HOME/.local`.
- [x] Make the runner skip locally when Docker is unavailable.
- [x] Register `test:clean-machine-install-sandbox` in `package.json`.
- [x] Wire the runner into CI. All four suites now run strict through `npm run check` on the Ubuntu
      leg.
- [x] Extract reusable Docker sandbox helpers for pack-once/run-container setup.
- [x] Add a permissions sandbox with fake harnesses and direct config assertions.
- [x] Observe strict runs and fix container-only assumptions. The Ubuntu CI leg is green on `main`
      with the suites in its gate, and all four pass locally in strict mode at `77fb095`.
- [x] Add harness-count stubs for stages 0 through N. These live in
      `clean-machine-container-check.mjs`, not the permissions sandbox. Stage 0 is the
      default-prefix zero-harness case, and stages 1 through N assert `harness detected` presence.
- [x] Add hook-payload assertions to the permissions sandbox: an in-repository write (allow), and a
      sibling-repository write and read (ask), run through the wired settings command.
- [x] Assert that Gemini names the write tools only in the `write-files` gate rule.
- [x] When CI runs on Linux, make `scripts/test/ci.sh` fail instead of skipping if Docker is
      unavailable. The macOS CI and local skips stay.
- [x] Decide whether `roborepo workspace import` needs a packaged clean-machine case. It does not;
      see the Decision Log.
- [x] Make installed permission hooks find the platform manifest and state root in package mode
      through a recorded `<stateRoot>/app-root.json`. Both the Claude and Codex hooks read it.

## Decision Log

- `roborepo workspace import` gets no packaged clean-machine case. Its logic depends on neither
  `PATH` nor the npm prefix, `scripts/test/test-cli.sh` covers it in-process, and
  `test:package-install` already exercises the tarball contents. Confirmed by the user.
- Installed hooks find the platform manifest through a CLI-recorded `app-root.json` in the state
  root. Two alternatives were rejected: writing the app root into `install-state.json`, which would
  change `isInstalledCore` and uninstall's `recorded_repo` handling, and copying the manifest into
  state, which can go stale between applies. Chosen by the user.
- `app-root.json` gets a narrow exemption from the "no install directory in generated files" rule
  and heals on every CLI run. The rejected alternative was resolving `roborepo` through `PATH` at
  hook time. Desktop apps launched from the Dock run hooks with a minimal `PATH` that often lacks
  npm's bin, so the hooks would still defer there. Chosen by the user.
- The Gemini assertion pins "write tools appear only in the `write-files` gate". The earlier
  wording "no unscoped write allow" was wrong: Gemini's gate is a whole-tool allow by documented
  degradation, because the Policy Engine cannot express a path.

## Validation

Regression evidence for the hook fixes:

- The permissions sandbox now passes every projection and hook assertion, and its uninstall removes
  `app-root.json` without leaving remnants. Before the fix it failed with
  `FAIL: repo-write-scope write into a sibling repository: got defer, expected ask`.
- `repo-write-scope-check.mjs` adds a copied-hook case. With no record the copy defers, and with a
  recorded app root it asks. Removing the hook's app-root lookup makes that case fail, so the test
  catches the regression.
- `test-cli.sh` checks that any command heals a stale `app-root.json` and that an ordinary command
  never creates a missing one. Removing the refresh call from `main.mjs` leaves a stale record
  unhealed.
- `test-cli.sh` adds the same check for the Codex hook: a copy with only `app-root.json` under
  `ROBOREPO_STATE_ROOT` denies `git push --force`.
- The Linux-CI Docker gate in `scripts/test/ci.sh` was exercised by running its block with `docker`
  and `uname` stubbed: `CI=true` on Linux exits 1, while `CI=true` on Darwin and an unset `CI` on
  Linux skip with exit 0.

Before these changes, all four suites passed locally in strict mode at `77fb095` with Docker
29.6.2:

| Suite (`CLEAN_MACHINE_STRICT=1`) | Result |
| --- | --- |
| `test:clean-machine` | pass, stages 0 through N |
| `test:clean-machine-install-sandbox` | pass |
| `test:clean-machine-permissions-sandbox` | pass |
| `test:clean-machine-onboarding-sandbox` | pass, 12 cases |

CI: the `check (ubuntu-latest)` job passed on `main` at `4871539` and `77fb095`. That job runs
`npm run check`, which includes all four suites when Docker is present.

## Not tested

- [x] Open a recent `check (ubuntu-latest)` job log and confirm it prints the four suites' pass
      lines, not `skip: clean-machine container suite (docker unavailable)`. The user pasted the
      job log: it shows the container check, install sandbox, and onboarding sandbox pass lines and
      no skip line. The permissions sandbox's line was outside the excerpt, but `scripts/test/ci.sh`
      runs under `set -e` with permissions before onboarding, so onboarding running means
      permissions passed.

## Verification

`npm run check` passed (`CI checks passed`) on `main` at `6072b52`, which contains both commits
from this plan:

| Gate step | Result |
| --- | --- |
| `scripts/doctor.sh` | pass |
| `scripts/test/test-cli.sh` | 434 passed, 0 failed |
| `scripts/test/test-install-collisions.sh` | pass |
| `test:unit -- --group ci` | 13/13 suites passed |
| `test:package-install` | pass |
| `test:clean-machine`, strict | pass |
| `test:clean-machine-install-sandbox`, strict | pass |
| `test:clean-machine-permissions-sandbox`, strict | pass |
| `test:clean-machine-onboarding-sandbox`, strict | pass |
| `test:portal-ui` | pass |
| Windows installer parity | skipped: `pwsh` unavailable |

Checked against the code at close:

- `package.json` registers all four `test:clean-machine*` scripts, and `scripts/test/ci.sh` runs
  them strict, failing on a Linux CI runner without Docker.
- `manifests/platform/manifest.tsv` has the `codex managed_copy globals/system/hooks/codex hooks`
  row, and the `hooks` bundle in `manifests/platform/presets.json` lists `codex:hooks`.
- `recordAppRoot()` is called from first-run bootstrap, `renderPermissionsToHome`, and preset
  apply. `refreshAppRootRecord()` runs on every CLI invocation.
- Both hooks read `app-root.json`. Uninstall removes it and lists it in the remnant check, and the
  package-install coupling scan exempts it.
- The permissions sandbox asserts Claude allow and ask decisions, Codex deny and defer decisions,
  and the single Gemini write rule.

CI evidence: the user-supplied `check (ubuntu-latest)` log shows the clean-machine suites running,
with no Docker skip line.

Not verified:

- **CI on the new commits.** `be7e441` and `066fd0b` were not pushed at close, so CI has not run
  them. The local gate above covers the same suites.
- **Windows installer parity.** `pwsh` is not installed on the closing machine. Ownership moved to
  [[l1mz96d9]].
- **`test-cli.sh` portal-adoption flake.** The portal-adoption checks in `test-cli.sh` failed in 2
  of about 10 local runs during this work and passed in every later run, including the gate above.
  The cause was not found, and nothing shows whether the flake predates this plan. It is outside
  this plan's scope; the portal UI is a non-goal.
