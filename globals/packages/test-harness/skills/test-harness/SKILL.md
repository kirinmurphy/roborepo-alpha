---
name: test-harness
description: Use when choosing, adding, running, or explaining tests; debugging CI failures; validating code edits; or deciding whether scoped checks or full checks are appropriate.
---

# Test Harness

Keep verification small, native to the repo, and explicit.

## Workflow

1. Discover commands from repo files before guessing: `package.json`, `pyproject.toml`, `Makefile`, `justfile`, `taskfile`, CI config, or docs.
2. Choose the smallest check that proves touched behavior.
3. Prefer scoped format/lint/type/test commands when available.
4. Pick the tier by what the change can break: prose-only edits run the checks that read those files, not a suite; module code runs that module's tests; shared code adds its callers. Run full checks only for build/tooling config, dependency changes, generated types, auth/payments/data migrations, CI scripts, broad refactors, cross-cutting types/config, before a push, or on explicit user request.
5. If output may be large, use `roborepo run <command> ...` or redirect to `/tmp` and show only useful failure/pass lines.
6. Final response includes `Verified: <command> -> <pass|fail|blocked>`.

## Test Design

- Test user-visible behavior and externally meaningful outcomes, not internal state, props, private methods, or incidental function calls.
- Prefer semantic selectors in UI tests: role/name first, then label text, then visible text. Use test IDs only when semantic queries cannot identify the element cleanly. Avoid CSS selectors, tag selectors, and class names.
- For bug fixes and behavior changes, write or identify a failing test first, run it to prove it catches the issue, then make the fix pass.
- Use Playwright or another real-browser E2E tool when unit tests mock away the behavior under review, such as routing, reload/download/file chooser behavior, store-to-UI-to-persist flows, or cross-step navigation.
- For existing behavior covered by E2E tests, add regression tests that prove the old breakage path fails before the fix and passes after it.
- Assertions on mock calls are acceptable only when the call is the observable contract, such as an outbound API call with no user-visible effect.

## Docker Sandboxes

Use Docker when behavior depends on machine shape: clean `HOME`, clean `PATH`, package-manager
prefixes, harness discovery, generated config projection, uninstall ownership, Linux filesystem
semantics, or absence/presence of agent CLIs. Do not use Docker for behavior that a focused
Node/shell test can prove directly.

Prefer one reusable image as a disposable machine template, with a fresh container per scenario.
Reset state by deleting the container, not by trying to clean a long-lived container back to a
baseline. Pack or prepare artifacts once on the host, install once per scenario, then run every
assertion that can share that installed state. Re-run package install/uninstall only when lifecycle
behavior itself is under test.

Keep Docker scenarios separated by failure meaning. A clean-install sandbox should prove package
install/init/doctor/uninstall only; permissions projection, fake harnesses, lifecycle ownership, and
platform-portability checks belong in separate sandbox scripts.

For this repo, maintain the detailed pattern in `docs/internal/docker-test-sandboxes.md`.

## Blocked Verification

Use `blocked` only when the command cannot run because of missing dependencies, network/sandbox restrictions, unavailable services, or unclear repo setup. Include the exact command attempted.

## Delivery Honesty

- Before reporting a code or UI change complete, verify the exact file content and paths actually changed.
- If a requested change was not applied, state that explicitly instead of implying completion.
