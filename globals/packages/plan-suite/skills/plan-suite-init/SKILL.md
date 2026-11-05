---
name: plan-suite-init
description: Use to set up plan-suite defaults in a repository that does not have them yet — the docs/plans lifecycle folders and docs/plans/plans-config.json with the project's plan-name namespaces, proposed from the codebase or from the user's description. Idempotent; anything already present is kept and reported, never rewritten. Trigger on explicit /plan-suite-init, requests to initialize or set up the plan suite or plan folders in a repo, or when /plan-write finds plans-config.json missing or without namespaces. Do not use for creating or revising a plan (plan-write), renaming plans, adding one namespace to an existing config, or any lifecycle step.
---

# Plan Suite Init

Set up the files the plan suite expects in a repository. Each step checks first and does only the
work still missing, so a rerun on an initialized repository changes nothing and says so.

This skill does not write plans, move plans, or commit. It leaves `worktreeRoot` alone: `/plan-execute`
confirms that with the user on its first run.

## Steps

Resolve the repository root first; every path below is relative to it.

### 1. Lifecycle folders

The plan suite uses six folders under `docs/plans/`:

`backlog/`, `ready/`, `active/`, `review/`, `completed/`, `archived/`

Create only the missing ones. Git does not track empty folders, so add an empty `.gitkeep` to each
folder you create; the plan tools read only `.md` files. Never touch an existing folder or its
contents.

### 2. Config file

`docs/plans/plans-config.json` is initialized when it exists, parses as JSON, and has a `namespaces`
key. An empty `namespaces` object counts: it records that the user chose no project namespaces.

- **Initialized**: skip this step and step 3.
- **Missing**: run step 3, then write
  `{ "schemaVersion": 1, "namespaces": { ... } }` with the agreed set.
- **Present without `namespaces`**: run step 3, then add the `namespaces` key and keep every other
  key and value as it is.
- **Not valid JSON**: stop. Report the parse error and ask the user to fix the file; do not
  overwrite it.

Keep the file to values. The naming rules live in `/plan-write`, not in per-repository config.

### 3. Namespaces

A plan filename is `<namespace>-<slug>.md`. The universal namespaces (`cli`, `git`, `infra`, `os`,
`testing`, `docs`, `security`, `perf`) need no declaration; the config holds only the project's own
domain vocabulary, as `"<namespace>": "<one line on what it covers>"`.

Propose an initial set derived from the repository:

- top-level source directories (`modules/`, `src/`, `packages/`, `apps/`), which usually are the
  domains;
- CLI command groups, routes, or services the project already exposes;
- recurring prefixes across existing plan filenames under `docs/plans/`.

Show the evidence behind each proposal ("`billing` because `src/billing/` holds the invoice and
payment modules and two plans already start with it"). Leave out anything a universal namespace
already covers.

When the repository has too little code to infer domains from, say so and ask the user to describe
the project's main areas in a sentence or two, then propose namespaces from that description.

Either way, **ask the user to refine before writing**. A namespace chosen badly gets copied into
every future filename. Merge overlapping proposals, use the project's own words, and write only the
agreed set. If the user wants none, write `"namespaces": {}`.

## Report

List what this run created and what was already present:

```text
Created: docs/plans/ready/ (with .gitkeep), docs/plans/plans-config.json (3 namespaces)
Already present: docs/plans/backlog/, docs/plans/active/, ...
```

When nothing was missing, report "Plan suite already initialized; no changes." Leave the new files
uncommitted and say so. When `/plan-write` invoked this workflow, return to it.
