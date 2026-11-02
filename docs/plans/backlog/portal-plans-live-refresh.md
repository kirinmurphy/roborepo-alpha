---
id: plans-portal-live-refresh-and-static-preflight
priority: low
next_action: Decide general file-change refresh independently from static command help, using current refresh APIs and the native invocation research.
blocked_by: []
depends_on: []
related: ["plan-docs-and-plans-portal-plan"]
reviewed_commit: 57f8f2199b6db87d829af8d41e387800518024c9
---

# Plans Portal — Live Refresh and Static Slash-Command Preflight

## Summary

Decide whether to add general plan-file live refresh and static no-argument workflow help. These
are independent optional enhancements to the completed Plans portal. The parent is already in
completed; neither proposal is required to finish that historical work.

Manual refresh, priority editing, and agent-routed help are the current baseline. Lifecycle changes
use atomic commands rather than the former generic portal mutation route.

## Current API and independent decisions

`scripts/cli/portal-routes-plans.mjs` currently exposes refresh, prompt, document, and priority
operations, not a generic lifecycle mutation endpoint. Lifecycle transitions use atomic commands.
The page polls synchronization progress, but does not subscribe to general plan-file changes.

Live file-change refresh and static no-argument command preflight are independent optional
workstreams. Implement neither implicitly while preparing the other. Native invocation discovery
is owned by [[wrap-up-coderabbit-integration-plan]] Workstream 1; decide static help only after its
supported provider mechanism is known. Manual refresh remains an acceptance fallback.

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
- `plan-write` skill, in the `plan-suite` package — `globals/packages/plan-suite/skills/plan-write/`.
- Priority updates use `POST /api/plans/priority`; lifecycle changes use the current atomic
  plan-suite commands. The earlier generic portal lifecycle-mutation route is retired.

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
- `roborepo doctor` and `bash scripts/verify-install.sh --quiet` remain green.

## Open questions

- Is live refresh worth the watcher complexity given manual refresh already
  works for a single-user local portal?
- Can every supporting harness (Claude, Codex, Gemini) give static no-argument command help without
  hook-specific workarounds?

## Documentation impact

`docs/user/reference/plans-portal.md` and `docs/internal/plans-portal-internals.md`: selected refresh/help behavior and its limitations.
