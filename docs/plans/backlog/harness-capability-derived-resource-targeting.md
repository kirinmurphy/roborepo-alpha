---
id: harness-capability-derived-resource-targeting
priority: high
next_action: Inventory current resource targeting and restrictions, then implement one capability resolver while reusing the existing Codex permission hook and provider delivery boundary.
blocked_by: []
depends_on: []
related: ["discoverable-harness-provider-architecture", "gemini-cli-provider-integration", "7k3m9qd", "permva27", "permissions-ui-revamp"]
reviewed_commit: 57f8f2199b6db87d829af8d41e387800518024c9
---

# Capability-Derived Resource Targeting

## Summary

Replace author-time provider enumeration with capability-derived resource targeting and explicit
restrictions. Reconcile permission fidelity with the existing Codex hook rather than implementing
per-command prompting again.

## Context

Provider discovery/dispatch is registry-driven, but package declaration still mixes enumerated
`harnesses`, the `both` rules sentinel, and provider-specific resources. Package entrypoints such as
Plan Write already enumerate Claude, Codex, and Gemini; the old seven closed-pair count is stale.
A new provider can still require manual manifest updates.

`globals/harnesses/codex/hooks/permission-check.mjs` already emits per-command `ask` decisions. The
static renderer omits ask rules and provider metadata still declares `perCommandAsk: false`.
[[permva27]] owns verification of actual enforcement and [[permissions-ui-revamp]] consumes its
fidelity findings. Source implementation is not proof that every installed native runtime runs it.

## Goals

- Unrestricted resources reach every enabled provider with the required capability.
- Intentional restrictions are explicit and validated.
- A new provider needs registry/adapter work rather than a package sweep.
- Preserve provider-specific semantics and expose truthful enforcement support/readiness.

## Proposed design

Use one resolver over enabled providers and the resource's required semantic capability. Reuse the
catalog's capability mapping rather than inventing a second map. An exclusion list removes eligible
targets; reject unknown provider IDs with a package/resource-specific error. Keep genuinely native
plugin/tool-approval resources provider-specific rather than claiming they are portable.

```mermaid
flowchart LR
  Resource[Package resource] -->|resolve required capability| Eligible[Enabled capable providers]
  Eligible -->|apply explicit exclusions| Targets[Resolved targets]
  Targets -->|pass semantic resources| Delivery[Provider delivery binding]
```

[[7k3m9qd]] owns the delivery binding after target selection. Characterize existing output, choose
one current target syntax, migrate built-in declarations and readers together, and remove replaced
pre-launch syntax rather than adding an unrequested deprecation framework. If an actual external
compatibility requirement is discovered, bring that contract decision back before retaining aliases.

## Implementation plan

- [ ] Inventory current resource types, capability mapping, explicit restrictions, sentinels, and
      provider-specific writes; use current manifests rather than historical package counts.
- [ ] Define/validate capability-derived targeting and explicit exclusions in the package catalog.
- [ ] Test known/unknown/excluded/disabled and narrower-capability providers, including a synthetic
      fourth provider that needs no package edits.
- [ ] Route slash-command, hooks/config where semantically portable, and rules targets through the
      resolver; migrate existing explicit all-provider lists and the `both` sentinel.
- [ ] Route portable permission delivery through provider adapters; retain truly provider-specific
      resources explicitly and preserve ownership-safe remove behavior.
- [ ] Reconcile permission metadata through the global audit, retaining the implemented Codex hook
      and verifying installed readiness/native decisions rather than duplicating the hook.
- [ ] Keep resulting targets consumable by [[7k3m9qd]] without embedding provider storage in catalog
      normalization.

## Validation

The synthetic fourth-provider fixture receives every eligible non-excluded resource without package
edits. Explicit restrictions and disabled providers are preserved. Existing installed outputs remain
equivalent for semantically unchanged resources, and uninstall removes only owned artifacts. Run
catalog, provider, delivery, permission, and generated-output checks plus `npm run check` after
implementation. A live Codex ask check remains separate runtime evidence under [[permva27]].

## Documentation impact

Update `docs/internal/harness-provider-interface.md`, package-authoring guidance, and
`docs/internal/skills-and-commands.md` with current target syntax and provider-specific limits.

## Open questions

- Which resource restrictions express deliberate intent rather than historical enumeration?
- Which permissions are semantically portable, and which remain provider-owned native features?
