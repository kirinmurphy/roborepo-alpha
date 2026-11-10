---
id: developer-runtime-git-health-history
priority: none
next_action:
blocked_by: []
depends_on:
  - developer-runtime-final
  - canonical-repository-identity-plan-v2
related:
  - developer-runtime-docker-process-providers
  - developer-runtime-metadata-suggestions
  - git-exec-consolidation
reviewed_commit:
---

# Runtime Git Health And History

## Summary

Local Git context, health-state normalization, and bounded transition history for Runtime apps,
with no repository configuration required. Delivered.

## Current State

Shipped. Every goal below is implemented, covered by fixture tests, and verified against a live
portal. Reference documentation is in `docs/user/reference/runtime.md`.

## Dependency on Canonical Repository Identity (v2)

`canonical-repository-identity-plan-v2` is complete and this work consumes its resolver:
`resolveGitDir` (worktree + `commondir` handling), `canonicalRepositoryId`, `rootId`, and
`realpathOf`. No second resolver was written.

**Correction to this plan's original premise:** v2 was expected to have shipped a per-scan
resolution cache, and this plan was told to consume rather than build one. Verification found no
cache anywhere in `modules/repositories/` — every function there is a stateless filesystem read. The
cache was therefore built here, in `modules/repositories/scan-cache.mjs`, which is where v2 would
have placed it. Building it inside `modules/developer-runtime/` would have been exactly the duplicate this
plan's dependency section forbids.

## Goals

- [x] Collect Git branch, detached HEAD, short commit, dirty state, and ahead/behind from existing
      local refs only.
- [x] Never fetch remotes or invoke hooks.
- [x] Normalize health states into `healthy`, `degraded`, `unhealthy`, `starting`, `unknown`, and
      `inactive`.
- [x] Debounce consecutive failures before recording transitions.
- [x] Append bounded JSONL events for first seen, origin change, health transitions, exposure
      changes, duplicate changes, and inactive transitions.
- [x] Tolerate a truncated final JSONL line and compact by retention days plus file-size cap.

## What Shipped

- [x] `modules/repositories/scan-cache.mjs` — per-scan memoization keyed by repository root
      realpath, created per `discoverInstances` call and discarded on return.
- [x] `modules/repositories/git-exec.mjs` — hardened Git seam with a read-only subcommand
      allow-list, hook/lock/prompt hardening, timeout, and `maxBuffer`. Ships an async default and a
      `defaultRunGitSync` sibling.
- [x] `modules/developer-runtime/git.mjs`, `git-refs.mjs` — filesystem reads for branch/commit/upstream,
      subprocess for dirty and ahead/behind.
- [x] `modules/developer-runtime/health.mjs`, `health-policy.mjs` — pure six-state classifier; the failure
      count travels with the snapshot rather than living in module state.
- [x] `modules/developer-runtime/history.mjs`, `history-diff.mjs` — bounded JSONL store and a pure
      snapshot diff producing the six event types.
- [x] `modules/developer-runtime/instance-shape.mjs` — record shaping and association-key derivation split
      out of `discovery.mjs`.
- [x] `git` and `history` promoted from `FUTURE_PROVIDERS` to supported in `capabilities.mjs`.
- [x] `GET /api/developer-runtime/history?key=<opaque-key>` returns real bounded events.
- [x] Portal: Git badge and health-accented status on the card, plus a history dialog in
      `portal/developer-runtime/history-view.js`.

## Decisions

| Decision | Rationale |
| --- | --- |
| Scan cache in `modules/repositories/`, not Runtime | Root-keyed metadata is not a Runtime concept; a local copy is the duplicate the dependency section forbids |
| Hybrid filesystem/subprocess Git collection | Dirty state and ahead/behind cannot be read correctly from the filesystem; a wrong "clean" is worse than no answer |
| Poll Git every refresh | User decision. `--no-optional-locks` guarantees the user's index is never written |
| `dirty`/`ahead`/`behind` are `null`, never `false`/`0`, on failure | Correct-or-absent; the portal renders nothing rather than implying clean |
| Debounce derived from the previous snapshot | Keeps the classifier pure; module state would spuriously increment on the settings-rebuild path |
| Unconfigured 4xx is `unknown`, not `degraded` | Discovered during live verification: gRPC/IPC daemons legitimately answer 403/404 to a browser GET, and flagging them filled the page with false alarms |
| Grace window and threshold as defaults, no schema change | No producer and no UI; the strict allow-list makes adding them later forward compatible with no version bump |
| Single global `history.jsonl` | Transition-only volume is tiny; per-app shards orphan themselves when `disambiguateAssociationKeys` swaps in a title key |
| Full-read parser instead of `readAppendedLines` | That helper exists for cursor-holding incremental tailing; history is read whole, on demand, by key |
| `diffSnapshots` as a pure module function | The comparison rules are the event semantics; the CLI layer only owns the `lastSnapshot` reference |
| Cold start consults existing history keys | Otherwise every portal restart re-announces every running app |
| Three legacy `git()` duplicates left in place | Sync/async mismatch makes migration a real refactor; tracked in `git-exec-consolidation` |

## Validation

- [x] Fixture tests: branch, detached HEAD, packed-refs fallback, no remote, worktree via
      `commondir`, dirty state, `dirty === null` on subprocess failure, ahead/behind, no-fetch and
      no-hook enforcement, scan-cache dedup — `scripts/test/developer-runtime-git-check.mjs`.
- [x] Health grace windows, failure debounce, flap resistance, `since` semantics —
      `scripts/test/developer-runtime-health-check.mjs`.
- [x] All six event types, malformed and truncated JSONL, retention, size cap, atomic compaction,
      opaque-key route resolution and 404 — `scripts/test/developer-runtime-history-check.mjs`.
- [x] Scan-cache memoization — `scripts/test/repositories-check.mjs`.
- [x] `node --check` on all touched JavaScript.
- [x] `npm run test:developer-runtime`.
- [x] `bash scripts/test/test-roborepo.sh --quiet` — 343 passed, 0 failed.
- [x] `bash scripts/doctor.sh --quiet` — 99 checks passed.
- [x] Manual macOS validation against a live portal: Git context on a linked worktree and on a
      primary clone with an upstream, health classification across real listeners, history events
      written with registry joins and no absolute paths, history route returning events for a real
      key and 404 for a bogus one, and all portal assets serving and parsing.

**Note on test coverage wiring:** `test:developer-runtime` existed as an npm script but was never invoked
by `scripts/test/test-roborepo.sh`, so the entire existing Runtime suite had not been running in
CI. It is now wired in alongside the three new checks.

## Known Limits

Carried into `docs/user/reference/runtime.md` under Current Limits:

- `health.path` is stored and validated but not yet probed; probes still hit the origin root.
  Honoring it requires a second probe per app.
- History is unreachable for stopped apps — inactive entries carry no opaque key, and the route
  deliberately resolves only keys the current snapshot minted.
- Starting grace and failure threshold are global defaults, not per-app settings.
- `dirty`, `ahead`, and `behind` are `null` when `git` is unavailable or slower than the timeout.
- Git polls on every refresh while the portal is open; throttling per root would be a contained
  change if it proves noisy.
