---
id: harness-capability-derived-resource-targeting
priority: high
next_action: Verify Codex's PreToolUse decision schema against a live install, then implement per-command `ask` (Phase 5) — raised ahead of the schema work because it is a live security-relevant defect, not a scaling concern
blocked_by: []
depends_on:
  - discoverable-harness-provider-architecture
related:
  - gemini-cli-provider-integration
  - harness-parity-todo
reviewed_commit:
---

# Capability-Derived Resource Targeting

Package resources decide which harnesses receive them using four different conventions. Two of
them cannot accommodate a harness added after the resource was written. This plan replaces
author-time harness enumeration with capability-derived targeting plus an explicit opt-out.

## Summary

A `package.config.json` resource answers "which harnesses get this?" in one of four ways,
depending on its type. Registry-driven types ask the provider registry and scale automatically.
Enumerated and harness-welded types hardcode the answer and do not.

Gemini CLI is now a registered provider. It declares the `slash-commands` capability and supplies
a `commands` path, but receives zero slash commands, because seven packages name
`["claude", "codex"]` explicitly. Separately, Codex silently downgrades permission `ask` to a
session-wide approval policy.

Both are residue of the discoverable-harness-provider work: that effort converted **dispatch**
(core code loops the registry) but left **declaration** (how a package names its targets) on the
two-harness vocabulary it started with.

## Dependency Note

`discoverable-harness-provider-architecture` is already **completed**, so this plan is not
blocked — hence `depends_on` rather than `blocked_by`. The relationship is provenance: the
registry, provider manifests, and capability contract that plan delivered are the mechanism that
makes capability-derived targeting expressible. This plan finishes the half it did not reach.

## Current State

Verified against `feat/harness-provider-phase1`.

### Four targeting conventions across twelve resource types

| Group | Types | Mechanism | Survives a new provider? |
| --- | --- | --- | --- |
| Registry-driven | `skill`, `mcp`, `service`, `cli-command`, `package-runtime-asset` | Code maps over `listHarnessProviders()` | Yes |
| Sentinel | `rules` | `"both"` compared as a literal string | Yes |
| Enumerated | `slash-command`, `hooks`, `harness-config` | Explicit id or id list | **No** |
| Harness-welded | `permissions`, `plugin`, `codex_tool_approvals` | No targeting field exists | **No** |

### What works today

`"both"` is not a defect. `scripts/cli/rules-render.mjs` gates fragments with
`comp.harness !== "both" && comp.harness !== harness`, comparing a sentinel rather than expanding
a two-item list. All five packages using `"both"` render into Gemini's rules file correctly. The
word is misleading; the behavior is not. The schema offers no "all except X" form, so an author
wanting a rule everywhere but one harness must abandon the sentinel and enumerate.

Skills already demonstrate the target pattern:

```js
const HARNESS_SKILL_DIRS = listHarnessProviders()
  .map((provider) => resolveHarnessPath(provider.manifest, "skills"));
```

### Defect 1 — slash commands enumerate a closed pair

Seven packages carry `"harnesses": ["claude", "codex"]` on a skill entrypoint:
`case-study-pack`, `frontend-design`, `plan-write`, `technical-writing`, `telemetry`, `tighten`,
`session-close`.

All seven mean "everywhere this works." None expresses a deliberate restriction. The format cannot
distinguish the two, so the intent is unrecoverable by inspection.

### Defect 2 — Codex drops permission `ask`

`manifests/inventory/agent-permissions.json` ships `delete-files` bucketed `ask`. Claude Code
renders a real per-command prompt. `renderCodexRules` in
`scripts/harnesses/permissions-render.mjs` skips it:

```js
if (b.kind !== "commands" || b.bucket === "ask") continue;
```

No rule is emitted, then `codexApprovalPolicy` sets session-wide
`approval_policy = "on-request"` because an `ask` exists somewhere. One targeted guardrail becomes
a general one.

The `permctl` project established that Codex supports per-command `ask` through a `PreToolUse`
hook returning a decision for the specific command, per Codex's confirmed wire schema rather than
its documented one. The capability is known; roborepo's renderer predates the finding.

### Defect 3 — permissions and plugin write to a fixed harness

```js
mergePermissions(USER_CLAUDE_SETTINGS, component.allow);
```

The harness is the variable name, not a parameter. `plugin` behaves the same way.

## Goals

- A resource that names no harness installs wherever the required capability exists.
- Restriction is stated explicitly, so a manifest records that a decision was made.
- Adding a provider requires a registry change, not a package sweep.
- Codex `ask` produces a per-command prompt rather than a session-wide policy.

## Non-Goals

- Migrating provider config formats into one universal format (an explicit non-goal of the parent plan).
- Guaranteeing feature parity between harnesses.
- Reworking `codex_tool_approvals` or `plugin` into targetable types. Both are honestly
  harness-specific; renaming them is separate work.
- Adding `globals/system/rules/gemini/` content.

## Proposed Design

### Targeting resolution order

1. `excludeHarnesses` lists providers that must not receive the resource.
2. Otherwise the resource installs to every enabled provider declaring the required capability.
3. `requiredCapability` per resource type is already defined by `normalizeResource`'s
   `validateHarness` calls; reuse that mapping rather than introducing a second one.

```json
{ "type": "slash-command", "name": "session-close", "excludeHarnesses": ["gemini"] }
```

### Backward compatibility

