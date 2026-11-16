---
id: nrvwti51
next_action: Implementation is finished and validated; run /plan-review on this plan for the human review.
blocked_by: []
depends_on: []
related: ["permva27"]
reviewed_commit: 26dad21f5948daee39c16d66299941b57d36d411
worktree: agent-config-repository-inspector
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

- [x] Add scoped inventory and preview reads. Reuse the shared scope resolver and registry checkout data. Cover a non-default branch, detached HEAD, an absent or pathless primary checkout, and a linked worktree or second clone with different files.
- [x] Add Claude and Codex native discovery through the provider boundary. Cover disabled or missing harnesses, supported nested locations, recognized overrides, and unsupported providers.
- [x] Add bounded file reads, source summaries, Git classification, and per-file estimates. Test outside-root references, symlinks, oversized files, malformed config, tracked modifications, ignored and untracked files, and a repo-configured process that must never run. Assert no file or Git metadata writes.
- [x] Replace the scoped splash in `portal/config/app.js` using existing HTML templates, shared harness controls, and the source dialog shell. Add the folder-grouped instructions, skills, and configuration sections with explicit loading, empty, unsupported, and partial states.
- [x] Extend the real-route coverage in `scripts/test/repository-scope-portal-check.mjs` and replace the splash expectation in `scripts/test/portal-ui/repository-scope.spec.mjs`. Cover switching repos while requests are pending, preview navigation, absence of package actions on repo skills and editing controls on repo permission sources, and return to global controls.
- [x] Update the docs of record and run the focused checks below.

## Validation

- [x] Selecting a repo shows files only from its primary checkout and labels the current branch or detached HEAD.
- [x] A missing or ambiguous primary checkout cannot fall back to files from another checkout.
- [x] Claude and Codex entries remain visible without an installed or enabled harness. Unsupported providers and failed or truncated scans are distinguishable from empty scans.
- [x] Instruction and skill previews show source, Git status, and estimated size. Nested resources and skills contribute no startup aggregate.
- [x] Other configuration shows source paths and safe metadata, with native permission sources described as declarations. Tests prove sensitive structured values never reach the browser.
- [x] Switching scope while an inventory or preview is pending displays only the current scope's data. Global navigation and machine-wide controls still work.
- [x] Scans and previews leave repo files, Git metadata, and machine config intact and execute no harness or hook.

Run the focused checks after implementation:

```sh
node scripts/test/run-checks.mjs --filter repository-agent-config
node scripts/test/run-checks.mjs --filter repository-scope
npm run test:portal-ui -- repository-scope.spec.mjs
```

`--filter` matches by filename substring, so each filter selects a different set: `repository-agent-config` runs the new provider and safety fixtures in `repository-agent-config-check.mjs`, and `repository-scope` runs `repository-scope-check.mjs` and `repository-scope-portal-check.mjs`. Run all three commands. Capture the scoped Agents view with browser verification alongside the regression tests.

## Documentation impact

- `docs/user/reference/config-control-panel.md` for the repo inspector, source previews, and token estimates.
- `docs/internal/config-panel-internals.md` for the scoped endpoints, checkout selection, and preview constraints.
- `docs/internal/portal-architecture.md` for the Agents data owner and shared scope routing.
- `docs/internal/harness-provider-interface.md` for the discovery contract, with updates to `docs/internal/harness-anatomy.md` and `docs/internal/harnesses-explained.md` where they describe provider capabilities.

## Research references

