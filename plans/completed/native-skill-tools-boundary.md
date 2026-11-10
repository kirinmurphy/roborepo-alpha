---
id: native-skill-tools-boundary
priority: none
next_action:
blocked_by: []
depends_on: []
related: [native-skill-tooling-followups]
reviewed_commit: b8684ef
---

# Native Skill Tools Boundary

> Status: complete. The boundary decision below is settled and the read-only
> inventory pass shipped: `roborepo skill inspect <name>` and the `/config` skill
> popup share a native-aware inventory model (`scripts/cli/skills.mjs` →
> `skill-inventory.mjs`). The remaining additive tooling — doctor native-metadata
> reporting, `skill adopt` native-feature report, and optional managed-skill
> pinning (checklist items 5–7) — split out to
> [`backlog/agent-config-native-skill-tooling.md`](../backlog/agent-config-native-skill-tooling.md).
>
> This records the product boundary for roborepo's skill tooling:
> preserve native Claude/Codex capability, and only abstract the parts where roborepo adds
> cross-harness parity, install safety, or version-controlled portability.

## Purpose

Claude and Codex both have native skill systems that are moving quickly. They own
features such as per-harness visibility controls, plugin marketplaces, skill evals,
Record & Replay, app metadata, managed settings, and harness-specific invocation policy.

Roborepo should not become a competing skill platform. Its value is the control plane around
shared agent configuration: canonical source, safe install/update, Claude/Codex fan-out,
drift detection, and a portal that explains what is active.

This plan defines that boundary so future CLI and portal work does not flatten native options
into a smaller common-denominator model.

## Current Behavior

Roborepo currently provides these skill-management flows:

- `roborepo skill new` scaffolds a shared skill or command, registers manifests, renders
  command wrappers, and fans out managed links.
- `roborepo skill adopt <name>` imports an unmanaged home skill into a new package at
  `globals/packages/<name>/skills/<name>` (development checkout) or the workspace skills dir
  (package mode).
- `roborepo skill export-to-project` copies shared skills into a target repo and creates a
  shareable zip.
- `roborepo skill link-project` links repo-local skills into harness locations.
- `roborepo skill inspect <name>` reports source, ownership, managed cache state, native collisions,
  native-only metadata, frontmatter, context files, and per-harness install state without changing
  files.
- `roborepo doctor --installed` verifies managed cache entries and harness links.
- The `/config` portal shows enabled skills and uses the same inventory model for skill source
  inspection.

The shared source of truth is `globals/system/skills/<name>/` for the mandatory base skill
(roborepo-support) and `globals/packages/<pkg>/skills/<name>/` for every package-owned skill.
Install/update materializes enabled skills into `~/.roborepo/skills/<name>` and links harness views
to that managed cache.

Native tools provide broader capability than roborepo currently exposes:

| Area | Native capability | Roborepo stance |
| --- | --- | --- |
| Skill visibility | Claude `skillOverrides`, Claude `Skill(...)` permissions, Codex `skills.config` | Expose/report; do not replace with a lossy universal toggle. |
| Frontmatter/options | Claude and Codex-specific fields for invocation, tools, models, agents, hooks, paths, shell, and UI metadata | Preserve all fields; scaffold only safe defaults. |
| Skill creation | Native skill creators, guided refinement, and curated installers | Wrap only where useful; prefer adopting output over reimplementing authoring UX. |
| Evaluation | Native skill evals, A/B testing, description tuning, reports | Link/report; add roborepo checks only for repo invariants. |
| Plugins | Marketplaces, install/uninstall/toggle, app/MCP bundles, sharing | Treat plugins as native distribution units; roborepo may manage curated config, not the browser UX. |
| Recorded workflows | Codex Record & Replay | Adopt generated skills; do not recreate recording in roborepo. |
| Version policy | Native marketplace refs, managed settings, per-skill disables | Add roborepo ownership/pin metadata only for managed roborepo skills. |

## Decision

Roborepo is a thin orchestration and parity layer, not a native skill manager replacement.

Roborepo should own:

- Canonical version-controlled source for roborepo-authored shared skills.
- Safe materialization into the machine-local managed skill cache.
- Claude/Codex fan-out for the skills roborepo owns.
- Manifest registration for user-facing behavior sections and command exposure.
- Drift, collision, and stale-link detection.
- Portal inspection of skill source, trigger text, bundled context files, and native metadata.
- Adoption of native-created skills into managed source when the user asks.

Native tools should own:

- Per-harness skill visibility states.
- Native plugin marketplace discovery, install, uninstall, update, and sharing UX.
- Native creator and installer flows.
- Skill evals, benchmarks, trigger tuning, and report viewers.
- Record & Replay and other app-only skill authoring.
- Harness-specific frontmatter and sidecar semantics.
- Organization/admin policy enforcement.

