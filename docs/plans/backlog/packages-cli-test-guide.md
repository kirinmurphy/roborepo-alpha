---
id: package-cli-test-guide
priority: low
next_action: Inventory existing hermetic package/portal tests and add the missing shipped CLI-to-portal persistence scenario; reuse the installed Playwright runner.
blocked_by: []
depends_on: []
related: ["user-managed-packages-and-add-workflows"]
reviewed_commit: 57f8f2199b6db87d829af8d41e387800518024c9
---

# Package & User-Content CLI Test Guide

## Summary

Finish repeatable command-to-portal user-content coverage and optional demonstration recording.
The maintained manual verification entry point is `docs/internal/package-user-content-testing.md`.

## Context

Playwright, the hermetic portal runner, and video-capable Playwright configuration already exist.
`package.json` exposes `test:portal-ui`; wiring a browser runner is no longer pending work. Existing
package, MCP, and skill tests supply reusable fixtures. Unified typed `roborepo add` remains owned by
[[user-managed-packages-and-add-workflows]] and is not a prerequisite for testing shipped commands.

## Goals

- Prove representative shipped user-content changes become visible through the real portal API.
- Reuse hermetic harness/home fixtures and avoid any host configuration writes.
- Make terminal/browser recordings reproducible where they add documentation value.

## Proposed design

Extend existing package/portal fixtures with a real mutation-to-observation scenario. Reuse
`scripts/test/portal-ui/helpers.mjs` and host-harness isolation. Test current commands first;
future typed-add journeys are added only when their implementation lands.

## Implementation plan

- [ ] Inventory existing package/skill/MCP mutation coverage and identify the missing joined path.
- [ ] Exercise a shipped CLI change against fixture state and assert the corresponding portal
      status/origin/ownership behavior through its public UI.
- [ ] Cover apply, enable/disable, external/partial state, and preserved user source with the
      smallest representative scenario set.
- [ ] Decide whether demonstration recording is useful; if so, document existing Playwright video
      options and a terminal recording recipe using disposable synthetic data.
- [ ] Extend the runbook with exact verified commands and results as future typed-add flows land.

## Validation

Run `npm run test:portal-ui` with available Chromium and the relevant direct package/skill/MCP
checks. Assert real persisted state through the production API, not a stubbed report. Record missing
browser/external dependencies explicitly; a video alone is not test evidence.

## Documentation impact

Maintain `docs/internal/package-user-content-testing.md` and link it from
`docs/internal/testing.md`. Update user docs only with supported, verified journeys.
