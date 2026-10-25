---
id: permissions-ui-revamp
priority: medium
next_action: Complete the global permissions audit and reconcile hook support, provider metadata, and readiness before selecting fidelity UI or collapsing file-operation controls.
blocked_by: []
depends_on: [permva27]
related: ["harness-capability-derived-resource-targeting", "codex-cmux-hook-trust-review", "ia1q1z9"]
reviewed_commit: 57f8f2199b6db87d829af8d41e387800518024c9
---

# Permissions UI Revamp

## Summary

Make permission intent and provider enforcement understandable in the portal, then evaluate a
simpler file-operation editor using the global permissions audit's findings.

## Context

`globals/harnesses/codex/hooks/permission-check.mjs` implements per-command `allow`, `deny`, and `ask`
decisions. The static rules renderer still omits `ask`, while
`globals/harnesses/codex/provider.json` declares `perCommandAsk: false`. Static output alone no
longer proves prompting is absent. Installed-hook readiness and native runtime behavior must be
verified before the UI promises enforcement.

`scripts/cli/config.mjs` already builds shared permission rows for the terminal and portal. Existing
YOURS/DEFAULTS grouping and `repo-scope` enforcement are the baseline. The audit [[permva27]] owns
native mappings and the retain/simplify/defer-to-native decision; this plan consumes its findings.

## Goals

- Show the actual mechanism, support, and readiness behind a requested permission bucket.
- Explain degradation or unknown enforcement instead of implying cross-provider uniformity.
- Keep editing consequences visible before apply.
- Simplify gate/scope controls only after proving the new representation preserves supported intent.

## Non-goals

Reimplementing Codex's permission hook, changing bucket vocabulary, or extending editing into
repository scope. [[harness-capability-derived-resource-targeting]] owns resource targeting.

## Proposed design

Derive fidelity from a provider-owned contract that reflects both native support and operational
readiness. Distinguish unsupported, unavailable hook, unverified runtime, and verified enforcement.
Do not encode “Codex cannot ask” as a permanent UI special case.

Evaluate one row per file operation against the current gate/scope representation. Keep the
underlying renderer/sandbox guarantees intact; a display simplification must not change tool
availability, scope, or approval behavior accidentally.

## Implementation plan

- [ ] Consume the global audit's supported/partial/stale/unknown mapping before choosing UI controls.
- [ ] Reconcile provider metadata with the implemented hook and verified native behavior.
- [ ] Add a provider-driven fidelity projection shared by CLI and portal.
- [ ] Present mechanism/readiness and explain genuine degradation or unknown behavior.
- [ ] Compare per-harness views with one intent plus fidelity details; choose after reviewing the
      audit rather than silently changing the public model.
- [ ] Characterize gate/scope combinations, `codexSandboxMode()`, and presets' behavior-row filter.
- [ ] If simplification preserves required intent, collapse file-operation rows while retaining
      internal rendering controls; otherwise document the combinations that must stay explicit.

## Validation

- [ ] `delete-files: ask` reflects verified hook behavior; a missing/inactive hook cannot appear
      as a verified per-command guardrail.
- [ ] Unsupported and unknown enforcement show distinct, actionable reasons.
- [ ] A synthetic provider receives fidelity through its contract, without a new UI branch.
- [ ] Editing and cancellation preserve existing bucket/scope behavior in CLI and portal.
- [ ] Gate/scope changes preserve sandbox rendering and onboarding rows under behavioral fixtures.
- [ ] Run relevant permission/config checks and browser coverage, then `npm run check` for an
      implemented permission-contract change.

## Documentation impact

Update `docs/user/reference/config-control-panel.md`, provider hook references, and
`docs/internal/config-panel-internals.md` with actual enforcement and editor semantics.

## Open questions

- Which controls should RoboRepo retain after the global audit?
- Should an unsupported intent be blocked or allowed with a warning?
- Which gate/scope states have distinct supported user intent and must remain representable?
- Should doctor expose intent-versus-enforcement discrepancies through the same projection?
