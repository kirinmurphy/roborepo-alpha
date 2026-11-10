---
id: top-down-security-parity-review
priority: none
next_action:
blocked_by: []
depends_on: []
related: []
reviewed_commit:
---

# Top-Down Security, Parity, And Persistence Review

## Purpose

This review audits roborepo from the top down for security, Claude/Codex parity, user-content
preservation, update/uninstall correctness, and confusing behavior that could produce unintended
results.

The main conclusion: the repo has a strong intended model, but several live code paths do not fully
match it. The highest-risk gaps are in Codex permission enforcement, Codex root-config merge,
MCP registration/removal, and root-config drift bookkeeping after roborepo itself mutates live
config.

## Implementation Status

Addressed in this pass:

- Codex permission hook now fails closed with an `ask` decision if the permission manifest cannot be
  found after install, and tests cover installed-hook lookup through `install-state.json`.
- Codex root-config merge now preserves local top-level keys, local same-table keys, local
  same-table value edits, and local-only tables.
- JS root-config writes now share one helper that records root-config hashes only when doing so will
  not falsely mark pre-existing user drift as clean.
- Codex MCP add/apply/remove now targets active `~/.codex/config.toml`; package disable removes
  active Codex MCP blocks and Claude live-store entries without mutating the tracked MCP manifest.
- `repair` only repairs skill links for harness homes that already exist.
- The portal now requires a per-server mutation token for POST routes and sanitizes markdown links
  to HTTP(S), relative, or fragment URLs.
- Regression coverage was added to `scripts/test/test-roborepo.sh` plus focused checks for Codex
  MCP active config and Codex TOML root-config merge.

Decision log:

- Preserve user behavior over baseline overwrite when Codex TOML keys conflict during merge.
- Do not record a root-config hash after merging into an already-drifted user file; the merged file
  must remain drifted so later updates do not overwrite the user-owned slice.
- Keep Claude permission controls authoritative over the generated `permissions` object for now,
  but record the resulting root-config hash only when the file was clean before the write.

## Review Scope

Reviewed:

- install/update/repair/uninstall shell paths
- package enable/disable and onboarding paths
- shared skill cache and harness skill views
- root config merge, drift tracking, and uninstall restoration
- MCP add/apply/remove behavior
- permissions rendering and Codex runtime permission hook
- web portal server security surface
- generated rules and package rules layering
- docs claims where they affect supported behavior

## Executive Findings

### 1. Critical: Codex Runtime Permission Hook Cannot Find The Manifest After Install

`globals/codex/hooks.json` installs the permission hook as:

```json
"command": "node \"$HOME/.codex/hooks/permission-check.mjs\""
```

Evidence:

- `globals/codex/hooks.json:35-37`
- `globals/codex/hooks/permission-check.mjs:22-24`

`permission-check.mjs` derives `repoRoot` from its own installed location:

```js
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')
const manifestPath = path.join(repoRoot, 'manifests', 'inventory', 'agent-permissions.json')
```

Once copied to `~/.codex/hooks/permission-check.mjs`, that resolves near the user's home parent, not
the checkout. The manifest read then falls back to `{ behaviors: [], commands: { allow: [] } }`.
Result: the hook silently classifies no commands, so the promised Codex ask/deny/allow parity is not
actually active at runtime.

Impact:

- Security: Codex per-command deny/ask enforcement is weaker than documented.
- Parity: Claude renders real permissions; Codex hook fallback does nothing.
- Confusion: docs say the hook closes the Codex ask gap, but installed behavior likely does not.

Recommended fix:

- Do not derive repo root from copied hook path.
- Install a generated hook with a baked absolute repo path, or put the manifest snapshot under
  `~/.roborepo` and read from there.
- Add a test that copies the hook into a temp `HOME/.codex/hooks` path, feeds a `git push` payload,
  and expects a non-empty `permissionDecision`.

### 2. Critical: Codex Root Config Merge Drops User Content

`root-config-merge.mjs` preserves only local TOML table blocks whose header is absent from the repo
baseline.

Evidence:

- `scripts/cli/root-config-merge.mjs:77-115`
- `scripts/install/install-lib.sh:659-666`

The merge ignores:

- local top-level keys
- local changes to top-level keys
- local changes inside a repo-owned table

I verified this with a temp fixture: local `custom_top = "keep-me"`, local top-level `model`, and
local `[profiles.personal]` values were removed; only a wholly new `[profiles.extra]` table survived.

Impact:

- User-created Codex config can be overwritten during `export_user_config`.
- The log says "merged local root config preserved", but this is false for many normal TOML edits.
- This directly conflicts with the project goal of preserving user content across updates.

Recommended fix:

