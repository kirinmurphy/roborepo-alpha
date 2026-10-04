# Multi-Document Sets

Use this only when revising a documentation set, not when writing one standalone doc.

Organize docs around reader intent instead of repo history. Prefer a small number of obvious
buckets over a rigid global taxonomy. Common buckets include:

- guides for setup, daily use, and operational choices
- reference for exact behavior, APIs, implementation details, and capability docs
- internal or maintainer docs for repo-specific machinery that ordinary users do not need
- plans or todos for unresolved future work only (see `plan-write` for the lifecycle/frontmatter
  mechanics that govern this bucket specifically)

Make one doc own each explanation depth:

- README gives a compact summary and routes readers to deeper docs.
- Guide gives the practical decision model: what to do, when to choose each path, what each option
  gives, what it hinders, and what the user must do next.
- Reference gives exact mechanics and edge cases.
- Plans mention only remaining work and link to the owner doc for current behavior.

Do not impose folder names globally. Match existing repo conventions when they are clear. Add
folders only when reader intent is currently mixed or docs are becoming hard to scan.
