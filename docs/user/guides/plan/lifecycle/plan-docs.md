# Plan Docs Walkthrough

## Purpose

Plan Docs gives you one local place to browse repository planning documents and one command
workflow for keeping those plans current while agents do the work.

Use it when you want to:

- find active, backlog, completed, archived, or unclassified plans across local repositories
- copy a plan path or context into Claude/Codex
- enable `/plan-docs` workflows for creating, starting, syncing, validating, reviewing, or handing off work
- keep Markdown files as the source of truth instead of moving plans into a database

## What You Get

There are two pieces:

| Piece               | Always available? | What it does                                                                               |
| ------------------- | ----------------- | ------------------------------------------------------------------------------------------ |
| Plans page          | Yes               | Local `/plans` portal view for discovering, filtering, rendering, and copying plan context |
| Plan Docs workflows | Optional package  | Installs the `/plan-docs` slash command and workflow skill                                 |

The Plans page works even when the optional package is disabled. Enabling Plan Docs adds workflow
prompt buttons such as `/plan-docs start`, `/plan-docs sync`, `/plan-docs review`, and `/plan-docs handoff`.

## Typical Workflow

1. Run `roborepo web` and open `/plans`.
2. Add a discovery root.
3. Open a plan and check warnings, tasks, blockers, and review state.
4. Enable /plan-docs workflows if not already enabled.
5. Copy `/plan-docs start` for the chosen plan.
6. Let the agent verify the plan against the repo before changing files.
7. After work, copy `/plan-docs sync` or run `/plan-docs sync` directly.
8. Use `/plan-docs review` when you think the plan is complete.

## Open The Plans Page

Start the local portal:

```sh
roborepo web
```

Open:

```text
http://127.0.0.1:4317/plans
```

The page is local-only and uses the same loopback portal server as Config and Telemetry.

## Add Discovery Roots

A discovery root can be either:

- one repository, or
- a directory whose immediate children are repositories

Examples:

```text
~/projects
~/work/client-a
~/src/specific-repo
```

The scanner walks each root up to 6 levels deep and treats the first folder containing `.git` or
`docs/plans` as a repository. Inside each repository it reads:

```text
docs/plans/**/*.md
```

Hidden folders and common build folders (`node_modules`, `dist`, `build`, and similar) are skipped.
See [Discovery](../../../reference/plans-portal.md#discovery) for the exact limits.

## Plan File Layout

Plan lifecycle comes from folders:

```text
docs/plans/backlog/
docs/plans/active/
docs/plans/completed/
docs/plans/archived/
```

Files directly under `docs/plans/*.md` still appear, but they are shown as `unclassified`.
The portal does not silently treat them as backlog.

Recommended frontmatter:

```yaml
---
id: stable-plan-id
priority: high
next_action: Implement the next concrete task
blocked_by: []
depends_on: []
related: []
reviewed_commit:
worktree:
---
```

Leave `worktree:` empty. `plan-start` fills it with the linked worktree's Git administrative name
when implementation begins, which lets Home show the plan as that worktree's row. See
[Worktree association](../../../reference/plans-portal.md#worktree-association).

Use Markdown checkboxes for executable work:

```md
- [ ] Add the parser fixture
- [x] Define the schema
```

## Browse And Filter

The Plans page supports:

- search across title, ID, path, next action, blockers, repository name, and warnings
- repository, lifecycle, priority, blocked, readiness, review-state, and health filters
- lifecycle grouping: Active, Backlog, Completed, Archived, Unclassified
- document rendering with metadata, warnings, and task lists

Review state is conservative. `possibly-stale` means the repository changed after the plan's
`reviewed_commit`; it does not prove the plan's specific files are stale.

## Copy Actions

Without the optional package enabled, you can copy:

- repository-relative plan path
- raw Markdown
- repository-aware review context
- portable bounded context

After enabling Plan Docs workflows, you also get prompt buttons for:

```text
/plan-docs start
/plan-docs sync
/plan-docs validate
/plan-docs review
/plan-docs handoff
/plan-docs next
```

The browser copies prompts. It does not launch Claude or Codex.

## Enable /plan-docs Workflows

Enable from the Plans page, Config page, onboarding, or CLI:

```sh
roborepo package enable plan-docs
```

Then use:

```text
/plan-docs
```

With no mode, `/plan-docs` prints mode help. With a mode, it reads the relevant workflow reference
and works against repository files and Git state.

Common modes:

```text
/plan-docs create    create or revise a backlog plan
/plan-docs next      choose the next ready plan
/plan-docs start     move selected work into active and begin
/plan-docs sync      update a plan from completed session work
/plan-docs validate  check schema, lifecycle, and repo consistency
/plan-docs review    decide complete/incomplete/blocked/superseded
/plan-docs handoff   prepare a next-chat handoff
```

## Current Limits

- The portal edits plan files in only two ways: changing a plan's `priority`, and moving a plan
  between lifecycle folders. All other plan edits happen in your editor or through agent workflows.
- A move into a lifecycle whose requirements the plan does not meet is rejected with a list of
  what is missing. **Move anyway** files it regardless.
- Manual refresh is the v1 update model.
- No database, daemon, cloud sync, direct editor, or automatic LLM prioritization is included.

See [Plans Portal Reference](../../../reference/plans-portal.md) for exact behavior.
