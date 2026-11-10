---
id: plan-docs-and-plans-portal-plan
priority: none
next_action:
blocked_by: []
depends_on: []
related: [plans-portal-live-refresh-and-static-preflight]
reviewed_commit: b8684ef
---

# Plan Docs and Plans Portal Implementation Plan

## Status

**Complete.** The core of this plan shipped in `main`:

- Built-in Plans portal at `/plans` — `portal/plans/` (app.js, plan cards,
  filters, lifecycle dialogs, blockers popover, toast controller).
- Portable plan-domain module — `modules/plan-docs/` (`index.mjs`, `repair.mjs`).
- CLI adapter — `scripts/cli/plans.mjs`.
- Optional `plan-docs` package + unified skill —
  `globals/packages/plan-docs/` with `package.config.json` and
  `skills/plan-docs/references/*.md` (workflow-create/next/start/sync/validate/
  review/handoff, plan-schema, lifecycle, writing-guidelines, prompt-contracts).
- Reference docs — `docs/user/guides/plan-docs.md`, `docs/user/reference/plans-portal.md`.

The plan-domain model is isolated from portal/harness details, lifecycle is
folder-derived, the previous planning-doc skill and legacy slash command were
retired, and no database or standalone service was introduced — matching the
acceptance criteria below.

**Shipped beyond this plan's stated non-goals:** the plan declared the first
portal release would *not* mutate plan files. That boundary was later crossed —
the portal now moves plans between lifecycle folders and edits priority via
`POST /api/plans/lifecycle` and `POST /api/plans/priority`
(`portal/plans/api.js`, `modules/plan-docs/index.mjs::movePlanLifecycle` /
`updatePlanPriority`). See the shipped `plan-lifecycle-toggle-control` and
lifecycle-move work.

**Ancillary follow-up split out:** the two optional enhancements that were never
built — live refresh / SSE (Phase 6, `GET /api/plans/events`) and the static
no-argument slash-command preflight (Phase 4b) — plus the deferred-enhancements
list at the bottom, now live in
[`backlog/portal-plans-live-refresh.md`](../backlog/portal-plans-live-refresh.md).
The phase breakdown below describes the original plan as executed; consult the
follow-up for remaining optional scope.

## Summary

Add a first-class **Plans** page to the RoboRepo portal and an optional **Plan Docs** package.

The two layers share the same plan-document model but have different dependencies:

1. **Built-in Plans portal**
   - Always visible at `/plans`.
   - Scans repositories found under configured discovery roots for `docs/plans/**/*.md`.
   - Groups, filters, renders, and summarizes plan documents.
   - Works without installing an agent skill.
   - Remains primarily read-only in the first implementation.

2. **Optional `plan-docs` package**
   - Installs the `plan-docs` skill.
   - Exposes the `/plan-docs` slash-command entry point for Claude and Codex.
   - Adds agent workflows for creating, validating, prioritizing, starting, syncing, reviewing, completing, archiving, and handing off plans.
   - Unlocks workflow-specific copy actions on the Plans page.

The previous planning-doc skill and legacy planning slash command should be retired. Their reusable writing guidance should move into reference files inside the unified `plan-docs` skill. The implementation should not depend on skill chaining.

The Plans page is built into RoboRepo rather than loaded as a portal plugin. "Built in" means the
portal route, API handlers, static assets, navigation item, scanner, parser, and deterministic
validation logic ship as ordinary RoboRepo code, the same way Config and Telemetry do. The optional
package only installs agent-facing workflow affordances: the `plan-docs` skill and `/plan-docs`
slash command.

When the `plan-docs` package is disabled, the page remains useful and displays an option to enable
the workflow package.

---

## Dependencies

This plan assumes the package architecture defined by **Unified Package Configuration Plan** is implemented, or is implemented in parallel far enough to support:

- one `package.config.json` for `plan-docs`
- package-owned skill and slash-command metadata
- explicit package presentation category
- package enablement through the Config UI and existing package mutation flow
- generated Claude and Codex slash-command wrappers

The Plans portal itself is not dependent on the optional package and may be implemented before the package migration is completely finished.

Package unification cleanup has removed the legacy Project Context surfaces:

- `project-context`
- `/inventory`
- the `roborepo project-context ...` CLI
- related rules, manifests, docs, tests, and references

This plan does not use `project-context` as a foundation or migration source.

---

## Goals

### Portal goals

- Make plan documents easy to find across multiple local repositories.
- Provide a persistent, scannable view of active, backlog, completed, and archived plans.
- Keep Markdown files as the source of truth.
- Avoid a database in the initial implementation.
- Surface deterministic metadata such as lifecycle folder, priority, next action, blockers, review state, file modification time, and Git activity.
- Render plan Markdown safely in the existing local portal.
- Provide one-click copy actions for paths, context, and agent prompts.
- Show the Plans page even when the `plan-docs` package is disabled.
- Allow the user to enable `plan-docs` directly from the Plans page.
- Expose `plan-docs` as a normal package in `roborepo onboard` and the Config page, not only from
  the Plans page.

### Skill goals

- Replace the previous planning-doc skill with one cohesive `plan-docs` skill.
- Provide one explicit slash command:

  ```text
  /plan-docs
  ```

- Support named workflow modes:

  ```text
  /plan-docs create
  /plan-docs next
  /plan-docs start
  /plan-docs sync
  /plan-docs validate
  /plan-docs review
  /plan-docs handoff
  ```

- Keep generic planning-writing guidance reusable through internal skill reference files.
- Avoid requiring one skill to load another skill.
- Use repository files and Git state as evidence rather than assuming a plan is current or complete.
- Keep lifecycle transitions explicit and auditable through file movement.

### Architecture goals