`harness` and `harnesses` keep working through a deprecation window. `"both"` maps to "no
exclusions." An explicit list maps to its complement against the registry at load time, with a
validation warning naming the file, so migration is mechanical and visible.

### Codex `ask`

Port `permctl`'s hook approach: emit a `PreToolUse` hook that resolves the same rule list the
config writer uses and returns a per-command decision, falling through to `approval_policy` when
no rule matches. Confirm the wire schema against a live Codex install before implementing — the
comment at `permissions-render.mjs:122-124` asserts the opposite and must be corrected.

## Phase ordering note

**Phase 5 (Codex per-command `ask`) is the priority**, ahead of the schema work in Phases 1–4.
Defect 2 is a live guardrail failure: a rule bucketed `ask` becomes a session-wide approval policy,
which is a weaker protection than the manifest asks for. Phases 1–4 address a scaling annoyance —
real, but nothing is currently unsafe because of it.

**Phase 2 has been partly performed by hand.** `"gemini"` was added directly to the eight packages'
slash-command entrypoints to close a live parity gap (Gemini declared `slash-commands`, supplied a
`commands` path, and received zero commands). That is the manual version of what this plan
automates, so the defect is cleared but the cause is not: a fourth provider still needs eight more
hand-edits. The remaining Phase 2 work is the resolver and the deprecation of `harnesses`, not the
enumeration removal, which is now a one-line diff per package.

## Implementation Plan

### Phase 1 — Schema and validation

- [ ] Add `excludeHarnesses` to the resource schema in `scripts/cli/package-catalog.mjs`.
- [ ] Validate entries are known provider ids; reject unknown ids with the package and resource in the message.
- [ ] Add a resolver returning target providers for a resource, given the registry and required capability.
- [ ] Unit-test the resolver against a synthetic four-provider registry.

### Phase 2 — Migrate enumerated resources

- [ ] Route slash-command entrypoint targeting through the resolver.
- [ ] Remove `"harnesses": ["claude", "codex"]` from the seven packages.
- [ ] Verify Gemini receives all seven commands.
- [ ] Keep `harnesses` parsing with a deprecation warning.

### Phase 3 — Retire the `"both"` sentinel

- [ ] Route `rules` targeting through the resolver.
- [ ] Remove `"harness": "both"` from the five packages.
- [ ] Confirm rendered output is byte-identical for all three providers.
- [ ] Keep `"both"` parsing with a deprecation warning.

### Phase 4 — Unpin harness-welded writes

- [ ] Replace `USER_CLAUDE_SETTINGS` in `permissions` install/remove with resolver-driven targets.
- [ ] Route permission rendering through each provider's `permissions.render` adapter.
- [ ] Leave `plugin` pinned; record why in a comment.

### Phase 5 — Codex per-command `ask`

- [ ] Verify Codex's `PreToolUse` decision schema against a live install.
- [ ] Implement the hook; correct the two-state comment.
- [ ] Confirm `delete-files` prompts for `rm` specifically and `approval_policy` is unchanged for
      unrelated commands.

## Validation

- [ ] `roborepo doctor` passes.
- [ ] Full test suite passes.
- [ ] A synthetic fourth provider added to a test registry receives all non-excluded resources
      with no package edits. This is the plan's acceptance test.
- [ ] Rendered rules for claude/codex/gemini are unchanged after Phase 3.
- [ ] Gemini's commands directory contains all seven slash commands after Phase 2.
- [ ] Codex prompts for `rm` per-command after Phase 5.

## Open Decisions

- Whether to remove `harness`/`harnesses` parsing at the end of this plan or leave the deprecation
  window open into a later one.
- Whether `permissions` should gain `excludeHarnesses` in Phase 4 or stay implicitly universal
  until a package needs the distinction.
- Whether Gemini needs `globals/system/rules/gemini/` deltas. It currently runs on shared plus
  package rules only. Out of scope here; noted so it is not lost.

## Cleanup once this plan lands

Every site below exists only because targeting must be enumerated by hand today. When the resolver
is in place, none of them should name a harness at all — a resource with no `excludeHarnesses`
installs wherever the capability exists, so the explicit opt-in for Gemini becomes dead weight.
**Removing these is the acceptance test for Phase 2 and Phase 3**: if any still needs to name
Gemini afterwards, the resolver is not doing its job.

`"gemini"` was added to all eight slash-command entrypoints by hand to close a live parity gap
(Gemini declared `slash-commands`, supplied a `commands` path, and received zero commands). That
edit is the workaround this plan removes, not a decision to preserve.

**Explicit `harnesses` enumeration — 8 sites, all `["claude", "codex", "gemini"]`:**

| Package | Location |
| --- | --- |
| `case-study-pack` | `package.config.json:23` |
| `frontend-design` | `package.config.json:23` |
| `integration-check` | `package.config.json:23` |
| `plan-write` | `package.config.json:33` |
| `technical-writing` | `package.config.json:23` (multi-line array form) |
| `telemetry` | `package.config.json:37` |
| `tighten` | `package.config.json:23` |
| `session-close` | `package.config.json:23` |

**`"harness": "both"` sentinel — 5 sites**, retired in Phase 3: `impact-awareness`,
`convention-capture`, `caveman`, `skill-visibility`, `jcodemunch`.

Note that `"both"` already behaves correctly for a third provider — `rules-render.mjs` compares it
as a sentinel rather than expanding a two-item list — so these five are a naming cleanup, not a
defect. The eight above were the real gap.
