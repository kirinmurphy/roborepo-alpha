# Testing RoboRepo

## Purpose

This is the maintainer runbook for choosing and running RoboRepo tests. The repository has several
test layers because it manages three different things at once: source checkout behavior, packaged
npm behavior, and machine-local harness state.

Use the smallest layer that proves the change. Before publishing, run the full publish matrix.

Use [`test-scenarios.md`](test-scenarios.md) to choose the environment. Use this doc to choose the
test command/suite. For package and user-content journeys, see
[Verify package and user-content behavior](package-user-content-testing.md).

## Test Layers

| Layer | Command | Covers | Notes |
| --- | --- | --- | --- |
| Repo health | `bash scripts/doctor.sh --quiet` | generated-file drift, manifest data, links, script health | `roborepo doctor --installed` adds live installed-path checks. |
| Main smoke suite | `npm test` | fast repository behavior and simulated package mode | Alias for `scripts/test/test-cli.sh --quiet`. |
| Install/uninstall collisions | `bash scripts/test/test-install-collisions.sh` | conflict policy, managed-copy reclaim, uninstall cleanliness against real fixture homes | Not covered by `npm test`. The only layer that proves uninstall leaves no remnants. |
| Live install smoke | `npm run test:install-smoke` | whether *this machine's* install matches the repo: hook scripts byte-current and registered, package rules rendered, enabled ids real, skill links resolve | Read-only, and deliberately not in `npm test` or CI — there is no live install to inspect there. Run it after `roborepo update`. Complements `doctor --installed`, which does not check installed hook scripts at all. |
| Package artifact smoke | `npm run test:package-install` | real `npm pack`, isolated global install, package-mode lifecycle, appRoot immutability | Requires a clean worktree only when retaining an artifact with `--output-dir`. |
| Release preflight | `npm run publish:npm -- --dry-run` | npm auth, registry availability, release checks | Does not write a version or publish. |
| Targeted Node checks | `node scripts/test/<name>.mjs` | one behavior surface | Preferred while debugging a specific regression. |
| Hermetic rerun | `bash scripts/test/hermetic-suite.sh --quiet` | the main suite under a temp `HOME` and a PATH with no harness executables | Reproduces CI-runner conditions locally. A test that fails only here is reading ambient machine state. |
| Portal UI suite | `npm run test:portal-ui` (`node scripts/test/portal-ui/run.mjs <spec>` for one spec) | the portal in Chromium against one hermetic server shared by every spec | The server never sees the host's harnesses: `host-harness-isolation.mjs` shadows provider executables on `PATH` with failing stubs and points macOS desktop-app discovery at a missing root. Without that, a harness installed on the developer's machine is set up mid-suite and changes what later specs see. |
| Portal smoke | `roborepo web --no-open --port <port>` plus `curl`/browser checks | local portal routes and API snapshots | Start under direct control and stop with Ctrl-C. Do not use detached mode for test runs. |

## Required Cleanup Gate

Before pushing or closing any merge-from-main, generated-file, harness/provider, package/test, or
CI/workflow change, run:

```sh
bash scripts/doctor.sh --quiet
git diff --check
```

`doctor.sh` is the cross-harness repo-health gate. It derives provider and harness expectations from
the repo manifests and registry, then checks generated permissions/rules, command catalog shape,
orphaned tests, shell syntax, and related repository invariants. Do not substitute a narrower render
or targeted test check when the touched surface is harness/provider/test/CI plumbing.

## Publish Matrix

Before an npm publish decision, run these commands from a clean `main` checkout with Node 22 or
newer:

```sh
node -v
roborepo doctor --installed
npm run test:install-smoke
npm test
bash scripts/test/test-install-collisions.sh
npm run pack:dry-run
npm run test:package-install
npm run --silent test:publish-npm
bash -n scripts/release/publish-npm.sh
git diff --check
```

For high-risk integration reviews, also run the relevant direct tests instead of relying only on
`npm test`. The post-merge review before the beta package cut used this focused set:

```sh
node scripts/test/dry-run-purity-check.mjs
node scripts/test/managed-uninstall-check.mjs
node scripts/test/cli-surface-integration-check.mjs
node scripts/test/repo-write-scope-check.mjs
node scripts/test/permissions-render-live-characterization-check.mjs
node scripts/test/config-synthetic-provider-check.mjs
node scripts/test/harness-cohort-presentation-check.mjs
node scripts/test/config-source-harness-check.mjs
node scripts/test/retention-policy-check.mjs
node scripts/test/telemetry-store-bounds-check.mjs
node scripts/test/capture-dense-bash-check.mjs
node scripts/test/maintenance-stores-check.mjs
node scripts/test/package-catalog-check.mjs
node scripts/test/package-lifecycle-check.mjs
node scripts/test/package-default-enabled-check.mjs
node scripts/test/initialization-lifecycle-check.mjs
node scripts/test/package-catalog-harness-check.mjs
node scripts/test/package-harness-config-characterization-check.mjs
node scripts/test/harness-package-config-roundtrip-check.mjs
node scripts/test/root-config-merge-characterization-check.mjs
node scripts/test/root-config-state-check.mjs
node scripts/test/harness-hooks-write-remove-characterization-check.mjs
node scripts/test/harness-mcp-remove-characterization-check.mjs
node scripts/test/mcp-package-lifecycle-characterization-check.mjs
node scripts/test/repositories-check.mjs
node scripts/test/developer-runtime-check.mjs
node scripts/test/usage-domain-check.mjs
```

