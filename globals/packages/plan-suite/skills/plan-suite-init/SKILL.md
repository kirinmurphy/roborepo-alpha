---
name: plan-suite-init
description: Use to set up the plan store in a repository that does not have it yet — the remote `repo-plans` branch, its reserved local worktree, and the project's plan-name namespaces, proposed from the codebase or from the user's description — or to reconnect a fresh clone to an existing store. Idempotent; anything already present is kept and reported, never rewritten. Trigger on explicit /plan-suite-init, requests to initialize or set up the plan suite or plan folders in a repo, when a `roborepo plans` command or the Plans portal says the repo is not set up, or when /plan-write finds plans-config.json without namespaces. Do not use for creating or revising a plan (plan-write), renaming plans, adding one namespace to an existing config, or any lifecycle step.
---

# Plan Suite Init

Connect a repository to its plan store. Plans live under `plans/` on the remote branch
`origin/repo-plans`, checked out in a reserved local worktree that only `roborepo plans` commands
write to. Each step checks first and does only the work still missing, so a rerun on an initialized
repository changes nothing and says so.

This skill does not write plans or move them.

## Steps

Run every command from any checkout of the repository.

### 1. Find out whether a store exists

```bash
git ls-remote --heads origin repo-plans
```

- **The branch exists:** go to step 2 with no flags. The config on that branch already says where the
  worktree goes.
- **The branch does not exist:** propose `~/.worktrees` as the worktree root, state the path it
  resolves to, and wait for the user to confirm or override it. This is asked once per repository.
- **No `origin` remote, or the command fails:** stop and report it. The plan suite needs a Git
  repository with an `origin` it can reach.

### 2. Create or reconnect the store

```bash
roborepo plans init --worktree-root <confirmed path> --json
```

Leave out `--worktree-root` when the branch already exists. Pass `--repo-name <name>` only when the
user asks, or when another repository sharing this root already uses this folder name.

The command creates the branch with its lifecycle folders, `plans/plans-config.json`,
`plans/plans-order.json`, and a root `README.md`, or fetches it; creates or recovers the locked
worktree; and pushes any pending commits. The README tells anyone who opens the branch on the Git
host that it is an orphan branch holding plans, never merged, and changed only through
`roborepo plans`. A branch created before the README existed gets it on this run (`readme: "added"`);
one already there is kept as written. Never write or edit it yourself. It never reports a local-only success. On a refusal (no remote, failed credentials,
a destination that belongs to another repository), report the command's reason and stop. Never
replace or delete anything at that path.

On Codex, tell the user to run `roborepo update` from this repository next. The sandbox grants for
the store render from the repository the update runs in, so saves fail until then.

### 3. Namespaces

Read `plans/plans-config.json` from the worktree the command reported. A `namespaces` key means this
step is done, even when empty: that records that the user chose no project namespaces. Skip to the
report.

A plan filename is `<namespace>-<slug>.md`. The universal namespaces (`cli`, `git`, `infra`, `os`,
`testing`, `docs`, `security`, `perf`) need no declaration; the config holds only the project's own
domain vocabulary, as `"<namespace>": "<one line on what it covers>"`.

Propose an initial set derived from the repository:

- top-level source directories (`modules/`, `src/`, `packages/`, `apps/`), which usually are the
  domains;
- CLI command groups, routes, or services the project already exposes;
- recurring prefixes across any existing plan filenames in the store.

Show the evidence behind each proposal ("`billing` because `src/billing/` holds the invoice and
payment modules and two plans already start with it"). Leave out anything a universal namespace
already covers.

When the repository has too little code to infer domains from, say so and ask the user to describe
the project's main areas in a sentence or two, then propose namespaces from that description.

Either way, **ask the user to refine before writing**. A namespace chosen badly gets copied into
every future filename. Merge overlapping proposals, use the project's own words, and write only the
agreed set. If the user wants none, write an empty object.

Write the agreed set to a JSON file outside the checkout, then:

```bash
roborepo plans config namespaces <file.json> --json
```

Keep the file to values. The naming rules live in `/plan-write`, not in per-repository config.

## Report

Say what this run created or reconnected, where the worktree is, and whether the result reached the
remote:

```text
Created: origin/repo-plans, worktree at ~/.worktrees/acme/repo_plans, 3 namespaces (synchronized)
Added: README.md on repo-plans (synchronized)
```

When nothing was missing, report "Plan suite already initialized; no changes." When `/plan-write`
invoked this workflow, return to it.