- Use a real TOML parser/serializer or switch to explicit conflict/stage for Codex root config when
  drift is detected.
- At minimum, preserve top-level local keys not owned by roborepo and detect same-table conflicts
  rather than replacing them.
- Add regression tests for top-level keys, same-table profile edits, MCP tables, and generated
  permission blocks.

### 3. Critical: Root-Config Drift State Is Not Updated After Many Roborepo-Owned Mutations

`record_root_config_write` is called by install export, but several other roborepo paths mutate
active root config without recording the new hash.

Evidence:

- Install export records writes: `scripts/install/install-lib.sh:659-666`
- Package enable writes active Claude/Codex config: `scripts/cli/packages.mjs:204-225`
- Permissions portal/onboard writes active config: `scripts/cli/permissions-render.mjs:216-235`
- Those paths do not call `recordWrite`.

Impact:

- A later `roborepo update` can treat roborepo's own previous mutation as user drift.
- A later `roborepo uninstall` can skip root-config cleanup because `remove_root_config` returns
  early on drifted files.
- This can leave roborepo-authored settings/hooks/permissions behind while `--check-clean` may not
  flag them after state deletion.

Recommended fix:

- Any code path that writes `~/.claude/settings.json` or `~/.codex/config.toml` as a roborepo action
  must call `recordWrite(harness, path)` after successful write.
- Add tests: enable package, then uninstall; portal permission change, then uninstall; Codex tool
  approval change, then update/uninstall.

### 4. High: `roborepo mcp add` Does Not Actually Apply Codex Live Config

`mcp add` writes Codex MCP config to repo baseline, not active `~/.codex/config.toml`.

Evidence:

- `scripts/cli/mcp-config.mjs:4-7`
- `scripts/cli/mcp-codex.mjs:36-59`
- `scripts/cli/mcp.mjs:85-90`

`CODEX_CONFIG_PATH` is `globals/codex/config.toml`, but the user-facing command claims to register
an MCP server with both harnesses. Claude gets a native `claude mcp add`; Codex only gets repo source
changed, which requires a later export/update before active Codex sees it.

Impact:

- Parity promise is broken.
- User can run a successful command and still have no Codex MCP server.
- It also edits tracked repo source as part of a user command, which is surprising for a consumer
  CLI.

Recommended fix:

- Write active Codex root config for the immediate effect, then update the portable manifest/source
  only if that is explicitly the intended machine policy.
- Record root-config hash after the active write.
- Make `mcp apply` apply both Claude and Codex from `manifests/inventory/mcp-servers.json`.

### 5. High: MCP Disable/Remove Is Not Symmetric With MCP Enable/Install

Package disable uses:

```js
spawnSync("claude", ["mcp", "remove", presetId])
```

Evidence:

- `scripts/cli/packages.mjs:344-352`
- Compare uninstall's all-scope cleanup: `scripts/install/uninstall.sh:271-321`

Problems:

- removes only Claude, not Codex
- does not remove all Claude scopes
- does not prune `~/.claude.json`
- does not update `manifests/inventory/mcp-servers.json`
- does not remove repo-baseline Codex MCP blocks

Impact:

- Disabling a package can leave active MCP servers behind.
- Update/reconcile can reintroduce behavior from stale manifest/source state.
- Uninstall is stronger than disable, so lifecycle semantics diverge.

Recommended fix:

- Share one MCP removal primitive between package disable and uninstall.
- Remove by recorded harness list.
- Add Codex active config removal and state/hash update.
- Add tests for enable-disable-enable and uninstall after disable.

### 6. High: `repair` Can Create Harness Skill Directories For Harnesses That Are Not Installed

`repair.sh` checks harness dirs for cleanup rows, but then unconditionally repairs skill links for
both harness homes.

Evidence:

- `scripts/install/repair.sh:132-136`
- `scripts/install/install-lib.sh:887-889`

`link_global_skills` creates/link targets under the supplied home. So `roborepo repair` on a
Codex-only or Claude-only machine can create `~/.claude/skills` or `~/.codex/skills`.

Impact:

- Creates unwanted artifacts.
- Can make a missing harness look partially installed.
- Violates the repo's "only touch present harnesses" pattern used by main install.

Recommended fix:

- Guard `repair_skill_links` with `[[ -d "$HOME/.claude" ]]` and `[[ -d "$HOME/.codex" ]]`.
- Add a repair test with only one harness home present.

### 7. Medium: Claude Permissions Renderer Replaces User Permissions Wholesale

`renderClaudeSettings` preserves other settings keys, but replaces the whole `permissions` object.

Evidence:

- `scripts/cli/permissions-render.mjs:206-209`
- `scripts/cli/permissions-render.mjs:224-235`