- Separate portable plan-domain logic from RoboRepo portal and harness adapters.
- Reuse one scanner, parser, validation model, and prompt model across the page and skill documentation.
- Avoid building a generic portal-plugin framework solely for this feature. This means do not create
  a new extension system where packages can register arbitrary portal routes, frontend bundles,
  server APIs, lifecycle hooks, and navigation entries. Add `/plans` directly to the current portal
  routing/navigation code instead. A package-owned portal-extension framework can be revisited only
  when more than one feature needs that general mechanism.
- Keep the first version dependency-light and compatible with RoboRepo’s current Node-based
  architecture. This means prefer Node built-ins and the repo's existing portal/server utilities;
  do not add a database, daemon, frontend framework, bundler, file watcher service, or broad parser
  dependency unless the existing code cannot meet the requirement safely.

---

## Non-goals

The first implementation does not:

- create a cloud-hosted documentation service
- sync plan documents between machines
- add collaborative editing
- replace Git or Markdown with a database
- run an LLM automatically from the Plans page
- execute agent commands directly from the browser
- provide a full Markdown editor
- watch every file in every repository
- infer project priorities from private external systems
- make the optional package responsible for serving the portal
- add a separate background service or daemon
- implement a general package-driven portal-page extension API
- preserve the previous planning-doc skill as a second installed skill

---

## Product model

## 1. Plans page: always available

The RoboRepo portal navigation gains:

```text
Config
Plans
Telemetry
```

The page is registered directly in the current portal page registry and shared navigation.

The page works regardless of package state.

### Without `plan-docs` enabled

The page supports:

- discovery-root configuration
- plan discovery
- lifecycle grouping
- search and filtering
- document rendering
- deterministic validation indicators
- Git metadata
- copy file path
- copy document Markdown
- copy repository-aware context
- copy portable embedded context

The page also displays:

> **/plan-docs workflows are not enabled.**
> Browse and copy your planning documents now, or enable Plan Docs to add `/plan-docs` workflows for creating, prioritizing, starting, syncing, reviewing, and handing off work.

Action:

```text
Enable /plan-docs
```

The button delegates to the existing package mutation path.

### With `plan-docs` enabled

The page additionally shows workflow prompt actions such as:

```text
Copy /plan-docs start prompt
Copy /plan-docs sync prompt
Copy /plan-docs validate prompt
Copy /plan-docs review prompt
Copy /plan-docs handoff prompt
```

A cross-repository view may also offer:

```text
Copy /plan-docs next prompt
```

The browser copies prompts; it does not launch Claude or Codex directly in the initial implementation.

---

## 2. Plan Docs package: optional workflow

The package is presented in the explicit package category:

```json
{
  "presentation": {
    "category": "commands",
    "order": 40
  }
}
```

The package contains one installed skill with one skill-backed slash-command entry point.

Because it is a normal package, it must appear everywhere package behavior is managed:

- `roborepo onboard`
- Config page in `roborepo web`
- Plans page enable prompt
- `roborepo package list`
- `roborepo package inspect plan-docs`

The Plans page is an additional entry point for enabling the package, not the only one.

Illustrative configuration:

```json
{
  "schemaVersion": 1,
  "id": "plan-docs",
  "label": "Plan Docs",
  "description": "Create, manage, prioritize, review, and continue repository planning documents.",
  "lifecycle": "optional",
  "presentation": {
    "category": "commands",
    "order": 40
  },
  "requires": [],
  "resources": [
    {
      "type": "skill",
      "id": "plan-docs",
      "source": "skills/plan-docs",
      "invocation": "manual",
      "risk": "medium",
      "entrypoints": [
        {
          "type": "slash-command",
          "name": "plan-docs",
          "description": "Create, manage, review, and continue repository plan documents.",
          "harnesses": ["claude", "codex"]
        }
      ]
    }
  ]
}
```

The command wrapper remains thin. The `plan-docs` skill is the workflow source of truth.

### Default `/plan-docs` behavior

When the user invokes `/plan-docs` without a workflow mode, the command should produce a compact
workflow menu/help response instead of choosing a mode implicitly.

The response should list supported modes, one-line purpose text, and examples:

```text
/plan-docs create    create or revise a backlog plan
/plan-docs next      choose the next ready plan
/plan-docs start     move selected work into active and begin
/plan-docs sync      update a plan from completed session work
/plan-docs validate  check schema, lifecycle, and repo consistency
/plan-docs review    decide complete/incomplete/blocked/superseded
/plan-docs handoff   prepare a next-chat handoff
```

For slash-command wrappers, this help text may initially reach the agent runtime, so it can use a
small amount of model context.

The implementation plan should still track hook-only or non-LLM command help explicitly. The target
shape is a shared deterministic command preflight that can return static usage text for invocations
with no arguments, while mode-specific invocations still route to the agent workflow. Treat this as
shared command infrastructure, not a `plan-docs`-only special case, if Claude and Codex can both
support it reliably.

---

## Skill structure

```text
globals/packages/plan-docs/
  package.config.json
  skills/
    plan-docs/
      SKILL.md
      agents/
        openai.yaml
      references/
        plan-schema.md
        lifecycle.md
        writing-guidelines.md
        workflow-create.md
        workflow-next.md
        workflow-start.md
        workflow-sync.md
        workflow-validate.md
        workflow-review.md
        workflow-handoff.md
        prompt-contracts.md
```

Optional deterministic helper scripts may be added later under:

```text
skills/plan-docs/scripts/
```

The skill should use progressive disclosure:

- `SKILL.md` defines triggers, mode selection, safety boundaries, and the common workflow.
- Reference files contain detailed writing rules and mode-specific procedures.
- The skill reads only the references needed for the requested mode.

---

## Consolidating the previous planning-doc skill

The previous planning-doc skill should not remain as a second installed skill.

Move its useful guidance into `plan-docs` references:

```text
previous planning-doc concepts
  → plan-docs/references/writing-guidelines.md
  → plan-docs/references/workflow-create.md
  → plan-docs/references/workflow-validate.md
```

Preserve useful principles such as:

