---
id: windows-provider-path-schema
priority: low
next_action: Verify supported Windows provider locations on the shared runner, then decide whether home-relative manifest resolution suffices before extending the path schema.
blocked_by: []
depends_on: []
related: ["discoverable-harness-provider-architecture", "l1mz96d9", "0pzhhong"]
reviewed_commit: 57f8f2199b6db87d829af8d41e387800518024c9
---

# Windows Provider Path Schema

## Summary

Derive Windows harness locations from provider manifests instead of maintaining a PowerShell
provider switch. Add an environment-rooted path form only if supported native locations require it.

## Context

`scripts/install/install-windows.ps1::Resolve-ManifestHomeRoot` currently maps Claude, Codex, and
Gemini to `USERPROFILE/.claude`, `USERPROFILE/.codex`, and `USERPROFILE/.gemini`. The earlier claim
that it uses `APPDATA/Claude` was incorrect. This repository inspection does not establish which
native versions require other Windows locations.

`scripts/harnesses/paths.mjs::expandHome()` expands only home-relative strings. Platform overrides
exist, but still use that path form. The provider architecture prerequisite has completed; real
Windows behavior coverage is owned by [[l1mz96d9]] and [[0pzhhong]].

## Goals

- One provider-owned source for Windows homes and configuration locations.
- Native-location evidence determines whether a new path schema is necessary.
- PowerShell consumes the provider resolver rather than duplicating its provider list.

## Proposed design

First compare the registered manifests, installer output, and supported native locations on the
Windows runner. If every supported path is home-relative, reuse the current schema. If a required
path is environment-rooted, define a validated resolver form with missing-variable behavior before
changing manifests. The Node resolver and installer must agree on the same result.

## Implementation plan

- [ ] Reproduce supported provider locations on Windows and record versions and evidence.
- [ ] Select the smallest schema change justified by those observations, including no extension
      when home-relative paths suffice.
- [ ] If needed, extend provider schema/path resolution with environment-rooted values, clear
      missing-variable errors, and platform-isolated tests.
- [ ] Update provider Windows overrides from verified paths.
- [ ] Replace the PowerShell switch with consumption of the canonical provider resolver, using
      structured output rather than parsing a human-oriented table where practical.
- [ ] Verify detection, install, update, and uninstall in the shared Windows test environment.

## Validation

Run `node scripts/test/harness-manifest-check.mjs` and
`pwsh -File scripts/test/windows-installer-check.ps1`. Real Windows lifecycle scenarios must prove
resolved files land at the native locations. A parser pass or simulated platform argument alone is
not end-to-end acceptance. Run `npm run check` after implementing a shared resolver change.

## Documentation impact

Update `docs/internal/harness-provider-interface.md` and Windows setup guidance only for paths and
schema forms actually verified. Link the compatibility ledger owned by [[l1mz96d9]].

## Open questions

Which supported native Windows installations require a location not expressible as `~/...`, and
what should resolution report when a required environment variable is absent?
