---
id: nrvwti51
next_action: Run /plan-execute on this plan and start by connecting the Agents repo selector to a read-only inventory of the primary checkout.
blocked_by: []
depends_on: []
related: ["permva27"]
reviewed_commit: 26dad21f5948daee39c16d66299941b57d36d411
worktree:
---

# Inspect Repository Agent Configuration in the Portal

## Summary

Selecting a repo on the Agents page currently shows a placeholder. Replace it with a read-only view of the Claude Code and Codex files in that repo's primary local checkout. Developers can find instructions, skills, and configuration, including files that exist only on their machine.

## Goals

- Show the checkout path and current branch or detached HEAD alongside a Git status for each source.
- Make root and nested instructions and native skills easy to browse, with previews and individual token estimates.
- Locate project settings, hooks, MCP servers, custom agents, commands where supported, and permission sources. Use source summaries for configuration that can hold sensitive values.
- Reuse the global page's machine-wide harness status and controls in a labeled section. Show native repo files even when their harness is missing or disabled.
- Keep the inspector read-only and describe file presence and possible applicability. Effective runtime policy, precedence, import expansion, package management for repo skills, and other harness providers are outside this release.

## Current state

| Area | Behavior on the reviewed checkout |
| --- | --- |
| Page and filter | `/agents` is served from `portal/config/`. The scoped branch in `app.js` uses the shared selector and renders `repositorySplash` or the unavailable notice. The global page renders the harness warning, file grid, package sections, and permission controls from the global snapshot. |
| Machine data | `portal/config/api.js` loads the global snapshot and catalog-based source preview from `scripts/cli/portal-routes-config.mjs`. It re-exports the shared setup API, which reads `/api/settings` from `scripts/cli/portal-routes-settings.mjs`. There is no repo inventory. |
| Scope and checkout | `scripts/cli/portal-routes-scope.mjs` resolves the browser's `repo` key to a canonical repository ID. `modules/repositories/registry.mjs` owns registered local roots. `modules/repositories/identity.mjs` derives and verifies a main checkout from Git's common directory. The Plans checkout list does not populate the main checkout's branch. |
| Providers | `scripts/harnesses/registry.mjs` binds trusted built-in providers. The Claude and Codex adapters under `scripts/harnesses/` expose machine-oriented operations; there is no project inventory operation. `harness-runtime.mjs` filters its capability query by machine enablement. |
| Preview and estimates | `portal/config/panels.js` owns the source dialog and supports a plain-text branch. `scripts/cli/context-cost.mjs` exports `estimateTokens`, which can estimate a single file without using the global totals. |

## Happy path

1. Select a repo in the Agents **Viewing** menu and confirm the primary checkout and branch.
2. Open Instructions or Skills, select a path, and see a text preview, Git status, and individual token estimate.
3. Open Other configuration to see where settings, hooks, MCP servers, agents, commands, or permission settings are declared.
4. Switch repos or return to **All repos** using the same selector.

## Proposed design

### Scope and ownership

Resolve the scope on each inventory and preview request using the shared route helper. Read the primary designation from the registry record before resolving its local path. Resolve that checkout family through Git's common directory. For records without a primary designation, use a single verifiable family from the registered roots. If a designated primary checkout has no usable path, multiple roots are marked primary, or the family cannot be identified unambiguously, show a checkout-unavailable state. Avoid picking a secondary clone or linked worktree as a substitute. Read HEAD from the selected checkout and inspect its local files, including uncommitted changes. Keep absolute paths out of the selector, URL, and resource IDs. Show the selected checkout path in its scoped view.

Place the orchestration behind read-only GET handlers in `scripts/cli/portal-routes-config.mjs`. Give the provider contract a narrow optional project discovery operation. The built-in adapters identify native patterns and extract display metadata. Shared server code selects the checkout, bounds and confines file access, classifies Git status, and estimates tokens. Query supported provider bindings independently of machine installation and enablement. The portal renders the returned records without inferring native configuration paths.

### Inventory

| Area | Claude Code | Codex |
| --- | --- | --- |
| Instructions | Discover `CLAUDE.md`, `CLAUDE.local.md`, and project `.claude/rules/` Markdown where documented. Include `AGENTS.md` as a conditional Claude source where supported by the documented project-instructions setting. | Discover root and nested `AGENTS.md` and `AGENTS.override.md`. Mark override candidates and scope without computing which files load. |
| Skills | Discover `.claude/skills/<name>/SKILL.md` at the root and in supported nested locations. | Discover `.agents/skills/<name>/SKILL.md` at the root and in supported nested locations. Include `.codex/skills/<name>/SKILL.md` as a legacy location recognized by RoboRepo. Label its applicability unknown unless verified for the native version. |
| Other configuration | Inventory project `.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json`, and definitions under `.claude/agents/` and `.claude/commands/`. Identify hooks and permissions within their source settings. | Inventory project `.codex/config.toml`, `.codex/hooks.json`, and `.codex/agents/*.toml`. Identify supported inline hooks, MCP, and permission sections from their source. |

Confirm the patterns against the versions supported at implementation time. Group instructions by folder with root entries first, and show each resource's harness, kind, relative path, and a loading hint such as **Root-level**, **Potentially conditional**, or **Unknown**. For skills, show the name, description when present, source directory, and on-demand estimated token cost. Omit a repo-wide token total.

Use tracked, untracked, ignored, or unavailable for the file's Git status. Call out tracked local modifications when Git reports them. Provider support, installation, source applicability, and Git status are separate facts.

### Preview and failure behavior