- [Claude Code project instructions](https://code.claude.com/docs/en/memory), [settings](https://code.claude.com/docs/en/settings), and [skills](https://code.claude.com/docs/en/skills)
- [Codex instructions](https://developers.openai.com/codex/guides/agents-md), [configuration](https://developers.openai.com/codex/config-basic), [skills](https://developers.openai.com/codex/skills), [hooks](https://developers.openai.com/codex/hooks), and [custom agents](https://developers.openai.com/codex/subagents)

## Decision Log

- **Discovery is an optional adapter group, not a new capability.** Chose `projectInventory` in `OPTIONAL_ADAPTER_GROUPS` (validated when present) over adding a `project-inventory` capability. A capability would gate the feature on machine enablement through `providersFor`, which the plan forbids, and would force a stub on Gemini. `createHarnessRuntime().projectInventoryProviders()` returns every provider with its enablement instead.
- **Providers classify paths and describe text; shared code owns the disk.** Chose `classify(relPath)` plus `describe(entry, text)` over giving providers a file reader. Confinement, bounds, and symlink rules then live in one place.
- **Git status from `ls-files` and `check-attr`, modification from an in-process blob hash.** Rejected `git status` because it can run clean filters and an fsmonitor configured by the repo; rejected `git hash-object` because it applies filters too. When a conversion attribute is set or the file holds CR bytes, the modification label is omitted, as the plan allows. `ls-files` and `check-attr` were added to the hardened helper's read-only allowlist.
- **Branch from the `HEAD` file, with Git as a fallback for reftable.** The file read needs no subprocess; a reftable repo's placeholder (`refs/heads/.invalid`) falls back to `symbolic-ref` and `rev-parse` on the allowlist.
- **Non-Git checkouts are checkout-unavailable.** The plan resolves a checkout family through Git's common directory and repo identity requires Git, so a folder with no Git directory is not inspected.
- **Claude `AGENTS.md` is a potentially conditional entry.** Claude Code's memory docs say it reads `AGENTS.md` where no `CLAUDE.md`, `.claude/CLAUDE.md`, or `CLAUDE.local.md` is in the working directory or above it, and a "Project instructions" setting changes that. That meets the plan's condition, so `AGENTS.md` is listed for both harnesses. (First implemented as Codex-only; corrected after validation pass 1.)
- **Token level per file.** Root-level files use the startup thresholds, everything else the on-demand thresholds (`classifyStartupLevel` / `classifyOnDemandLevel`); there is no aggregate.
- **JSON parse errors report no location.** V8's message quotes source text, which can be a secret; this Node version's messages carry no numeric position either, so the diagnostic is just "Could not parse JSON."
- **Browser verification ran against an isolated state root with a copy of the repo list,** started from the shell because the preview launcher reads only the primary checkout's `.claude/launch.json`, which this worktree session may not edit.

## Not tested

- [ ] The repo inspector against a real Codex installation's reading of `.codex/skills/`. The view labels that location's loading as unknown; confirming it needs a Codex session in a repo that uses it.

## Review

### Findings

- [x] JSON parse diagnostics could quote a secret from a malformed settings file — fixed (ec24ffe4)
- [x] Previews accepted ids the walk excludes (`node_modules`, `.git` internals) — fixed (ec24ffe4)
- [x] A symlinked `SKILL.md` file was not listed as a reference — fixed (ec24ffe4)
- [x] The clean-filter trap targeted no discovered file, and the omitted-modification branch was untested — fixed (ec24ffe4)
- [x] `AGENTS.md` was missing as a conditional Claude source the plan requires — fixed (ec24ffe4)
- [x] Codex inline-table and dotted-key hooks and MCP servers were misreported — fixed (371e7e94)
- [x] Symlinked native folders vanished without a reference entry — fixed (371e7e94)
- [x] Symlink entries bypassed the file limit — fixed (371e7e94)
- [x] A reftable repo's branch read as ".invalid" — fixed (371e7e94)
- [x] A stale comment in the inventory loop and a misplaced template comment — fixed (371e7e94)
- [x] A vacuous contract assertion in the check — fixed (371e7e94)
- [x] No browser capture of the scoped Agents view in the evidence — captured (see Verification)
- [x] Text inside multi-line TOML values was read as keys, so a value could become a reported MCP server name — fixed (5b7519b0)
- [x] A case-variant preview id (`Node_Modules/...`) read a skipped folder on a case-insensitive filesystem — fixed (5b7519b0)
- [x] A file cut short by the byte budget was mislabeled and did not mark the scan partial — fixed (5b7519b0)
- [x] Quoted, literal, and spaced dotted TOML keys were not parsed, reopening the multi-line value leak — fixed (168e567f)
- [x] A Codex agent's name could come from text inside another value — fixed (168e567f)
- [x] An oversized structured config preview reported no sections instead of its size — fixed (168e567f)
- [x] The text preview limit counted characters, not bytes — fixed (168e567f)
- [x] The safe-name comment claimed secrets could not pass; it only keeps non-identifier text out — fixed (e5233532)
- [x] No browser test covered the checkout-unavailable splash and its way back — fixed (e5233532)
- [x] Symlinked `.claude/rules`, `.claude/agents`, `.claude/commands`, and `.codex/agents` folders produced no entry — fixed (692d3683)
- [x] A TOML line with an unparseable key skipped value tracking, so a following multi-line string was read as keys — fixed (692d3683)
- [x] An escaped quote in an inline-table string let value text surface as an MCP server name — fixed (4c11db18)
- [x] A TOML value never closed gave no diagnostic — fixed (4c11db18)
- [x] Symlinked subfolders inside rules, agents, and commands folders produced no entry — fixed (4c11db18)
- [x] Skills and commands named like build outputs (`build`, `vendor`, `out`) inside `.claude`, `.agents`, or `.codex` were silently skipped — fixed (641e32f9)
- [x] Two scope-selector comments still said Agents loads no repo data — fixed (641e32f9)

### Verification

- `node scripts/test/repository-agent-config-check.mjs` passed: checkout selection, Claude and Codex discovery, confinement, symlinks, limits, provider isolation, secrets, and a repo-configured clean filter, fsmonitor, and hook that never run, with the checkout and `.git` unchanged.
- `node scripts/test/repository-scope-portal-check.mjs` passed, including the new `/api/config/repository` routes.
- `npm run test:portal-ui -- repository-scope.spec.mjs`: 17 passed; `portal-ui.spec.mjs`: 99 passed.
- `node scripts/test/run-checks.mjs --filter harness`: 14/14 passed; `docs-reference-check.mjs` passed; `bash scripts/doctor.sh --quiet` passed (99 checks).
- `bash scripts/test/test-cli.sh --quiet`: 426 passed, 0 failed (at e5233532). An earlier run at the first commit reported 1 failure whose line was not captured; both later runs were clean.
- Validation loop: reached the eight-pass cap. Passes 1–8 ran as fresh-context subagents; each reported `fix` findings, all fixed above. Pass 8's fixes (641e32f9: build-named folders inside harness folders, two comments) were not revalidated by a further pass; they are covered by a new assertion in `repository-agent-config-check.mjs`.
- After pass 8 at 641e32f9: `repository-agent-config-check.mjs`, `repository-scope-portal-check.mjs`, `repository-scope.spec.mjs` (18 passed), `run-checks.mjs --filter harness` (14/14), `docs-reference-check.mjs`, `doctor.sh --quiet`, and `git diff --check` all passed.
- Browser (observed, not asserted): the scoped Agents view against this branch showed checkout path, branch, the three sections, the machine-wide grid, plain-text previews with config values withheld, no horizontal scroll at 375px, and the checkout-unavailable state. `roborepo browser run` was blocked: Playwright is not installed in RoboRepo's tool directory.