This matches the newer override-file model, but it can wipe manual permissions users added directly
to `~/.claude/settings.json`.

Impact:

- User-created settings can disappear when using portal/onboard permission controls.
- This is especially risky because Claude has no profile mechanism equivalent to Codex profiles.

Recommended fix:

- Either stage/flag manual permissions drift, or preserve unknown manual permission entries unless
  they are in a roborepo-owned generated block.
- Make docs explicitly say portal permission controls are authoritative over `permissions`.
- Prefer a managed permissions block if Claude supports that shape; otherwise preserve unknowns.

### 8. Medium: Package Component Parity Is Not Expressed In One Manifest-Aware Reversal Model

Package enable has many component types (`mcp`, `permissions`, `codex_tool_approvals`, `rules`,
`hooks`, `plugin`, `service`, `skill`). Disable reverses them with separate ad hoc code.

Evidence:

- Enable switch: `scripts/cli/packages.mjs:197-230`
- Disable switch begins at `scripts/cli/packages.mjs:354`

Risks seen during review:

- MCP reverse path is incomplete.
- Root-config hash is not updated after component writes.
- Hook merge/unmerge is Claude-only while Codex hooks are installed as managed copies/bundles.
- Package docs can claim parity while actual component wiring is harness-specific.

Recommended fix:

- Add a component lifecycle contract table: install/apply, update/reconcile, disable, uninstall,
  drift record, test.
- Tests should run each package through enable, disable, update, uninstall in a temp home and assert
  no unintended active remnants.

### 9. Medium: Portal Is Local-Only But Still Has A Local Mutation Surface

Good controls:

- binds to `127.0.0.1`
- rejects cross-origin browser POSTs
- JSON body size cap
- source reads are routed by whitelisted handlers

Evidence:

- `scripts/cli/portal-server.mjs:33-47`
- `scripts/cli/portal-server.mjs:60-75`
- `scripts/cli/portal-server.mjs:77-126`

Remaining risk:

- any same-user local process can POST mutations with no token
- no method/path CSRF token or random per-server secret
- markdown links escape HTML but do not appear to restrict URI schemes

Recommended fix:

- Add a random loopback session token for mutating routes, printed/embedded only in served HTML.
- Reject non-HTTP(S)/relative markdown link schemes or render them as text.
- Keep no-auth mode only if explicitly accepted as same-user local trust.

### 10. Medium: Docs Overstate Several Behaviors

Examples:

- Docs say root config collision policy preserves/stages; direct bash `export_user_config` always
  merges and writes.
- Docs say `mcp add` registers with both harnesses; Codex active config is not updated.
- Docs say Codex ask parity exists through hook; installed hook cannot find manifest.
- `jdocmunch` package rules are Claude-only, while Codex has a base SessionStart jdocmunch nudge.
  That may be intentional, but the package model does not clearly express the split.

Recommended fix:

- Update docs after code fixes.
- Add "supported behavior" assertions in tests so docs cannot drift without failures.

## Lower-Risk Observations

- Uninstall has better safety guards than package disable: content-matched deletes, harness-home
  assertions, managed-block removal, skill marker checks, and all-scope Claude MCP cleanup. Prefer
  reusing those primitives rather than maintaining separate JS removal logic.
- Rules rendering uses managed blocks and incomplete-block detection. This is a strong pattern and
  should be extended where possible.
- Skill cache markers are a good ownership boundary. The main weakness is lifecycle paths that call
  skill linking without harness-presence guards.
- Shell profile edits are backed up and idempotent. Uninstall removes exact managed lines/comments,
  which is appropriate.

## Suggested Fix Order

1. Fix installed Codex permission hook source-of-truth path and add runtime hook tests.
2. Stop lossy Codex root-config merge; replace with parser-backed merge or drift-stage behavior.
3. Add root-config hash recording to every roborepo-owned active config write.
4. Make MCP add/apply/remove update active configs for both harnesses and share removal logic.
5. Guard repair skill linking by harness presence.
6. Decide how portal permission controls treat manual Claude permissions, then document/test it.
7. Add package lifecycle tests covering enable, disable, update, uninstall, and `--check-clean`.

## Success Criteria

- A temp-home test proves Codex `permission-check.mjs` emits expected allow/deny/ask decisions after
  being installed under `~/.codex/hooks`.
- Codex root config merge preserves local top-level keys and local values for same-table conflicts.
- Any roborepo write to `settings.json` or `config.toml` updates root-config state.
- `roborepo mcp add` makes the server immediately visible to both active harnesses.
- `roborepo disable <mcp-package>` removes both active and managed MCP artifacts.
- `roborepo repair` does not create homes for missing harnesses.
- `roborepo uninstall --check-clean` catches any roborepo-authored active root-config remnants.
