---
id: u8211thb
priority: medium
next_action: Design a hermetic portal-to-capture scenario using a simulated supported harness and the production telemetry capture path
blocked_by: []
depends_on: []
related:
  - nkhk6bb
reviewed_commit:
worktree:
---

# Verify the End-to-End Token Capture Path

## Summary

The portal onboarding work now covers the Tokens UI states and exercises harness refresh with a
temporary supported-provider shim. It does not yet prove the full path from harness detection and
enablement through a captured agent event to real data on the Tokens page. This plan adds that
coverage without requiring a developer to install or launch a real harness in automated tests.

## Goals

- Verify the portal can detect and enable a supported harness from an isolated home directory.
- Exercise the production telemetry capture path with a deterministic simulated session event.
- Confirm the Tokens page advances from missing prerequisites to captured report data after the
  simulated session.
- Keep automated coverage hermetic and independent of installed harnesses or network services.

## Current state

- `scripts/test/harness-refresh-simulation-check.mjs` uses a temporary CLI shim and home/config
  fixture to exercise harness refresh and explicit disable preservation through the portal route.
- `scripts/test/telemetry-correctness-check.mjs` validates analysis with event fixtures.
- `scripts/cli/telemetry-capture.mjs` is the production entry point for harness events, and the
  telemetry hooks call `roborepo telemetry capture` for session and tool events.
- The existing coverage does not join refresh, enablement, telemetry capture, and the Tokens report
  into one end-to-end scenario.

## Implementation plan

- Extend the portal test fixtures to model a supported provider in an isolated home and verify the
  visible detected/enabled state after **Check for harnesses**.
- Feed a deterministic session/tool event through the production capture entry point, using the
  test harness's isolated state and spool paths.
- Verify the observable Tokens states in order: missing harness, telemetry disabled, no captured
  data, then report data after capture.
- Keep at least one test proving this path does not depend on any real harness executable or user
  configuration.

## Validation

- The automated scenario passes with no supported harness installed on the test machine.
- The scenario verifies both the prerequisite controls and captured report data through public
  portal behavior rather than private implementation details.
- Existing `scripts/test/harness-refresh-simulation-check.mjs` and
  `scripts/test/telemetry-correctness-check.mjs` remain passing.
- A manual run with one supported harness may be recorded as supplemental evidence, but is not a
  prerequisite for deterministic automated coverage.

## Risks

- Directly invoking the capture entry point may bypass hook wiring. The scenario should validate the
  production hook command or an equivalent route through the installed hook configuration.
- Test fixtures must isolate both harness configuration and telemetry spool state so host data cannot
  influence the result.

## Open questions

- Which supported provider offers the smallest stable fixture for exercising the generated hook
  configuration without launching its interactive agent process?