- distinguish facts, recommendations, risks, and open questions
- write for a developer who did not participate in the original conversation
- keep TODO plans focused on unresolved work
- use stable repository-relative paths
- verify claims against source code, tests, configuration, and runtime evidence
- separate current behavior from proposed behavior
- avoid documenting completed work as if it remains pending
- organize multiple documents by reader purpose
- use iterative validation for substantial plans

Remove:

- the previous planning-doc skill registration
- the legacy planning slash command
- generated command wrappers
- onboarding and Config UI references
- README and maintainer documentation that presents it as a separate workflow
- tests specific to the old skill/command identity

No skill-chain dependency is needed.

---

## Plan document layout

Plan lifecycle is represented by directories rather than a `status` frontmatter field.

Target repository layout:

```text
docs/
  plans/
    backlog/
      ...
    active/
      ...
    completed/
      ...
    archived/
      ...
```

### `backlog`

The work is proposed, planned, or waiting to be selected.

A backlog plan may be:

- draft
- structurally ready
- blocked
- low priority
- superseded later

Readiness and blockers are separate from lifecycle.

### `active`

The work has been selected and is currently underway.

An active plan should have:

- remaining actionable work
- a concrete next action
- current implementation context
- success criteria
- any blockers recorded

### `completed`

The plan’s success criteria have been met.

A completed plan should have:

- no unresolved implementation TODOs
- evidence that implementation and relevant documentation agree
- verification results or a clear explanation of what could not be verified
- a completion summary
- no misleading “next action”

### `archived`

The plan is no longer active because it was:

- abandoned
- replaced
- merged into another plan
- made obsolete
- retained only for historical context

Archived does not mean completed.

---

## Derived plan conditions

The portal and skill derive conditions independently from lifecycle.

### Readiness

```text
draft
ready
```

A plan is `ready` when it contains the minimum sections and metadata needed to begin work. The
minimum is determined by validation rules in the shared plan-domain module, not by subjective model
judgment.

Otherwise it is `draft`.

Readiness is computed; it is not stored in frontmatter.

### Blocking

```text
blocked
unblocked
```

Blocking is derived from `blocked_by`.

A blocked plan may remain in either `backlog` or `active`.

Blocking is not a lifecycle folder because temporary blockers do not change the plan’s broader lifecycle.

### Repository review state

```text
never-reviewed
current
possibly-stale
unknown
```

Repository review state is derived by comparing `reviewed_commit` with repository Git state.

In the first implementation, any commit after `reviewed_commit` means only that the repository has
changed since review. It does not prove that files related to the plan changed. UI copy should say
`possibly-stale` or equivalent rather than overstating certainty.

### Completion consistency

A plan in `completed` should be flagged if it still contains:

- unchecked actionable tasks
- unresolved required decisions
- a non-empty next action
- explicit blockers
- success criteria that are not marked or evidenced as satisfied

These flags are warnings for review, not automatic file movements.

---

## Root-level plan files

Files directly under:

```text
docs/plans/*.md
```

should be displayed as:

```text
unclassified
```

The page should not silently treat them as backlog.

The portal and `/plan-docs validate` should recommend moving them into one of the four lifecycle folders.

This allows existing repositories to appear immediately while establishing an explicit final structure.

Permanent plan creation workflows should always write into a lifecycle folder.

---

## Frontmatter

Lifecycle is not stored in frontmatter.

Recommended minimal schema:

```yaml
---
id: unified-package-config
priority: high
next_action: Implement package catalog discovery
blocked_by: []
depends_on: []
related: []
reviewed_commit:
---
```

### Required fields for a managed plan

#### `id`

A stable repository-local identifier.

Rules:

- lowercase slug
- unique within the repository
- does not change when the file moves between lifecycle folders
- used for dependencies and portal identity

#### `priority`

Allowed values:

```text
high
medium
low
none
```

`none` is the default if omitted during legacy discovery, but new managed plans should include it.

#### `next_action`

A short concrete action.

Required for `ready` backlog plans and active plans.

Should be empty or absent for completed and archived plans.

### Optional fields

#### `blocked_by`

An array of blocker descriptions or stable plan IDs.

#### `depends_on`

An array of stable plan IDs.

#### `related`

An array of stable plan IDs or repository-relative document paths.

#### `reviewed_commit`

The repository commit against which the plan was last deliberately reviewed.

An empty value means never reviewed.

### Fields not included initially

Do not add these until a concrete need appears:

- `status`
- `validated`
- `updated_at`
- `created_at`
- `owner`
- `percent_complete`
- `estimated_hours`
- `tags`

Git and filesystem metadata already provide modification timestamps. Stored booleans such as `validated: true` become stale without carrying evidence.

---

## Markdown structure

A managed technical plan should generally contain:

```markdown
# Plan title

## Summary

## Context

## Goals

## Non-goals

## Current state

## Proposed design

## Implementation plan

## Validation

## Risks

## Open questions
```

Not every plan requires every section.

### Minimum readiness sections

To be considered `ready`, a backlog or active plan should contain:

- one H1 title
- Summary
- Goals or clear desired outcome
- Current state or context
- Proposed design or implementation approach
- Implementation plan with at least one actionable item
- Validation or acceptance criteria
- a non-empty `next_action`
- frontmatter `id`
- frontmatter `priority`

The validator should permit alternate headings through a normalized heading map rather than requiring exact capitalization.

The readiness validator should report which required item is missing. It should not silently infer
readiness from prose length or overall document quality.

---

## Task representation

Use Markdown checkboxes for executable work:

```markdown
- [ ] Add package catalog loader
- [ ] Add duplicate ownership validation
- [x] Define package schema
```

Checkboxes are the deterministic source for:

- remaining task count
- completion ratio
- unresolved implementation work
- task-level copy actions

Do not create a separate task database.

Nested task items remain part of the containing plan.

---

## Portable core architecture

Create a small plan-domain module that does not depend on browser code, portal routing, Claude paths, or Codex paths.

Suggested layout:

