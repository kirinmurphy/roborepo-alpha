# Tokens page documentation fixture

The user guide's condition example (3/12 vs 9/12) comes from **fictional, deterministic sample data**
in `scripts/test/fixtures/telemetry-conditions-documentation.mjs`. It contains no personal
telemetry, and the isolated unit matrix checks it against fixed numerical expectations:

```sh
node scripts/test/telemetry-conditions-matrix-check.mjs
```

## Test coverage

`telemetry-conditions-matrix-check.mjs` checks 2,850 deterministic scenarios:

- 2,592 condition/event cases: all 6³ three-observation states, all six orderings,
  both with and without duplicated observations.
- 10 explicit rate/sample/event-floor golden cases.
- 16 snapshot evaluability cases, including missing snapshots and v2 unavailable evidence.
- 35 invalid token field cases.
- 162 session token-validity cases (valid, missing, invalid) across all small-input orderings.
- 24 mirrored-flow/cross-harness permutations.
- 10 marker-boundary cases, including sequence ties and unrelated sequence domains.
- 1 documentation fixture with independently specified cohort counts and rates.

This is exhaustive for the stated small-input spaces, not a claim to enumerate all
possible telemetry records or browser states. Existing integration/cache/boundary suites
cover larger fixtures and persistence behavior.
