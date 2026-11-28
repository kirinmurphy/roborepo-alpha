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
  repository with an `origin` it can reach. When `origin` is on GitHub, run step 5's check before
  stopping and include its offer: on Codex the sandbox has no network until the GitHub agent
  identity is on, and `not-set-up` is read from local files, so the check still answers.
- **`Repository not found` while the GitHub agent identity is on:** your Git goes out as the bot,
  and a new repo has not invited it yet. Step 5's check reads the repo as the user; when its
  `problems` include `not-collaborator` or `invite-pending`, say that the bot needs an invitation:
  the user runs `roborepo git github setup` in this repo, in their own terminal, then reruns
  `/plan-suite-init`. When `not-collaborator` carries `owner: true`, the user is not an admin of
  the repo and setup cannot invite the bot: tell them to ask the repo's owner to invite it with
  Write access (the report's `ownerMessage` is ready to send), then rerun `/plan-suite-init`.
  `roborepo plans init` reports the same reason when it meets this.

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
step is done, even when empty: that records that the user chose no project namespaces. Continue at
step 4.

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

### 4. Offer branch protection

`repo-plans` holds the only copy of the repository's plans, so check that the Git host protects it,
along with the default branch:

```bash
roborepo protect --check --json
```

Act on `state` and `admin` in the result. `--check` only reads; nothing changes without the user's
yes.

| Result | Do |
| --- | --- |
| `missing`, `admin: true` | Tell the user what is unprotected, from the `policies` entries that list `missingRules`, and ask whether to protect the repository now. On a yes, run `roborepo protect` and report its final state. On a no, report that `roborepo protect` does it later. |
| `missing` or `drifted`, `admin: false` | Report that the account in `login` is not an admin, and that a repository admin must run `roborepo protect`. |
| `drifted`, `admin: true` | Report which managed ruleset differs and that `roborepo protect` updates it. |
| `conflicting` | Report each entry under `conflicts` with its `detail`, which names what will refuse plan saves and where to turn it off: a ruleset to exclude the plans branch from, or a branch protection setting. |
| `unsupported` | Report `reason` and the `manualSteps` for protecting the branches by hand. |
| `unavailable` | Report `reason` and that protection was not checked. Setup is still complete. |
| `protected`, `unmanaged` | Report the state in one line. |

Never run `roborepo protect --skip` here; turning the merge rules off is the owner's own choice.

### 5. Offer the GitHub agent identity

Agents can act on GitHub as a separate bot account, so GitHub itself refuses an agent push to the
default branch or a merge without a person's approval. Check whether it is set up:

```bash
roborepo git github status --json
```

It only reads. Act on `state`:

| `state` | Do |
| --- | --- |
| `not-set-up` | Offer it in two sentences: what it gives (the line above), and that the user runs `roborepo git github setup` in their own terminal, which walks them through creating the bot and its token. Never run the setup yourself and never ask for the token: agents are denied the command, and a token pasted into chat lands in the transcript. |
| `problem` | Report each entry under `problems`; rerunning `roborepo git github setup` fixes or re-checks them. |
| `healthy` | Report it in one line. |
| `unavailable` | Report `reason` and that the identity was not checked. Setup is still complete. |

## Report

Say what this run created or reconnected, where the worktree is, and whether the result reached the
remote:

```text
Created: origin/repo-plans, worktree at ~/.worktrees/acme/repo_plans, 3 namespaces (synchronized)
Added: README.md on repo-plans (synchronized)
Branch protection: protected (3 managed rulesets created)
```

Add a `GitHub agent identity:` line with the state step 5 found, for example
`GitHub agent identity: not set up (run roborepo git github setup in your own terminal)`.

The branch protection line is always present and names the state step 4 ended in:

```text
Branch protection: missing; you chose not to protect it now (run: roborepo protect)
Branch protection: missing; octo-reader is not an admin, so a repository admin must run roborepo protect
Branch protection: not checked (the GitHub CLI is not signed in)
```

When nothing was missing, report "Plan suite already initialized; no changes." with the branch
protection line. When `/plan-write` invoked this workflow, return to it.
