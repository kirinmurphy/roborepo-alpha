---
id: native-skill-tooling-followups
priority: low
next_action: Extend existing doctor/native inventory output with metadata detail and add an adoption feature receipt; coordinate pin identity with package-source provenance.
blocked_by: []
depends_on: []
related: ["native-skill-tools-boundary", "jdsobwn"]
reviewed_commit: 57f8f2199b6db87d829af8d41e387800518024c9
---

# Native Skill Tooling Coverage

## Summary

Add useful native-skill metadata and adoption receipts to the shipped inventory, and decide how
managed-skill pinning fits package source provenance.

## Context

[[native-skill-tools-boundary]] delivered `roborepo skill inspect` and the shared inventory model.
`scripts/doctor.sh` already reports unmanaged skill directories as drift. The remaining gap is
metadata detail and an adoption feature report, not basic unmanaged detection.

## Goals

- Explain native-only metadata without treating native skills as an install failure.
- Preserve skill files while making adoption consequences visible.
- Allow managed pins only with an explicit owner and update/unpin contract.

## Proposed design

Extend existing `skill-inventory.mjs` projections and doctor reporting rather than scanning again
through a separate inventory. Adoption should describe retained frontmatter, sidecars, references,
scripts, and harness-specific features. Pin records must align with [[jdsobwn]] source provenance;
native marketplace updates remain provider-owned.

## Implementation plan

- [ ] Extend doctor information with available native metadata and unknown/unsupported fields.
- [ ] Add a feature-preservation receipt after `skill adopt`, without rewriting native metadata.
- [ ] Decide pin identity, persistence, and interaction with configurable-source versions before
      implementing pins; preserve current installed content until an explicit unpin/update.
- [ ] Reflect approved pin state in inspection, doctor, and the portal.

## Validation

Adoption preserves frontmatter, sidecars, scripts, references, and eval artifacts. Native metadata
appears informationally. Test managed update/unpin behavior and ensure native plugin updates remain
outside the pin mechanism. Use existing skill inventory/adoption and package lifecycle checks.

## Documentation impact

Update `docs/user/reference/roborepo-skills.md` and `docs/internal/skills-and-commands.md` with
receipts and any approved managed pin contract.

## Open questions

- Should native visibility settings be reported only, or written through a supported provider API?
- What is the canonical managed pin identity and storage owner?
- Should plugin-provided skills share the folder inventory or have a separate presentation?

## Additional native interoperability decisions

- Should adoption retain original native scope metadata for later export back to its source harness?
- Should RoboRepo expose native marketplace commands as pass-through helpers, or link to native
      flows? Keep marketplace lifecycle provider-owned whichever discovery surface is chosen.