```text
modules/
  plan-docs/
    index.mjs
    model.mjs
    discover.mjs
    parse-frontmatter.mjs
    parse-markdown.mjs
    validate.mjs
    lifecycle.mjs
    git-metadata.mjs
    prompts.mjs
    cache.mjs
    adapters/
      filesystem.mjs
      git-cli.mjs
```

RoboRepo adapters:

```text
scripts/
  cli/
    plans.mjs
  portal/
    plans/
      index.html
      styles.css
      app.js
```

The module should expose plain functions and plain data.

Illustrative interface:

```js
discoverRepositories(roots, options);
discoverPlans(repositories, options);
readPlan(planRef);
parsePlan(markdown, context);
validatePlan(plan);
buildPlanIndex(plans);
buildPrompt(action, selection, options);
movePlan(planRef, lifecycle);
```

The initial portal should not call `movePlan`; lifecycle movement remains an agent workflow. Keeping the function boundary available allows future direct management without rewriting the domain model.

---

## Plan record model

Illustrative normalized record:

```js
{
  repository: {
    id: "roborepo",
    name: "roborepo",
    root: "/Users/example/projects/roborepo",
    gitHead: "abc123",
    gitAvailable: true
  },
  plan: {
    id: "unified-package-config",
    title: "Unified Package Configuration",
    relativePath: "docs/plans/active/unified-package-config.md",
    lifecycle: "active",
    readiness: "ready",
    priority: "high",
    nextAction: "Implement package catalog discovery",
    blockers: [],
    dependencies: [],
    related: [],
    reviewedCommit: "def456",
    reviewState: "possibly-stale",
    modifiedAt: "2026-07-16T...",
    gitLastChangedAt: "2026-07-15T...",
    taskCounts: {
      total: 18,
      complete: 5,
      remaining: 13
    },
    validation: {
      valid: true,
      warnings: []
    },
    excerpt: "..."
  }
}
```

The browser should receive repository-relative paths for display and stable opaque IDs for API requests. It should not send arbitrary absolute file paths back to the server.

Configured discovery roots grant discovery scope only. They do not grant a general file-read API.
After discovery, browser requests must address plans through server-issued plan keys. The server
must reject arbitrary file paths even when they are under a configured discovery root.

---

## Configured discovery roots

The page needs one or more local discovery roots. A discovery root may be either:

- a repository itself, or
- a directory whose immediate children are repositories

State file location should be resolved from RoboRepo's existing `stateRoot`, not hard-coded to a
home-directory path:

```js
path.join(stateRoot, "plan-docs", "settings.json");
```

This preserves package-mode and test overrides such as `ROBOREPO_STATE_ROOT`.

Illustrative content:

```json
{
  "schemaVersion": 1,
  "discoveryRoots": ["~/projects", "~/work", "~/src/specific-repo"],
  "ignoredDirectories": ["node_modules", ".git", "vendor", "dist", "build"]
}
```

`discoveryRoots` are intentionally bounded. Each root is inspected directly and then scanned one
level deep:

```text
~/src/specific-repo/docs/plans
~/projects/*/docs/plans
~/work/*/docs/plans
```

For example:

```text
~/projects/repo1/docs/plans
~/projects/repo2/docs/plans
~/work/repo3/docs/plans
~/work/repo4/docs/plans
```

If a user selects a repository directly, that repository must work without requiring the parent
directory to be configured.

### Initial resolution order

1. Saved `discoveryRoots` in `path.join(stateRoot, "plan-docs", "settings.json")`.
2. `ROBOREPO_PLAN_ROOTS` environment variable, when present, interpreted as a path-delimited list
   of discovery roots.
3. No implicit broad home-directory scan.

The page should never recursively scan the entire home directory by default.

### Empty state

When no roots are configured:

> No discovery roots configured. Add a repository or a directory that contains repositories.

The page accepts a server-local filesystem path through a protected POST request.

The server should normalize `~`, resolve the path, verify it is a readable directory, and save the normalized user-facing form.

---

## Repository discovery

For each configured discovery root:

1. Inspect the root itself.
2. Treat the root as a candidate repository when it contains either:
   - `.git`, or
   - `docs/plans`
3. Inspect immediate child directories only.
4. Treat a child as a candidate repository when it contains either:
   - `.git`, or
   - `docs/plans`
5. Do not recursively descend arbitrary nested project trees in the initial implementation.
6. Allow future discovery roots to point at more deeply nested grouping directories.

The scanner searches candidate repositories for:

```text
docs/plans/**/*.md
```

It ignores:

- hidden temporary files
- editor swap files
- generated backups
- symlink targets that escape the discovered repository boundary
- files over a configured size limit

Recommended initial document size limit:

```text
1 MiB
```

Oversized files remain listed with a warning but are not fully rendered or embedded in prompts.

### Scan cost controls

The scanner should avoid open-ended file traversal:

- only inspect immediate children of each `discoveryRoot`
- skip hidden child directories unless explicitly configured as discovery roots
- treat `.git` and `docs/plans` as cheap candidate checks before any glob
- once a candidate repo is found, only scan `docs/plans/**/*.md`
- cap candidate repositories per refresh and report truncation when exceeded
- cap plan files per repository and report truncation when exceeded
- cache repository discovery by parent directory mtime where practical
- cache parsed plan files by path, size, and mtime
- batch Git calls per repository

This means scanning `~/projects` with many sibling repos costs roughly one directory listing plus
two existence checks per child, not a recursive search across every file in every repo.

---

## Frontmatter parsing

RoboRepo currently favors minimal dependencies. The first implementation may support a strict YAML-compatible subset rather than a general YAML language.

Supported forms:

```yaml
key: scalar
key: []
key:
  - item
  - item
```

Supported scalar types:

- strings
- empty values
- recognized enum strings

Supported array forms:

- empty inline arrays: `key: []`
- block lists of scalar items

Other inline arrays are deferred unless a full YAML parser is adopted.

Unsupported advanced YAML should produce a clear validation warning rather than being interpreted unpredictably.

