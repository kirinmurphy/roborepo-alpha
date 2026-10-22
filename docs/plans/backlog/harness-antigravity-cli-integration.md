---
id: antigravity-cli-provider-integration
priority: medium
next_action: Refresh authenticated native capability/path evidence, then agree targeting and provider-delivery contracts before migration implementation.
blocked_by: []
depends_on: ["harness-capability-derived-resource-targeting", "7k3m9qd"]
related: ["gemini-cli-provider-integration", "harness-capability-derived-resource-targeting", "discoverable-harness-provider-architecture"]
reviewed_commit: 57f8f2199b6db87d829af8d41e387800518024c9
---

# Antigravity CLI Provider Integration

## Summary

Migrate the registered Gemini integration to Antigravity after refreshing the native capability
evidence. The original investigation reported an authentication migration notice and different
skill/MCP/config locations. Those observations are historical and must be reproduced against
current supported accounts and versions before retiring a provider or changing delivered paths.

The previously selected direction is Antigravity-only rather than coexistence. Preserve that
decision, but confirm its applicability and ownership-safe migration requirements with current
evidence. Gemini remains registered in this checkout. Targeting and provider delivery must use
[[harness-capability-derived-resource-targeting]] and [[7k3m9qd]], not new platform storage branches.

## Current State

### Historical authentication observation

The original investigation recorded `gemini` 0.53.1 failing authentication:

```
Failed to sign in. This client is no longer supported for Gemini Code Assist for individuals.
To continue using Gemini, please migrate to the Antigravity suite of products.
```

The original investigation recorded `agy` 1.1.10 as a separate binary. Current installation,
authentication, supported distribution, and account migration scope must be checked again.

### Path comparison

Historical candidate locations below came from binary strings, documentation, and third-party
research. They are inputs to authenticated loading tests, not current runtime certification. The
original investigation was blocked by interactive OAuth; even rows labeled Works require refresh.

| Capability | roborepo writes today | `agy` reads | Status |
| --- | --- | --- | --- |
| `skills` | `~/.gemini/skills/` | `~/.gemini/config/skills/` | **Wrong** |
| `mcp` | `mcpServers` key inside `~/.gemini/settings.json` | `~/.gemini/config/mcp_config.json` | **Wrong** |
| `rootConfig` | `~/.gemini/settings.json` | `~/.gemini/antigravity-cli/settings.json` | **Wrong** |
| `rules` | `~/.gemini/GEMINI.md` | reads both `GEMINI.md` and `AGENTS.md` | Works |
| `commands` | `~/.gemini/commands/` | UNVERIFIED | Unknown |
| `permissions` | `~/.gemini/policies/*.toml` | `toolPermission` key in settings.json | **Likely wrong** |
| `hooks` | embedded in `~/.gemini/settings.json` | `hooks.json` (plugin-scoped) | **Likely wrong** |

Evidence for each confirmed row:

- **Binary strings** (`strings /usr/local/bin/agy`) contain `.gemini/antigravity-cli/settings.json`,
  `.gemini/config/mcp_config.json`, `.gemini/config/`, `.gemini/antigravity/artifacts`, and
  `.gemini/antigravity/transcript.jsonl`. They do **not** contain `.gemini/skills` or
  `.gemini/policies`.
- **Skills location** was established empirically by a third party who tested all four candidate
  paths across AGY, AGY CLI, and AGY IDE, and found `~/.gemini/config/skills/` the only one all
  three recognize. Workspace scope is `<workspace-root>/.agents/skills/`.
- **Rules** is the one capability that already works: `agy` reads `GEMINI.md` and `AGENTS.md`, so the
  rendered rules file is picked up with no change.

### Migration scope to re-inventory

The original investigation hypothesized that authentication failed without corrupting existing
artifacts, that the native base directory remained unchanged, and that provider metadata plus an
MCP storage adjustment would contain the change. Those are historical hypotheses, not verified
current invariants. Re-inventory native artifacts, package targeting/delivery, installer discovery,
cleanup, and doctor expectations against supported versions before deciding the migration scope.