Do not run broad `npm run test:*` sweeps as one foreground command. They are harder to diagnose and
can exceed terminal timeouts. Run direct checks in small batches and record pass/fail lines.

## Portal Smoke

Use `roborepo web`, not `node scripts/cli/main.mjs web`, unless the test is specifically about the
composition root. The CLI command is the supported surface.

```sh
roborepo web --no-open --port 58473
curl -fsS http://127.0.0.1:58473/agents
curl -fsS http://127.0.0.1:58473/api/config
curl -fsS http://127.0.0.1:58473/api/maintenance/uninstall/preview
```

Stop the server with Ctrl-C after the smoke. The uninstall preview route is safe; it returns the
planned cleanup and `workspacePreserved`. Do not call `POST /api/maintenance/uninstall` during
publish verification.

When browser automation is available, use it for DOM-level checks: page load, console errors,
network failures, and the visible Uninstall panel. Without browser automation, `/agents`,
`/api/config`, and the uninstall preview are acceptable browser-equivalent smoke checks, but record
that no real browser was used.

## Adding A Test

Write the check, then wire it into a runner. `scripts/doctor.sh` fails when any file under
`scripts/test/` is invoked by neither `test-cli.sh`, an `npm run test:*` script that CI directly
calls, nor a CI job — because a test nothing runs asserts nothing, which is exactly how an uninstall
defect once survived a full review pass. A `package.json` script by itself is only a named entry
point; it must still be reached by CI or the main test runner.

When that check fails, add the file to a runner. Only if it is genuinely not a suite entry point —
a child process, a benchmark, a manual smoke that binds a port — add it to `EXEMPT` in
`scripts/test/orphan-test-check.mjs` along with the reason it is not automated.

## Sandbox Notes

Codex sandboxes can block checks that are valid on the host machine:

| Symptom | Action |
| --- | --- |
| `npm pack` reports it could not write `~/.npm/_logs` | Rerun `npm run test:package-install` once outside the sandbox. |
| localhost bind or fetch returns `EPERM` | Rerun the `roborepo web` or `curl` smoke outside the sandbox. |
| `roborepo harness refresh` cannot write `~/.roborepo/harnesses/state.json` | Rerun it outside the sandbox when validating real machine state. |

Do not work around these by changing test paths or using a different command surface. Record the
first sandbox failure and the escalated rerun result.

## Known Non-Publish Failures

These are tracked separately and should not be reported as new publish regressions without fresh
evidence:

| Check | Current classification |
| --- | --- |
| `node scripts/test/cli-surface-integration-check.mjs` | Load-sensitive flake in its `expect`-driven remote-sync PTY block, which uses fixed timeouts. Passes in isolation and fails under concurrent load, so rerun it alone before calling a failure a regression. Also surfaces through `npm test` as `lifecycle: CLI surface help/menu/removed routes work in sandbox`. |

Both previously listed entries are fixed and no longer expected to fail:

- `usage-statusline-check.mjs` asserted `Context: 70% used`. The renderer has emitted a bare
  percentage since the feature's first commit, and the implementation plan's own format table
  specifies `Context: 42% · 5h: — · Weekly: —`, so the assertion was wrong when written rather than
  drifting later. The test now matches the specified format.
- `agent-run-coverage-check.mjs` reported `roborepo init`, `library`, and `uninstall` unclassified.
  All three mutate state — `init` sets up the installation, `library` writes preset state through
  `markOnboarded()`, `uninstall` removes managed config — so all three are now in the
  `mutate-harness-config` (`ask`) behavior.

`node scripts/test/hook-composition-check.mjs` is part of the passing main suite and should not be
classified as a known failure.

`node scripts/test/usage-domain-check.mjs` covers the usage threshold/domain behavior and should
still pass when statusline text formatting is not the subject under review.

## Platform Coverage

CI runs the main suite on macOS and Linux, plus a Windows PowerShell parser/parity check for the
installer. A local macOS publish review does not prove Linux or Windows lifecycle behavior unless
those CI jobs or equivalent local environments are run.
