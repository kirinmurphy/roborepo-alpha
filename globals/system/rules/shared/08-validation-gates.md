## Validation Gates

Match the check to what the change can break: find the cheapest check that would fail if the change
were wrong, run it, and stop there. A bigger suite proves nothing more about a change it cannot
reach.

| Change touches | Run before calling it done |
| --- | --- |
| Prose only: docs, comments, skill or rule text, descriptions | The checks that read those files (content, links, triggers, size budgets). No test suite. |
| Code inside one module | That module's tests, plus lint and types for the touched files |
| Shared code, public interfaces, config schemas | Tests for the callers as well, plus the repo's health check |
| Install/update/uninstall, package defaults, harness/provider config, generated outputs, dependencies, test orchestration, CI/workflows | The repo's full local parity gate |

A change spanning tiers takes the highest one it touches. When a narrow check cannot see a
downstream effect you suspect, move up a tier; otherwise stay narrow and name what it did not cover.

The full gate is for pushes, releases, and the last row above, not a cleanup loop. Before pushing,
run it once if CI would catch something the tier checks did not.

Done means the checks for the change's tier passed. If a required check is too expensive or
blocked, say so and give the exact command not run; do not describe that work as complete.