## Required Rules

1. Roborepo must preserve native skill files losslessly.
2. Roborepo must not remove or rewrite unknown frontmatter, sidecar files, plugin metadata, or
   supporting context files.
3. A cross-harness schema may describe intent, but it must not hide native-only controls.
4. If Claude and Codex express the same capability differently, roborepo should store the shared
   intent and render/check harness-specific configuration where possible.
5. If a native capability has no cross-harness equivalent, roborepo should expose it as
   harness-specific metadata instead of flattening it.
6. Managed roborepo skills and unmanaged native skills must remain distinguishable.
7. Portal controls should be safe common-case shortcuts; advanced native controls should remain
   inspectable and reachable.

## Proposed Behavior

### Skill Inspection

Add a `roborepo skill inspect <name>` command and expand the portal popup to show:

- source path and ownership: managed, unmanaged, native, plugin, or bundled
- trigger metadata used for implicit invocation
- body content
- bundled context files
- native Claude fields
- native Codex `agents/openai.yaml` fields
- install state in each harness
- visibility/disable state in each harness
- warnings for drift, stale cache, path mismatch, or unsupported metadata

Inspection is read-only. It should help the user decide whether to edit native config, adopt a
skill, or update roborepo source.

### Native-Aware Adoption

`roborepo skill adopt <name>` should keep every file under the skill directory. After adoption,
it should report native-only features rather than rewriting them:

- Claude-only frontmatter fields
- Codex-only `agents/openai.yaml` policy or dependency fields
- scripts and references
- eval artifacts
- plugin-adjacent metadata

Adoption should ask the user to review any harness-specific behavior that cannot be preserved
identically across Claude and Codex.

### Lossless Package Intent

Package `skill` resources should remain a high-level behavior catalog, not a full substitute for
native skill metadata.

It may express shared intent such as:

```json
{
  "skill": "plan-docs",
  "invocation": "manual",
  "risk": "medium",
  "explicit_command": true
}
```

It should not try to encode every Claude or Codex field unless roborepo needs that field for
cross-harness parity or install safety.

### Portal Controls

The portal should keep simple toggles for common roborepo-managed features, but it should not
pretend those toggles are the full native state.

For skills, the portal should separate:

- **Installed by roborepo:** cache/link exists for the managed source.
- **Visible to harness:** native settings allow the skill to appear or be invoked.
- **Implicitly invokable:** harness policy allows model-chosen invocation.
- **User-invokable:** harness policy allows explicit menu/prompt invocation.

When a setting is native-only, the portal should show the current value and the file/source that
owns it. Write controls can come later, but the read model must be accurate first.

### Version And Lock Policy

Roborepo should add first-class pinning only for roborepo-managed skills:

- pin a managed skill to the current repo revision or content hash
- prevent `roborepo update` from replacing that managed cache entry without an explicit unpin
- report pinned skills in `doctor --installed` and the portal

This should not block native plugin marketplace updates or native skill management unless the
user explicitly brings that skill under roborepo ownership.

## Implementation Checklist

1. [x] Audit current Claude and Codex native skill discovery paths, because native documentation and
   current roborepo docs may not agree.
2. [x] Define a read-only skill inventory model that can represent managed, unmanaged, native,
   plugin-provided, and bundled skills.
3. [x] Add `roborepo skill inspect <name>` on top of that inventory model.
4. [x] Update the `/config` skill popup to use the same inventory model.
5. Extend `doctor --installed` to report unmanaged/native skill metadata without treating it as
   failure.
6. Make `skill adopt` print a native-feature report after copying files.
7. Add optional managed-skill pin metadata for roborepo-owned cache entries.
8. [x] Update reference docs for the read model and portal behavior.

## Open Decisions

- Should roborepo write native visibility settings, or only report them?
- Should pins live in the repo, in `~/.roborepo/state`, or both?
- Should `skill adopt` preserve original native scope metadata so a user can later export back?
- Should plugin-provided skills appear in the same portal table as direct skill folders, or in a
  separate Plugins section?
- Should roborepo expose native marketplace commands as pass-through helpers, or simply link users
  to native flows?

## Success Criteria

- A native-created skill can be adopted without losing frontmatter, sidecars, scripts, references,
  or eval artifacts.
- A user can tell whether a skill is installed, visible, implicit, explicit-only, disabled, or
  unmanaged.
- Roborepo-managed skills remain portable across Claude and Codex.
- Native-only controls remain available through native tools.
- The CLI and portal make advanced native state visible without requiring roborepo to reimplement
  native marketplaces, evals, or app workflows.