The parser must:

- preserve the original Markdown
- report line-level frontmatter errors
- reject duplicate keys
- validate IDs and enums
- normalize arrays
- avoid arbitrary object construction or code execution

Adding a mature YAML dependency is acceptable only if the project explicitly decides that correctness is worth changing the dependency policy.

---

## Git metadata

For each repository with Git available, collect:

- current HEAD
- current branch when available
- last commit affecting each plan file
- whether the plan file is modified or untracked
- whether `reviewed_commit` is an ancestor of or equal to HEAD
- whether repository changes occurred after `reviewed_commit`

Git calls should be batched per repository where practical.

The portal should not claim that a plan is stale merely because HEAD differs. Instead:

- `current`: `reviewed_commit` equals HEAD
- `possibly-stale`: `reviewed_commit` is an ancestor of HEAD and later commits exist
- `unknown`: commit is unavailable, missing, or not in current history
- `never-reviewed`: no `reviewed_commit`

A later enhancement may compare changed paths against plan-related paths, but the first implementation should use the simpler repository-level review-state signal.

Repositories without Git remain fully browsable with Git fields omitted.

---

## Index and caching

No database is required.

Maintain an in-memory index while the portal server is running.

Cache parsed plans by:

```text
absolute path
file size
mtime
```

On a cache hit, reuse parsed frontmatter, headings, tasks, and excerpt.

Read full Markdown on demand for document rendering and portable prompt generation.

Persist only:

- configured discovery roots
- portal feature settings

Do not persist a second copy of plan contents.

---

## Live refresh

Use a staged implementation.

### Initial release

- manual Refresh button
- refresh after discovery-root configuration changes
- refresh after package enablement
- optional periodic rescan while the Plans page is open

### Follow-up within the same project

- watch discovered `docs/plans` directories
- debounce file events
- rescan only affected repositories
- expose server-sent events:

  ```text
  GET /api/plans/events
  ```

- update the page without a full reload

Because recursive `fs.watch` behavior differs across platforms, watch each discovered plans directory explicitly and retain a slower periodic root-discovery fallback.

No standalone daemon is needed. Watchers exist only while the RoboRepo portal process runs.

---

## Portal routes

Add the page to the portal’s server-side page list:

```text
/plans
```

Add the same route to the shared navigation list.

Suggested API routes:

```text
GET  /api/plans
GET  /api/plans/document
GET  /api/plans/events
POST /api/plans/prompt
POST /api/plans/settings
POST /api/plans/refresh
```

The existing package mutation endpoint continues to handle enabling `plan-docs`.

### `GET /api/plans`

Returns the normalized plan index and package state.

Query options may include:

```text
repository
lifecycle
priority
blocked
readiness
search
```

### `GET /api/plans/document`

Accepts a server-issued plan key rather than an arbitrary path.

Returns:

- plan metadata
- raw Markdown
- rendered HTML
- validation results
- Git metadata

### `POST /api/plans/prompt`

Accepts:

- action
- selected plan keys
- prompt mode

Use `POST` rather than query parameters because generated prompts may contain large or sensitive
plan context. The request body should contain server-issued plan keys only, never arbitrary file
paths.

Prompt modes:

```text
repository-aware
portable
```

### `POST /api/plans/settings`

Updates configured discovery roots.

Requires the existing portal mutation token and loopback-origin checks.

### `POST /api/plans/refresh`

Triggers a deterministic rescan.

Requires the portal mutation token.

### `GET /api/plans/events`

Optional SSE endpoint for live index updates.

---

## Portal interface

## Overview

Top controls:

- search
- repository filter
- lifecycle filter
- priority filter
- blocked filter
- readiness filter
- review-state filter
- Refresh
- Configure discovery roots

Primary grouping:

```text
Active
Backlog
Completed
Archived
Unclassified
```

Within each group, support grouping by repository.

### Plan card

Each plan card should show:

- title
- repository
- relative path
- lifecycle
- readiness
- priority
- next action
- blocker count
- remaining task count
- review state
- modified date
- last Git activity when available
- validation warning count

### Document view

The document page or drawer should show:

- rendered Markdown
- table of contents
- raw path
- metadata
- tasks
- validation results
- Git state
- related plans
- copy actions

---

## Sorting

Default ordering:

1. lifecycle group
2. blocked active items first only when the user is looking for issues, not for next work
3. priority:
   - high
   - medium
   - low
   - none
4. active before backlog in combined views
5. most recently modified
6. title

For “next work” candidates, use:

1. unblocked
2. ready
3. priority
4. dependency satisfaction
5. longest waiting or least recently touched as a tiebreaker

The portal should label this as deterministic ordering, not an AI recommendation.

---

## Copy actions

## Always available

### Copy path

```text
docs/plans/active/unified-package-config.md
```

### Copy repository-aware context

Example:

```text
Review the plan at `docs/plans/active/unified-package-config.md` in this repository.

Focus on:
- the current next action
- unresolved tasks
- blockers
- whether the plan still matches the implementation

Do not assume the document is current. Verify relevant claims against the repository.
```

### Copy portable context

Includes:

- repository name
- relative path
- metadata
- a bounded document excerpt or selected sections
- explicit instruction to request more context when needed

Portable prompts must respect a maximum size and clearly note omitted sections.

---

## Package-enabled workflow actions

### Create

```text
/plan-docs create

Create a managed plan for: <user-entered objective>
Place it in `docs/plans/backlog/`.
```

### Next

Build a prompt from the visible or selected candidate set:

```text
/plan-docs next

Review these candidate plans and recommend the next work:
<compact plan summaries>
```

The skill verifies repository context before making a final recommendation.

### Start

```text
/plan-docs start

Start plan `unified-package-config` at
`docs/plans/backlog/unified-package-config.md`.

Verify the plan against the current repository, move it to `active/` if appropriate,
then begin the next actionable task.
```

### Sync