## Goals

- Deliver every capability to a machine running `agy`, at paths it actually reads.
- Keep a coherent identity model: a user should be able to tell which harness is being managed.
- Do not silently break machines still running the old `gemini` CLI.
- Support verified native MCP delivery through provider adapters without platform-specific branches.

## Non-Goals

- Supporting the Antigravity IDE or SDK as separate harnesses. They share `~/.gemini/config/`, so
  correct CLI paths benefit them incidentally; modeling them is out of scope.
- Migrating existing `~/.gemini/skills/` content. Users who never authenticate to `agy` are
  unaffected, and a move is reversible.
- General native plugin-management UX or marketplace lifecycle. This plan may use a verified
  native plugin as the provider delivery unit through [[7k3m9qd]]; choosing that unit does not
  introduce a separate plugin-management product.

## Decision — retire `gemini`, register `antigravity`

**Settled 2026-08-04.** roborepo will support Antigravity CLI only. The `gemini` provider is
removed, not repointed, and a new `antigravity` provider is registered in its place:

```text
globals/harnesses/
  claude/
  codex/
  antigravity/     id: antigravity, commandName: agy
  gemini/          DELETED
```

Rationale: the id is the harness's identity throughout roborepo — state files, manifest rows, CLI
output, package `harnesses` arrays. Keeping `id: "gemini"` for a binary named `agy` would leave a
permanent misnomer in all of them to save a one-time rename. The old CLI is not being kept alive,
so nothing needs the `gemini` id.

The cost of retiring rather than repointing is a **cleanup story**: existing machines have roborepo
artifacts at paths the new provider no longer manages (`~/.gemini/skills/`, `~/.gemini/policies/`,
`~/.gemini/commands/`, `~/.gemini/GEMINI.md`, and the `mcpServers` key in `~/.gemini/settings.json`).
Removing a provider from the registry orphans them: no provider claims those paths, so no code
cleans them up and `doctor` stops checking them. This is covered in Phase 1 below and is the main
thing that makes this more than a rename.

The original research described a shared `~/.gemini` base with different artifact paths. Verify
that layout against current supported versions before planning cleanup; do not infer that every
existing artifact is valid or that migration is confined to a path rename.

## Proposed Design

Verify capability semantics first, select eligible resources through the targeting resolver, then
materialize them through the provider-delivery binding. A native plugin may combine skills, hooks,
MCP, and rules if current authenticated tests prove that is the supported unit. Keep package
resources semantic; do not make `plugin` the universal package model.

Any sidecar/root-config storage detail belongs in the provider adapter/delivery plan. Add a path or
adapter operation only when observed native loading requires it; do not add a new platform-wide
storage-mode branch merely to match an old path table. Unsupported permission/hook behavior must
remain explicit rather than emulated through unverified policy assumptions.

## Implementation Plan

### Phase 0 — Authenticated evidence

- [ ] Reproduce account migration/authentication behavior and record supported native versions.
- [ ] Verify skill, command/manual invocation, root config, MCP, global/workspace rules,
      permissions, and hook/plugin loading paths through actual resource use.
- [ ] Confirm whether native plugin delivery can combine semantic resources and report unsupported
      capabilities honestly; binary strings alone are insufficient.

### Phase 1 — Migration inventory and cleanup

- [ ] Re-inventory Gemini IDs across provider manifests/adapters, package declarations, generated
      artifacts, installer/discovery expectations, docs, and tests; do not rely on historical counts.
- [ ] Preview `roborepo harness withdraw gemini --dry-run` while the provider remains registered.
- [ ] Select ownership-marker-based cleanup for old managed files/symlinks and preserve all native
      user content. Define retry/idempotence and stale-cache behavior before retiring the provider.

