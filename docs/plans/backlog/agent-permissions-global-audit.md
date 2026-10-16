---
id: permva27
priority: medium
next_action: Inventory the current global /agents permissions UI and provider projections, then compare them against supported Claude Code and Codex native permission and sandbox controls.
blocked_by: []
depends_on: []
related: [nrvwti51]
reviewed_commit:
worktree:
---

# Audit Global Agent Permissions Management

## Summary

Determine whether RoboRepo's existing machine-wide permissions management still behaves correctly and provides meaningful value alongside modern Claude Code and Codex native permissions, approvals, trust, and sandboxing. **Investigate first; do not assume RoboRepo should continue owning permission management.**

This is a separate, non-blocking follow-up to the repository configuration inspector (`nrvwti51`). That feature only displays native permission configuration sources; it must not extend the global editor into repository scope.

## Problem

RoboRepo's global editor uses simplified permission buckets and projects settings into harness-native configuration. Native harness models have evolved and differ in security behavior. It is unclear which UI controls still work, which are partial or misleading, and whether maintaining cross-harness permission editing is worth the complexity and security risk.

## Goals

1. Document what the current global permissions UI claims to control, and exactly which native settings it writes.
2. Verify behavior against currently supported Claude Code and Codex versions, distinguishing static configuration from actual runtime enforcement.
3. Identify stale, ambiguous, ineffective, or unsafe controls and labels.
4. Recommend a product direction: **retain**, **simplify**, **link to native harness management**, or **retire** the custom editor.
5. Produce bounded remediation tasks or a separate implementation plan only after evidence supports the decision.

## Non-goals

- Implementing a replacement permissions abstraction during the audit.
- Adding repository-level permission editing.
- Simulating comprehensive runtime security policy or evaluating every historical harness version.
- Creating backward-compatibility layers for obsolete permission profiles without a demonstrated need.

## Research and validation

- [ ] Locate current global permissions UI controls, data model, writes, and harness adapters.
- [ ] List the user-facing promises and their native Claude/Codex mappings.
- [ ] Check supported native versions, configuration locations, precedence, sandbox/approval/trust modes, and managed-policy restrictions.
- [ ] Exercise representative safe test cases to determine whether each projected setting is honored, partially honored, overridden, or unsupported; never rely on parsing alone as proof of runtime effect.
- [ ] Classify existing controls as **supported**, **partial**, **stale**, or **unknown**, with brief evidence and risk severity.
- [ ] Recommend retain/simplify/defer-to-native/retire, including what belongs in RoboRepo UI versus harness-native tools.
- [ ] Open focused follow-up remediation tasks or a new implementation plan; avoid coupling remediation to the repository inspector.

## Acceptance criteria

- [ ] Every current global permissions control has a documented native mapping and confidence level for Claude Code/Codex, or is explicitly marked unsupported/unknown.
- [ ] Security-sensitive or misleading claims are called out for priority correction.
- [ ] The recommendation explicitly compares the cost/risk of maintaining RoboRepo-managed policies with delegating to native harness tooling.
- [ ] Findings and next actions are documented; no broad permission-management rewrite occurs as part of the audit.

## Risks

- **False security assurance:** a UI toggle may not enforce what it suggests. Present test evidence and avoid blanket “effective policy” claims.
- **Harness churn:** scope verification to supported current versions; note version-sensitive outcomes.
- **Audit scope creep:** keep this as an evaluation with a decision and concrete follow-ups, not a framework rewrite.

## Documentation impact

- `docs/user/reference/config-control-panel.md`: update claims and caveats as warranted by audit findings.
- Provider/internal permission documentation: update only where native mappings are verified to have changed.

## Research references

- [Claude Code — permissions](https://code.claude.com/docs/en/permissions)
- [Claude Code — settings](https://code.claude.com/docs/en/settings)
- [Codex — configuration](https://developers.openai.com/codex/config-basic)