```text
/plan-docs sync

Update `docs/plans/active/unified-package-config.md` to match the work completed in
this session. Preserve unresolved work, remove obsolete TODOs, update the next
action, and do not mark the plan complete without verification.
```

### Validate

```text
/plan-docs validate

Validate `docs/plans/active/unified-package-config.md` for schema, readiness,
internal consistency, actionable tasks, lifecycle-folder fit, and repository accuracy.
```

### Review

```text
/plan-docs review

Review whether `docs/plans/active/unified-package-config.md` is complete.
Verify implementation and tests. Move it to `completed/` only when its success
criteria are satisfied; otherwise update the remaining work and next action.
```

### Handoff

```text
/plan-docs handoff

Create a concise next-chat handoff for
`docs/plans/active/unified-package-config.md`, grounded in the current repository
and the plan's remaining tasks.
```

---

## Skill workflow contracts

## Common rules

Every mode should:

1. Resolve the repository root.
2. Locate `docs/plans`.
3. Read the requested plan or discover candidate plans.
4. Parse frontmatter and lifecycle folder.
5. Verify material claims against current repository evidence.
6. Preserve stable plan ID.
7. Keep lifecycle transitions explicit.
8. Report files changed.
9. Report validation performed.
10. State uncertainty rather than inventing completion evidence.

The skill should not:

- rewrite unrelated documents
- silently move a plan between lifecycle folders
- mark work complete based only on checked boxes
- treat old handoff text as current evidence
- add speculative tasks without labeling them
- use machine-specific absolute paths inside repository documents

---

## `create` workflow

1. Understand the desired outcome.
2. Inspect relevant repository code and documentation.
3. Determine whether an existing plan already owns the work.
4. Create or revise one plan rather than duplicating scope.
5. Generate a stable ID.
6. Write into `docs/plans/backlog/`.
7. Add minimal frontmatter.
8. Use the generic writing guidance.
9. Validate readiness.
10. Leave a concrete next action.

If the work is too vague to be implementation-ready, create a draft backlog plan and explicitly identify missing decisions.

---

## `next` workflow

Default scope:

- current repository

Optional scope:

- candidate summaries supplied by the portal

Procedure:

1. Exclude completed and archived plans.
2. Identify blockers and dependencies.
3. Distinguish ready plans from drafts.
4. Compare priorities and next actions.
5. Verify that top candidates still match repository reality.
6. Recommend one primary next action.
7. Explain why it outranks alternatives.
8. Identify blockers or prerequisite decisions.
9. Do not start implementation unless explicitly requested or invoked through `start`.

---

## `start` workflow

1. Resolve the selected plan.
2. Validate that it is not completed or archived.
3. Verify the current plan against the repository.
4. Update obsolete context before implementation.
5. Confirm dependencies and blockers.
6. Move from `backlog/` to `active/` when work is genuinely beginning.
7. Preserve the stable ID.
8. Update links or references affected by the move when necessary.
9. Begin the plan’s next actionable task.
10. Run the smallest relevant verification.

A plan already in `active/` is not moved again.

---

## `sync` workflow

1. Inspect changes from the current session or requested scope.
2. Compare the plan with actual implementation.
3. Mark completed tasks only when evidence supports them.
4. Remove or rewrite obsolete tasks.
5. Add newly discovered required work.
6. Update `next_action`.
7. Update blockers and dependencies.
8. Keep the plan active unless completion criteria are verified.
9. Update `reviewed_commit` only when the plan has been deliberately reviewed against the relevant repository state.
10. Summarize changes to the plan.

---

## `validate` workflow

Validation layers:

### Schema

- lifecycle folder recognized
- required frontmatter valid
- stable ID unique
- enums valid
- arrays normalized

### Document structure

- title present
- summary present
- implementation path understandable
- validation or acceptance criteria present
- actionable task structure present when appropriate

### Lifecycle consistency

- active plans have remaining work and next action
- completed plans have no unresolved required work
- archived plans explain supersession or abandonment
- unclassified root documents are flagged

### Repository consistency

- referenced paths exist when expected
- current-state claims are supported
- commands or tests named by the plan exist
- completed claims match code and verification evidence

### Relationship consistency

- dependency IDs resolve
- no self-dependency
- cycles are reported
- completed dependencies are distinguished from unresolved dependencies

The mode reports findings and applies fixes only when the user requested changes or the command contract explicitly includes safe normalization.

---

## `review` workflow

1. Read the complete plan.
2. Identify its success criteria.
3. Inspect relevant implementation changes.
4. Run targeted verification.
5. Check documentation consistency.
6. Determine:
   - complete
   - incomplete
   - blocked
   - superseded
7. If complete:
   - clear `next_action`
   - resolve remaining required tasks
   - add completion summary
   - update review evidence
   - move to `completed/`
8. If incomplete:
   - keep or move to `active/`
   - update remaining tasks
   - set next action
9. If superseded or abandoned:
   - record reason
   - move to `archived/`
10. Report evidence and lifecycle transition.

---

## `handoff` workflow

Produce a paste-ready continuation prompt containing:

- repository
- plan path and stable ID
- current objective
- work completed
- remaining tasks
- next action
- blockers
- relevant files
- verification already run
- instructions to re-check repository state rather than trusting the handoff blindly

Do not copy the entire plan unless required.

---

## Relationship with `/wrap-up`

The initial implementation should not make `/wrap-up` depend on skill chaining.

Recommended behavior:

- `/plan-docs sync` owns deliberate plan synchronization.
- `/wrap-up` continues to own session review, general documentation sync, commit, and handoff.
- The Plans page may provide a combined copy prompt instructing an agent to run plan sync before wrap-up.
- Future integration may add a shared deterministic plan-discovery helper, but `wrap-up` should not require the optional `plan-docs` package.

This keeps both packages independently usable.

---

## Portal/package state integration

The Plans API response should include:

```js
{
  planDocsPackage: {
    available: true,
    enabled: false,
    status: "disabled"
  }
}
```

