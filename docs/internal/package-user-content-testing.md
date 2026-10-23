# Verify package and user-content behavior

## Purpose

Use the existing isolated tests to verify package, skill, and MCP changes before maintaining a
manual demonstration. The unfinished automation/recording work is tracked by plan
`package-cli-test-guide`; typed `roborepo add` flows are a separate proposal.

## Current commands and environment

Application source, editable workspace, and machine state are resolved by `scripts/cli/roots.mjs`.
Development and package modes share the default workspace under the state root. Use the disposable
fixtures described in [Test Scenarios](test-scenarios.md) for commands that mutate configuration;
changing `HOME` alone does not prove desktop-harness discovery is isolated.

| Behavior | Current command family | Verification owner |
| --- | --- | --- |
| Inspect roots | `roborepo version`, `roborepo workspace status` | Root/package smoke tests |
| Create skill source | `roborepo skill new` | Skill CLI fixtures; apply/inspect establish actual materialization |
| Add MCP intent | `roborepo mcp add` | MCP package lifecycle fixtures; native registration may require a provider |
| Enable/disable | `roborepo package enable`, `roborepo package disable` | Package lifecycle and live probes |
| Inspect/reconcile | `roborepo package inspect`, `roborepo package status`, `roborepo package reconcile` | Desired versus observed state tests |
| Portal | `roborepo web --no-open --port <port>` | Hermetic Playwright runner and public API/UI assertions |

## Steps

1. Select the fixture type from [Test Scenarios](test-scenarios.md); use fake supported harnesses and
   separate state/workspace/native homes. Assert host-discovery isolation before mutation.
2. Run the focused package or skill/MCP check for the surface being changed.
3. Run the existing portal suite or selected spec against the hermetic server.
4. Compare intended source/registry changes with observed harness artifacts and the portal state.
   Treat partial or external state as diagnostic evidence, not successful verified installation.
5. For a manual demonstration, reuse the same isolated boundary and verified command forms; record
   synthetic data only and stop the foreground portal afterward.

## Verification

```sh
node scripts/test/package-catalog-check.mjs
node scripts/test/package-lifecycle-check.mjs
node scripts/test/mcp-package-lifecycle-characterization-check.mjs
npm run test:portal-ui
```

See [Testing RoboRepo](testing.md) for broader gates and browser prerequisites. A joined CLI-to-UI
journey must use production persistence/API behavior; a mocked UI response or recording cannot
substitute for it. This runbook's commands were checked against tracked files; this documentation
sync did not run configuration mutations against real native harnesses.

## Failure handling

Keep source, desired registry state, and live harness state distinct when diagnosing a mismatch.
Preserve fixture logs and compare the failed layer before adding a retry. Missing native binaries
or Chromium are explicit unavailable prerequisites; use existing supported shims for deterministic
coverage rather than relying on the developer's real account or installed harness configuration.
