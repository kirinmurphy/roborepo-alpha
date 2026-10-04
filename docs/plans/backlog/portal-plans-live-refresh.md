---
id: plans-portal-live-refresh-and-static-preflight
priority: low
next_action: Decide whether to build the SSE live-refresh path or defer indefinitely in favor of manual refresh
blocked_by: []
depends_on: []
related: [plan-docs-and-plans-portal-plan]
reviewed_commit: b8684ef
---

# Plans Portal — Live Refresh and Static Slash-Command Preflight

## Summary

Ancillary follow-up carved out of
[`completed/plan-docs-and-plans-portal-plan.md`](../completed/plan-docs-and-plans-portal-plan.md).
The core Plans portal, the portable `plan-suite` domain module, the `plan-write`
package + skill, and portal-driven lifecycle/priority mutation all shipped. Two
optional enhancements from the original plan were never built and are tracked
here so the parent can move to `completed/`.

## Context

The parent plan's Phase 6 (live refresh) and Phase 4b (static no-argument
slash-command preflight) were both explicitly optional and staged after the
initial release. Neither blocks any shipped behavior:

- The portal already updates via manual **Refresh** and after mutations.
- `/plan-write` with no argument already returns compact help through the agent
  runtime; the preflight would only remove the small model-context cost of that
  help path.

## Goals

- Decide whether either enhancement is worth building, or whether both stay
  deferred as accepted limitations.
- If built, do so without regressing the shipped manual-refresh and
  agent-routed-help behavior.

## Current state

Shipped in `main` (from the parent plan):

- `/plans` portal — `portal/plans/`.
- Portable domain module — `modules/plan-suite/` (`index.mjs`, `repair.mjs`).
- CLI adapter — `scripts/cli/plans.mjs`.
- `plan-write` package + skill — `globals/packages/plan-write/`.
- Lifecycle/priority mutation — `POST /api/plans/lifecycle`,
  `POST /api/plans/priority` (`portal/plans/api.js`,
  `modules/plan-suite/index.mjs::movePlanLifecycle` / `updatePlanPriority`).

Not built:

- `GET /api/plans/events` (SSE) and directory watchers.
- Shared static command preflight for no-argument slash-command help.

## Proposed design

### Live refresh (Phase 6)

- Watch each discovered `docs/plans` directory explicitly (not recursive
  `fs.watch` — platform variance), debounce events, rescan only affected repos.
- Expose `GET /api/plans/events` as SSE; update the page without full reload.
- Retain the periodic root-discovery fallback and manual refresh.
- Watchers live only while the portal process runs; no standalone daemon.

### Static slash-command preflight (Phase 4b)

- A shared command-preflight layer for package-owned slash commands returning
  static usage text for no-argument invocations, routing mode/argument
  invocations to the agent as today.
- Build only if **both** Claude and Codex support it cleanly. If only one does,
  or it needs brittle hook workarounds, keep agent-routed help and document the
  deferral.

## Implementation plan

- [ ] Decide: build SSE live refresh, or accept manual refresh as final.
- [ ] If building: watchers + debounce + repo-scoped rescan + SSE endpoint +
      browser updates + watcher cleanup on shutdown.
- [ ] Tests: file add/modify, lifecycle move, watcher-failure fallback, SSE
      reconnection.
- [ ] Decide: build shared static command preflight, or document deferral.
- [ ] If building: shared preflight layer + static no-arg help + agent routing
      for arguments + tests for `plan-write` plus one other command family.

## Validation

- Live refresh: a plan file change reflects in an open Plans page without manual
  refresh; watcher failure falls back to manual refresh cleanly.
- Preflight: no-argument `/plan-write` returns static help without agent-runtime
  cost on supported harnesses; argument invocations still route to the skill.
- `roborepo doctor` and `roborepo verify` remain green.

## Open questions

- Is live refresh worth the watcher complexity given manual refresh already
  works for a single-user local portal?
- Can both harnesses support static no-argument command help without
  hook-specific workarounds?
