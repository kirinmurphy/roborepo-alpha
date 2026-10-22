---
id: codex-cmux-hook-trust-review
priority: low
next_action: Audit Codex hook trust bypass behavior in cmux-launched sessions and decide whether roborepo should document, warn, or guard against it
blocked_by: []
depends_on: []
related: ["top-down-security-parity-review"]
reviewed_commit: 57f8f2199b6db87d829af8d41e387800518024c9
---

# Codex Cmux Hook Trust Review

## Summary

Review whether Codex sessions launched through cmux should use
`--dangerously-bypass-hook-trust`, and decide what roborepo should do if that behavior remains
outside this repository's direct control.

## Context

A cmux-launched Codex session can prepend `--enable hooks`,
`--dangerously-bypass-hook-trust`, and inline `-c hooks.*=...` arguments so cmux lifecycle hooks
run without requiring Codex's persisted hook trust review. That helps automation and session
rebinding, but the bypass flag is invocation-wide: it is not scoped only to cmux-injected hooks.

Roborepo already manages Codex baseline config and generated rules. It also ships Codex hooks for
telemetry, permission checks, bash-output minimization, jcodemunch, and jdocmunch behavior.

## Goals

- Confirm exactly which hook sources Codex loads when the bypass flag is present.
- Determine whether cmux can scope bypass to its own injected hooks or remove bypass after one-time
  review.
- Decide whether roborepo should add a warning, doctor check, portal notice, or documentation note.
- Preserve normal interactive hook review for user, project, package, and plugin hooks.
- Avoid blocking legitimate automation where hook sources are externally pinned or managed.

## Non-goals

- Do not change cmux itself from this repository unless cmux support is intentionally brought into
  scope.
- Do not disable roborepo's own hooks as a workaround.
- Do not treat all dynamic hook injection as unsafe; the concern is unscoped trust bypass.

## Current State

| Area | Current behavior | Concern |
| --- | --- | --- |
| Codex baseline | `features.hooks = true` in managed config | Expected; hooks remain reviewable without bypass |
| Roborepo hooks | Generated/global hooks run for telemetry and guardrails | Should stay reviewable or managed |
| cmux launch path | cmux may inject hook config through CLI args | Needs audit for source control and scoping |
| Trust bypass | `--dangerously-bypass-hook-trust` applies to the whole invocation | User/project/plugin hooks may also skip review |

## Proposed Design

Investigate first, then choose the lightest response:

1. If cmux can remove the bypass while preserving session tracking, prefer that.
2. If cmux needs bypass only for its own hooks, prefer a launch mode that prevents unrelated hook
   sources from loading.
3. If roborepo cannot change runtime behavior, add visibility: a doctor warning or portal notice
   when a live Codex command line contains `--dangerously-bypass-hook-trust`.
4. Document when bypass is acceptable: non-interactive automation with externally vetted hook
   sources, not ordinary human interactive sessions.

## Implementation Plan

- [ ] Reproduce a cmux-launched Codex session and capture only the process command line plus active
      Codex hook source list.
- [ ] Inspect Codex docs or CLI behavior to confirm whether bypass applies to all enabled hook
      sources.
- [ ] Identify whether Codex supports disabling user/project/plugin hook discovery while retaining
      inline injected hooks.
- [ ] Decide whether the fix belongs in cmux, roborepo docs, `roborepo doctor`, or the portal.
- [ ] If adding a roborepo warning, keep detection read-only and scoped to live process args or
      explicit config files.

## Validation

- Document the observed hook source list for one cmux-launched Codex session.
- Verify any roborepo warning with a fixture or targeted smoke test.
- Run the smallest native check for touched code or docs.

## Risks

- Process inspection may need local permission escalation on macOS.
- A warning based only on process args can produce false positives for intentional automation.
- Codex hook trust behavior may change across CLI versions, so doc wording should avoid assuming
  stable internals beyond observed behavior.

## Open Questions

- Can cmux inject only managed/pinned hooks so Codex trust review remains meaningful?
- Can cmux launch Codex with inline hooks while excluding user, project, and plugin hook sources?
- Should roborepo surface this as a security warning, a context note, or no warning unless the user
  opts into runtime audits?

## Evidence to refresh before implementation

The backlog review did not reproduce current cmux arguments or enumerate active native hook sources.
Treat invocation-wide bypass and source-loading claims as hypotheses to confirm against recorded
versions and one fresh authenticated session. Completed security plans do not substitute for that
evidence. Choose documentation, warning, or enforcement only after observing the actual behavior.
