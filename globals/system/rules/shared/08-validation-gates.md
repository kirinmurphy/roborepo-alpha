## Validation Gates

Match the check to what the change can break: find the cheapest check that would fail if the change
were wrong, run it, and stop there. A bigger suite proves nothing more about a change it cannot
reach.

| Change touches | Run before calling it done |
| --- | --- |
| Prose only: docs, comments, skill or rule text, descriptions | The checks that read those files (content, links, triggers, size budgets). No test suite. |
| Code inside one module | That module's tests, plus lint and types for the touched files |
| Shared code, public interfaces, config schemas | Tests for the callers as well, plus the repo's health check |
| Install/update/uninstall, package defaults, harness/provider config, generated outputs, dependencies | Tests for the affected flows, plus the repo's health check. CI runs the full gate. |
| Test orchestration, CI/workflows | The repo's full local parity gate, once |

A change spanning tiers takes the highest one it touches. When a narrow check cannot see a
downstream effect you suspect, move up a tier; otherwise stay narrow and name what it did not cover.

CI is the full gate. Run the full gate locally only for the last row above, for a release, or on
request, never as a cleanup loop; run it in the background where the harness allows. On push, the
repo's pre-push check runs when it has one, and CI runs the full gate: keep working, and read the CI
result when it lands instead of reproducing it locally. Fix a red result like any other failure.

Done means the checks for the change's tier passed. If a required check is too expensive or
blocked, say so and give the exact command not run; do not describe that work as complete.
