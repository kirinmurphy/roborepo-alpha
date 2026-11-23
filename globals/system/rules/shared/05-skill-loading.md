## Skill Loading

Load a matching skill before the work it governs, not after — and only the skills the task actually needs.

A skill's `## Paired Skills` table names related skills, each with a `Load when` condition. For each
row:

1. If the condition does not match the work, do nothing.
2. If it matches and the session lists the skill, load it. A `requires` row is always listed while
   its parent is on.
3. If it matches and the session does not list the skill, continue without it and name it once in
   the final report: "Skipped `react`: not enabled".

Decide availability from the skills the session lists, not by calling the package manager, and never
ask the user mid-run to enable a package. Enabling a package is where recommendations are offered,
once. A missing `requires` skill means its parent package is unhealthy: report that, with
`roborepo package status <package>`, instead of running without it.