- List and preview through the selected checkout only. Accept a server-validated inventory entry for preview, recheck it at read time, and exclude nested Git checkouts and out-of-scope paths. List discovered symlink sources as references without reading the targets. Leave imports as source text.
- Set limits on traversal depth, entries visited, files returned, bytes read, and preview size. Skip Git internals, dependency trees, and build outputs. Mark truncated inventories and isolate unreadable files and provider failures.
- Render instruction, skill, and Markdown agent or command bodies as text. Reuse the existing dialog shell and token chips, without rendering repo-supplied HTML or remote media.
- Show structured configuration using allowlisted labels and section names. For example, show hook event names and, where safe, MCP server names. Keep raw settings, commands, environment values, credentials, headers, and URLs from structured config out of the response and logs. If parsing fails, return a path and diagnostic.
- Show loading, empty, unsupported, checkout unavailable, and partial results distinctly. Close or clear the previous preview on a scope change and discard stale inventory and preview responses. Keep the existing unavailable-scope notice and the global editor in the global view.
- Use the hardened Git execution helper for local classification and keep optional locks disabled. Use queries that cannot invoke repo-configured subprocesses, including Git filters. If local modifications cannot be determined under that constraint, omit the modification label. Inspection leaves the checkout, Git metadata, and machine configuration untouched.

## Related plans

| Plan | Relationship to this work |
| --- | --- |
| Shared Repository Filter Across Portal Pages | Landed dependency. Squash commit `d25b89f0` is on the reviewed branch. This plan replaces its Agents placeholder and preserves selector, navigation, and unavailable-scope behavior. |
| Discoverable Harness Provider Architecture | Landed dependency. The trusted registry and adapter contract shipped in `42571fe3` and are present on the reviewed branch. Use their read-only extension point for native discovery. |
| Audit Global Agent Permissions Management | Unlanded, non-blocking follow-up. Its backlog plan expressly keeps the inspector independent. This plan displays native permission sources. |
| Permissions UI Revamp | Unlanded, adjacent global editor work that depends on the audit. The inspector shares the page but does not depend on the editor or its projection. |
| Capability-Derived Resource Targeting | Unlanded, adjacent package delivery work. Its enabled-provider targeting rules apply to package writes. Repo discovery is read-only and independent of those rules. |
| Cut Claude permission prompts by running shell commands in the native sandbox | In review. Its worktree tip `e5dcedd3` is outside the reviewed checkout. It changes machine-level projection and presentation, with no repository inventory or shared scope changes. |

## Implementation plan

- [ ] Add scoped inventory and preview reads. Reuse the shared scope resolver and registry checkout data. Cover a non-default branch, detached HEAD, an absent or pathless primary checkout, and a linked worktree or second clone with different files.
- [ ] Add Claude and Codex native discovery through the provider boundary. Cover disabled or missing harnesses, supported nested locations, recognized overrides, and unsupported providers.
- [ ] Add bounded file reads, source summaries, Git classification, and per-file estimates. Test outside-root references, symlinks, oversized files, malformed config, tracked modifications, ignored and untracked files, and a repo-configured process that must never run. Assert no file or Git metadata writes.
- [ ] Replace the scoped splash in `portal/config/app.js` using existing HTML templates, shared harness controls, and the source dialog shell. Add the folder-grouped instructions, skills, and configuration sections with explicit loading, empty, unsupported, and partial states.
- [ ] Extend the real-route coverage in `scripts/test/repository-scope-portal-check.mjs` and replace the splash expectation in `scripts/test/portal-ui/repository-scope.spec.mjs`. Cover switching repos while requests are pending, preview navigation, absence of package actions on repo skills and editing controls on repo permission sources, and return to global controls.
- [ ] Update the docs of record and run the focused checks below.

## Validation

- [ ] Selecting a repo shows files only from its primary checkout and labels the current branch or detached HEAD.
- [ ] A missing or ambiguous primary checkout cannot fall back to files from another checkout.
- [ ] Claude and Codex entries remain visible without an installed or enabled harness. Unsupported providers and failed or truncated scans are distinguishable from empty scans.
- [ ] Instruction and skill previews show source, Git status, and estimated size. Nested resources and skills contribute no startup aggregate.
- [ ] Other configuration shows source paths and safe metadata, with native permission sources described as declarations. Tests prove sensitive structured values never reach the browser.
- [ ] Switching scope while an inventory or preview is pending displays only the current scope's data. Global navigation and machine-wide controls still work.
- [ ] Scans and previews leave repo files, Git metadata, and machine config intact and execute no harness or hook.

Run the focused checks after implementation:

```sh
node scripts/test/run-checks.mjs --filter repository-scope
npm run test:portal-ui -- repository-scope.spec.mjs
```

Run the new provider and safety fixtures through `scripts/test/run-checks.mjs` as well. Capture the scoped Agents view with browser verification alongside the regression tests.

## Documentation impact

- `docs/user/reference/config-control-panel.md` for the repo inspector, source previews, and token estimates.
- `docs/internal/config-panel-internals.md` for the scoped endpoints, checkout selection, and preview constraints.
- `docs/internal/portal-architecture.md` for the Agents data owner and shared scope routing.
- `docs/internal/harness-provider-interface.md` for the discovery contract, with updates to `docs/internal/harness-anatomy.md` and `docs/internal/harnesses-explained.md` where they describe provider capabilities.

## Research references

- [Claude Code project instructions](https://code.claude.com/docs/en/memory), [settings](https://code.claude.com/docs/en/settings), and [skills](https://code.claude.com/docs/en/skills)
- [Codex instructions](https://developers.openai.com/codex/guides/agents-md), [configuration](https://developers.openai.com/codex/config-basic), [skills](https://developers.openai.com/codex/skills), [hooks](https://developers.openai.com/codex/hooks), and [custom agents](https://developers.openai.com/codex/subagents)
