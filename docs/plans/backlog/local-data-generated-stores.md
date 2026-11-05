---
id: n8kw3rp2
priority: medium
next_action: Inventory collector/cache ownership and measure retained telemetry coverage using the existing retention registry before selecting history or cleanup policies.
blocked_by: []
depends_on: []
related: ["h4tqm2wz", "pljvmyh", "nl40n9vr", "wu7h7gdp", "nt33p9jn"]
reviewed_commit: 57f8f2199b6db87d829af8d41e387800518024c9
---

# Generated State Stores: Inventory, Retention, and Visibility

## Summary

Extend the existing local-store tooling to explain retained telemetry history and cover remaining
store-policy gaps. The common registry, staleness engine, inspection/reset CLI, doctor integration,
and portal Monitoring baseline were delivered by [[wu7h7gdp]].

## Context

`modules/retention/registry.mjs` owns bounded-store policy; `modules/retention/policy.mjs` owns
measurement decisions. `scripts/cli/maintenance-stores.mjs` and `scripts/doctor.sh` consume them.
`scripts/cli/state-paths.mjs` resolves paths; do not create a second policy registry there.

| Remaining question | Current evidence | Required decision or work |
| --- | --- | --- |
| Telemetry history depth | The spool retains the existing 25 MB ceiling and 0.7 keep fraction | Measure actual history coverage and select a days-based target and byte backstop, or explicitly retain size-only semantics |
| Collector cursors | Capture writes session and activity cursors under `telemetry/collector/` | Inventory cursor lifetimes and readers before choosing age/count cleanup |
| Skills cache | Derived/install artifacts and user-owned source have distinct roots | Read current writers; identify safe cleanup without deleting source, pins, or active materializations |
| Truncation disclosure | Retention bounds exist | Record actual discarded-history counts/time and expose honest coverage to Tokens |
| Disk pressure | Existing tooling reports bounded stores | Decide whether cached free-space-relative visibility adds value beyond current inspection |
| Atomic writes | Feature-owned persistence has correctness-specific behavior | Share only genuinely identical write logic; preserve cursor/in-place versus rename contracts |

The old one-machine measurements are historical motivation, not current sizing evidence. The
target history window and disk-warning thresholds remain product decisions.

## Goals

- Explain how far back telemetry can be analyzed and when data was discarded.
- Give collector and skills-cache cleanup an explicit ownership and retention decision.
- Extend existing store visibility without adding per-turn notifications or another policy engine.
- Reuse atomic-write logic only where feature correctness permits it.

## Non-goals

Expire no durable repository enrollment, preferences, or authored source. Profile backup belongs to
[[74h2tlim]]; repository-scoped telemetry reset belongs to [[nt33p9jn]]. This plan does not change
capture schemas or add a database.

## Proposed design

Extend the existing retention registry and store-report projections. Keep paths in state-paths,
policy in retention, and store-specific commits with their owners. Cache disk measurements away
from portal render/hook hot paths; unavailable disk readings remain unknown.

## Implementation plan

- [ ] Inventory current collector/cache writers, reference lifetimes, rebuildability, and bounds.
- [ ] Measure telemetry record rates/history coverage across supported harnesses and record the
      selected history target; do not silently raise caps from old measurements.
- [ ] Add any approved age/count policies through the existing retention engine and test active
      cursor preservation, interrupted writes, and repeated cleanup.
- [ ] Record cap-triggered discard count/time and expose retained-window/truncation facts in the
      store CLI and Tokens data-quality surface.
- [ ] Evaluate cached free-space-relative warning levels, absolute low-space floors, unavailable
      `statfs` readings, and directory-measurement cost before selecting UI thresholds.
- [ ] Consolidate identical atomic JSON writes only after comparing each store's reader contract.
- [ ] Verify reset/inspection ownership with the existing store CLI and [[nt33p9jn]].

## Validation

Run the existing retention, maintenance-stores, telemetry-store-bounds, and capture checks directly
from `scripts/test/`. Add behavioral coverage for the selected policies, loss disclosure, active
cursors, failed measurements, and idempotence. Run `npm run check` before handing off an implemented
cross-store policy change; the backlog sync does not claim those behaviors are delivered.

## Documentation impact

Update `docs/internal/telemetry-internals.md`, `docs/internal/developer-runtime-internals.md`, and
`docs/user/guides/telemetry.md` with selected retention semantics, coverage limits, and recovery.

## Open questions

- What history depth should telemetry preserve, and what byte backstop is acceptable?
- Which collector/cache artifacts can expire without changing capture deltas or user intent?
- Is disk-share warning UI needed beyond the existing store inspection surface?