The page should derive package state from the same normalized package catalog used by Config and onboarding.

It should not inspect skill symlinks independently.

When enabling from the Plans page:

1. POST to the existing package mutation endpoint.
2. Re-read the plan snapshot.
3. Show installation status.
4. Reveal workflow copy actions only when package state is enabled.
5. Surface partial or blocked package state with the underlying component issue.

This behavior is not specific to `plan-docs`. It should be the shared package-toggle contract for
any portal page that exposes an optional package:

- mutate through the existing package endpoint
- refresh the page-specific snapshot after mutation
- gate package-owned actions on normalized package state
- show `partial`, `blocked`, and `external` with the underlying resource status

The Plans page should reuse that shared contract rather than creating a one-off enablement path.

---

## Security

The portal remains loopback-only.

### Path safety

- accept configured discovery roots only through protected POST requests
- resolve real paths
- reject files outside discovered repository boundaries
- do not expose arbitrary file-read endpoints
- use server-issued plan keys
- reject symlink traversal outside repository boundaries
- redact absolute repository roots from portable prompts unless explicitly requested

### Browser safety

- reuse existing origin checks
- reuse the per-server mutation token
- escape all metadata
- render Markdown through the existing safe renderer
- do not execute document HTML or scripts
- apply response size limits

### File mutation

The first portal release does not directly edit, move, or delete plan files.

Agent workflows perform those operations under normal harness permissions.

---

## Performance

Initial targets:

- scan configured discovery roots without traversing dependency directories
- display the first index within a few seconds for a typical personal project directory
- cache unchanged files
- read full Markdown only on document open or portable prompt generation
- batch Git calls by repository
- debounce refresh events
- avoid embedding entire large plans in list responses

Suggested index response fields should remain compact.

---

## Error handling

The page should display partial results when possible.

Examples:

- one unreadable repository does not block all repositories
- invalid frontmatter displays the file with a validation error
- unavailable Git displays no Git metadata
- oversized documents remain discoverable
- duplicate IDs show all conflicting files
- missing dependencies appear as relationship warnings
- watcher failure falls back to manual refresh

The page should include an Errors or Warnings filter.

---

## Implementation phases

## Phase 0: prerequisites and cleanup boundaries

- Confirm package unification interfaces needed by `plan-docs`.
- Confirm `/plans` remains built-in and independent.
- Confirm package presentation category is `commands`.
- Confirm lifecycle folder names.
- Confirm the previous planning-doc skill will be replaced, not chained.
- Treat `project-context` removal as already completed by package unification cleanup.

Deliverable:

- accepted interfaces and path layout

---

## Phase 1: discovery state, scanner, and parser

Implement:

- settings path based on `stateRoot`
- configured discovery roots
- direct-root repository discovery
- shallow child repository discovery
- plan file discovery
- strict path boundary checks
- server-issued plan keys
- strict frontmatter parser
- Markdown heading and checkbox extraction
- lifecycle path detection
- normalized plan record

Tests:

- stateRoot override fixtures
- direct-root repository fixtures
- shallow parent-directory fixtures
- parser fixtures
- lifecycle fixtures
- path traversal fixtures
- arbitrary-path rejection fixtures

Deliverable:

- deterministic discovery and parsing module with no portal dependency

---

## Phase 2: plan validation and index

Implement:

- plan validation
- stable ID validation
- dependency resolution
- Git metadata
- repository review state
- plan index
- sorting and filtering
- partial-error reporting
- parse cache

Tests:

- multiple repositories
- non-Git directories
- invalid plans
- duplicate IDs
- unclassified root plans
- completed-plan inconsistency
- possibly-stale review detection

Deliverable:

- deterministic plan index API in Node

---

## Phase 3: built-in Plans portal

Implement:

- `/plans` page registration
- shared navigation entry
- page HTML/CSS/JS
- plan API routes
- root configuration
- filters
- grouped plan cards
- document rendering
- copy path and context actions
- manual refresh
- disabled-package banner

Tests:

- route registration
- API path safety
- empty state
- package-disabled state
- document rendering
- filter behavior
- mutation-token requirements for settings

Deliverable:

- useful Plans page without `plan-docs`

---

## Phase 4: `plan-docs` package and skill

Implement:

- package directory
- `package.config.json`
- unified `plan-docs` skill
- skill reference files
- generated `/plan-docs` wrappers
- default `/plan-docs` help text
- package presentation in Commands
- package enable/disable behavior
- trigger tests
- source inspection support

Migrate:

- reusable technical planning guidance
- relevant documentation examples

Remove:

- the previous planning-doc skill
- the legacy planning slash command
- old registrations and generated outputs

Deliverable:

- optional package usable independently from the portal

---

## Phase 4b: optional static slash-command preflight

Evaluate whether Claude and Codex can support deterministic no-argument command help without routing
through the agent runtime.

Implement only if both harnesses can support the behavior cleanly:

- a shared command preflight layer for package-owned slash commands
- static usage text for no-argument invocations
- normal agent routing for invocations with workflow modes or arguments
- tests for `plan-docs` and at least one other command-family fixture

This is intentionally shared infrastructure. If only one harness supports it, or if the behavior
requires brittle hook-specific workarounds, keep the first release's agent-routed help and leave this
phase deferred.

Deliverable:

- no-token static help where harness support is reliable, or a documented deferral with the reason

---

## Phase 5: package-enabled portal workflows

Implement:

- package state in Plans API
- Enable /plan-docs button
- workflow prompt builder
- plan-level workflow actions
- task-level start prompts
- cross-repository next prompt
- repository-aware and portable prompt modes
- prompt size limits

Tests:

- enable flow
- partial package state
- prompt generation
- package-disabled action hiding
- portable prompt truncation

Deliverable:

- integrated viewer and optional workflow experience

---

## Phase 6: live refresh

Implement:

- directory watchers
- debounce
- repository-scoped rescans
- SSE endpoint
- browser updates
- periodic discovery fallback
- watcher cleanup on portal shutdown