### Phase 2 — Provider delivery

- [ ] Use the characterized delivery binding from [[7k3m9qd]] and target resolver from
      [[harness-capability-derived-resource-targeting]].
- [ ] Implement/register Antigravity with verified paths, capability declarations, discovery, and
      adapters; port reusable native logic only when its semantics match.
- [ ] Implement sidecar/plugin storage inside the provider boundary and test actual installed
      shapes. Retire Gemini-specific policy code only after capability coverage is established.
- [ ] Regenerate owned output and migrate package declarations without compatibility shims unless
      a real external contract requires one.

### Phase 3 — Platform and documentation acceptance

- [ ] Consume the shared Windows resolver/environment work where applicable; avoid adding another
      independent hardcoded provider switch.
- [ ] Exercise installed skill, rules, MCP, permission/hook, cleanup, repeat-apply, and withdrawal
      behavior with isolated fixtures and authenticated runtime checks for supported features.
- [ ] Update supported-harness tables and native limitations from the observed capability matrix.

## Validation

- `npm test` — `delivery-synthetic-provider-check.mjs` should pass **unmodified**. Needing to edit it
  means a fixed-provider assumption was reintroduced.
- `bash scripts/doctor.sh` — manifest validity, registry construction, capability/path coherence.
- `pwsh -File scripts/test/windows-installer-check.ps1` — harness-list parity.
- `roborepo harness inspect antigravity` — manifest and capabilities as roborepo sees them.
- Manual: run `agy` and confirm it loads a roborepo-delivered skill and the rendered rules.

## Risks

- **Paths are still moving.** Antigravity shipped recently; the community already documented one
  case where official docs named a skills path that does not work. Prefer empirical verification
  over docs, and record the evidence for each path in the manifest's comments.
- **Orphaned artifacts at retired paths.** Retiring `gemini` means no provider claims
  `~/.gemini/skills/`, `~/.gemini/policies/`, or `~/.gemini/commands/`, so nothing cleans them and
  `doctor` stops checking them. The 12 skill symlinks there point into the machine-local cache; if
  that cache is later pruned they become dangling with no check to catch it. Phase 1's cleanup pass
  is what closes this — do not skip it as cosmetic.
- **`withdraw` needs the provider present.** Run `harness withdraw gemini --dry-run` before deleting
  the provider directory, not after.
- **Plugin system may supersede loose files.** If Antigravity pushes toward plugin bundles as the
  supported extension path, per-capability file delivery could become the unsupported route. Worth
  a look during Phase 0 before investing in the loose-file approach.

## Sources

- `strings /usr/local/bin/agy` (Antigravity CLI 1.1.10) — authoritative for embedded paths
- [Antigravity CLI settings docs](https://antigravity.google/docs/cli/settings)
- [Antigravity CLI features docs](https://antigravity.google/docs/cli/features)
- [Where Antigravity Looks for Agent Skills](https://atamel.dev/posts/2026/07-01_where_agy_agent_skills/) — empirical skills-path testing
- [Configuring MCP Servers and Skills for Antigravity](https://medium.com/google-cloud/configuring-mcp-servers-and-skills-for-antigravity-cli-and-ide-a938c7eebb78)

## Current verification and delivery prerequisites

Gemini remains the registered provider in this checkout; retirement and Antigravity delivery have
not landed. The deprecation scope and native paths described above need fresh authenticated,
versioned evidence before migration; historical binary strings are not runtime loading proof.
Research can proceed now. Implementation should consume capability targeting and the characterized
provider-delivery contract from [[7k3m9qd]] rather than adding new storage-mode branches to platform
code. Preserve existing user content during retired-provider cleanup and test ownership boundaries.

## Documentation impact

`docs/user/guides/harnesses/supported-harnesses.md`, `docs/internal/harness-provider-interface.md`, and native hook/config references: verified Antigravity capability and migration behavior.