Tests:

- file addition
- file modification
- lifecycle move
- watcher failure fallback
- SSE reconnection

Deliverable:

- near-real-time plan updates while portal runs

---

## Phase 7: documentation and verification

Update:

- portal documentation
- CLI/package documentation
- skills and slash-command documentation
- onboarding descriptions
- Config UI descriptions
- package creation examples
- plan schema reference
- lifecycle reference
- troubleshooting guide

Verify:

- no references to the legacy planning slash command
- no installed previous planning-doc skill
- `/plans` works with package disabled
- `/plan-docs` works with portal closed
- package enablement reveals workflow actions
- no database introduced
- no direct plan file mutation from the initial portal
- all targeted tests pass
- `roborepo doctor` and `roborepo verify` pass

---

## Testing strategy

### Unit tests

- frontmatter parser
- lifecycle detection
- readiness derivation
- blocking derivation
- completion consistency
- task extraction
- Git review-state derivation
- prompt generation
- path safety
- cache invalidation

### Integration tests

- scan a fixture discovery root
- scan multiple repositories
- render a document
- configure discovery roots
- enable the package
- generate a start prompt
- generate a cross-repository next prompt
- update after a plan file changes
- preserve operation when one file is malformed

### Skill tests

Expected triggers:

- “create a technical implementation plan”
- “what plan should I work on next?”
- “start the selected plan”
- “sync this plan with what we just changed”
- “review whether this plan is complete”
- explicit `/plan-docs`

Near misses:

- casual request for a short unordered checklist
- explanation of what a plan is
- ordinary code implementation with no planning-document request
- request to browse plans without agent management

### End-to-end verification

1. Start portal with no configured discovery roots.
2. Add a discovery root.
3. Confirm plans appear.
4. Open and render a plan.
5. Confirm lifecycle and validation metadata.
6. Confirm package-disabled banner.
7. Enable `plan-docs`.
8. Confirm generated skill links and slash commands.
9. Confirm workflow buttons appear.
10. Copy a start prompt.
11. Run `/plan-docs start` in a fixture repository.
12. Confirm file moves from backlog to active.
13. Confirm stable ID remains unchanged.
14. Refresh portal and confirm new lifecycle.
15. Run review workflow and targeted tests.
16. Confirm completed movement only after evidence.
17. Disable package and confirm viewer remains usable.

---

## Migration of existing plan documents

The scanner should expose current documents immediately, including:

```text
docs/plans/*.md
docs/plans/completed/*.md
```

Migration workflow:

1. Discover all existing plan documents.
2. Assign or validate stable IDs.
3. Move root plans to `backlog/` or `active/` based on current evidence.
4. Preserve existing completed plans in `completed/`.
5. Create `archived/` when needed.
6. Remove any stored `status` field that duplicates folder lifecycle.
7. Add only necessary frontmatter.
8. Validate links and plan relationships.
9. Commit file moves separately from large prose rewrites when practical.

The portal should show unclassified files before migration rather than hiding them.

---

## Risks and mitigations

### Risk: one skill becomes too large

Mitigation:

- keep `SKILL.md` concise
- split mode details into references
- load references progressively
- use one shared schema and lifecycle reference

### Risk: frontmatter becomes cluttered

Mitigation:

- no stored status
- no stored validation boolean
- minimal required fields
- derive timestamps and lifecycle
- defer tags, owners, and estimates

### Risk: path-based lifecycle moves break references

Mitigation:

- require stable plan IDs
- use IDs for dependencies
- detect stale repository-relative links
- have `start` and `review` check references during moves

### Risk: scanning many repositories is slow

Mitigation:

- shallow discovery-root discovery
- file cache
- compact index
- batched Git calls
- read documents on demand
- configurable discovery roots rather than whole-home scanning

### Risk: portal and skill behavior drift

Mitigation:

- keep schema and lifecycle in one domain module/reference model
- generate prompts from deterministic portal data
- add shared fixtures
- test the same lifecycle examples in both layers

### Risk: package disabled state is confusing

Mitigation:

- always identify the viewer as available
- call the optional feature “Plan Docs workflows”
- clearly distinguish browsing from agent management
- provide one-click enablement

### Risk: `/wrap-up` duplicates plan sync

Mitigation:

- leave the workflows independent initially
- provide a combined copy prompt
- do not add hidden skill chaining
- revisit only after observed usage

---

## Acceptance criteria

The implementation is complete when:

- `/plans` is always present in portal navigation
- the Plans page works with `plan-docs` disabled
- users can configure one or more discovery roots
- the scanner discovers `docs/plans/**/*.md`
- lifecycle is derived from folders
- root-level plan files are shown as unclassified
- no `status` frontmatter field is required
- readiness, blockers, review state, and completion consistency are derived
- plan Markdown renders safely
- plan cards show next action, priority, tasks, blockers, and Git review state
- repository-aware and portable copy actions work
- the optional `plan-docs` package installs one unified skill
- `/plan-docs` is generated for Claude and Codex
- the previous planning-doc skill and legacy planning slash command are removed
- package-enabled workflow buttons appear on the Plans page
- disabling the package removes workflow availability but not the viewer
- no database or separate service is required
- the portal does not directly mutate plan files in the initial release
- the core plan model is isolated from portal and harness details
- live refresh works or cleanly falls back to manual refresh
- tests cover scanner, parser, validation, package state, prompts, and security
- RoboRepo doctor and verify succeed

---

## Deferred enhancements

- direct Markdown editing
- direct lifecycle move buttons
- task checkbox updates from the browser
- plan templates
- per-repository `.plan-docs.json` configuration
- deeper nested repository discovery
- cross-repository dependency graphs
- automatic LLM prioritization inside the portal
- direct launch into Claude or Codex sessions
- links to GitHub issues and pull requests
- remote synchronization
- collaborative access
- package-provided portal pages
- static slash-command help preflight if harness support is incomplete in the first release
- long-running background indexing service
