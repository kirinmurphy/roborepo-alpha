---
id: f0j4j8y2
priority: high
next_action: Scope canonical fingerprint source keys and minimal content normalization, then implement per-file fingerprints in the snapshot builder and schema bump
blocked_by: []
depends_on: []
related: ["k8mngttv", "roborepo-telemetry-events-experiments"]
reviewed_commit: 57f8f2199b6db87d829af8d41e387800518024c9
---

# Telemetry Content Fingerprints: Skill and Rule Revision Tracking

## Summary

Track skill and rules FILE changes as revision conditions in telemetry. Today a same-ID edit
is invisible to snapshot identity because package/skill ID lists are hashed instead of file
contents. This plan adds per-file content fingerprints (hashes only, never contents) to config
snapshots so a later report can distinguish revision A from revision B.

A fingerprint proves **content identity changed**. It does not by itself supply a semantic
version. The UI may say "jdocmunch search revision changed" or show short revision hashes.
Copy such as `v1.1 → v1.2` is allowed only when that version label exists in source metadata;
the telemetry system must never invent it from hashes. Semantic version metadata is display
metadata only and does not replace the content fingerprint as revision identity.

Companion to [[k8mngttv]], which owns events × conditions correlation, canonical observation
semantics, condition evaluability, unknown coverage, marker boundaries, and the ledger. This
plan supplies exact file-revision conditions after that prerequisite completes, including its
Phase 2 boundary contract. Extend the snapshot schema version shipped by the prerequisite; do
not assume the current v1 schema remains the starting point.

## Context

Rules are AMBIENT conditions; skills are INTERACTION-SCOPED. A rules edit changes ambient
context at the next observed SessionStart. A skill edit changes the content available on its
next invocation, but installed/configured state is not proof that the skill was actually used.

The key distinction is:

- [[k8mngttv]]: **when observed state changed and what events were around it**
- this plan: **which exact file content revision was observed**

## Current state

`scripts/cli/telemetry-schemas/snapshot-schema.mjs` currently writes snapshot schema v2, with ambient
package-resource evidence, evaluability, and `revision_contract: 1`. `computeSnapshotId` hashes that
configuration plus ID arrays and settings, not the proposed canonical per-file skill/rule content
records. Same-ID file edits therefore need this extension.

The conditions prerequisite [[k8mngttv]] is complete. Extend v2 and preserve mixed-version reads;
legacy absence must remain unknown revision. Session observation time and interaction-scoped skill
invocation remain distinct from deduplicated snapshot creation time. `intervening.diff_fingerprint`
is a project-repo change signal, not an installed skill/rule revision identity.

## Goals

- Same-ID content edit → different revision fingerprint and snapshot identity.
- Unchanged content → same revision fingerprint and normal dedupe.
- Persist a canonical machine-independent source identity plus hash/status metadata sufficient
  to say which tracked file changed, without persisting file text or machine-local absolute paths.
- Rules revisions become ambient revision conditions.
- Skill revisions become interaction-scoped revision conditions only when invocation
  attribution exists; otherwise the system may report them only as configured/available
  revisions.
- Old snapshots without fingerprints remain analyzable and produce `unknown revision`, not a
  fabricated baseline or `"unknown"` pseudo-version.
- Current unreadable/unresolvable sources also produce `unknown`, never a synthetic empty-file
  hash and never implicit absence.
- Revision comparisons remain non-additive when several resources co-occur.
- All revision analytics consume [[k8mngttv]]'s shared normalized observation layer rather than
  raw telemetry or snapshot rows directly.

## Non-goals

- Inferring the exact wall-clock edit time.
- Mid-session refresh.
- Treating installed skills as invoked skills.
- Inventing semantic versions from hashes.
- Using semantic version metadata as the revision identity.
- Attributing an observed token/event change causally to a revision.
- Replacing marker or ambient-change semantics from [[k8mngttv]].
- Persisting absolute user-home/install paths merely to identify fingerprinted sources.

## Proposed design

### 1. Canonical per-file fingerprint records

`buildEffectiveSnapshot` gains stable revision records for each tracked source. The persisted
identity must be machine-independent and provider-aware.

Recommended shape:

```json
{
  "id": "jcodemunch/search",
  "source_key": "claude/skills/jcodemunch-search/SKILL.md",
  "status": "present",
  "hash": "sha256:…",
  "display_version": "1.2.0"
}
```

Rules:

- `source_key` is canonical/relative/provider-aware identity, not an absolute filesystem path.
- `status` is `present`, `absent`, or `unknown`.
- `hash` exists only when content was successfully read and fingerprinted.
- `display_version` is optional source metadata for UI labels only; it does not participate in
  content identity unless the actual content fingerprint changes independently.
- Do not persist file contents.
- Do not persist `$HOME`, usernames, temporary install roots, or other machine-local path prefixes.

If a user-facing path is useful in diagnostics, derive or redact it at presentation time rather
than using an absolute path as revision identity.

### 2. Revision evaluability: present / absent / unknown

Revision state follows the same evaluability model as [[k8mngttv]].

- **present:** the source is expected, resolvable, readable, and fingerprinted.
- **absent:** the provider/source inventory can positively establish that the tracked source is
  not present.
- **unknown:** the system cannot reliably evaluate the source—for example unsupported provider,
  incomplete legacy snapshot, permission/read error, unresolved path, or missing capture data.

Unknown must not become:

- an empty-file hash;
- a zero hash;
- a fake `"unknown"` revision bucket;
- a known-absent control cohort.

Only known/evaluable revision states participate in revision-to-revision or with/without
comparisons.

### 3. Minimal normalization before hashing

Normalize only representation details that should not create accidental cross-platform churn,
such as line endings and an optional UTF-8 BOM.

Do **not** strip or collapse general whitespace. Markdown indentation, code blocks, YAML,
prompt formatting, and other whitespace can be behaviorally meaningful. A formatting-only
change may create a revision boundary; that is preferable to silently treating a meaningful
whitespace edit as identical.

The canonical source key is not included in the content hash. The same normalized content at
an equivalent canonical source on two machines must produce the same content fingerprint even
when local install roots differ.

### 4. Fingerprints participate in snapshot identity

`computeSnapshotId` includes the stable sorted fingerprint records needed to distinguish
behaviorally relevant revision state. Same IDs with changed content therefore produce a new
snapshot ID.

Snapshot identity must not churn because `/Users/alice/...` became `/home/alice/...`; canonical
source identity is used instead of an absolute path.

A metadata-only semantic-version label change does not, by itself, prove a content revision.
If `display_version` changes while the content hash does not, the hash remains the revision
identity and the version value is treated as changed display metadata.

### 5. SessionStart remains the observation point

The system records the new revision at the next SessionStart and labels it **first observed**.
It does not claim that the edit occurred at that moment.

Use [[k8mngttv]]'s ordering contract for same-timestamp observations. Snapshot creation time
is not the session observation time; deduplicated snapshots can be reused. Independent file
offsets or an arbitrary ID sort do not establish boundary order. Unresolvable ties remain
ambiguous and are excluded and counted by the shared comparison layer.

### 6. Backward-compatible revision state

For old snapshots:

- no fingerprint/evaluability evidence means revision is unavailable/unknown;
- unknown revision is excluded from revision-A vs revision-B deltas;
- no synthetic `"unknown"` revision bucket is treated as a real version;
- later introduction of fingerprint support must not retroactively turn old unknown state into
  known absence.

The same rule applies to current capture failures: inability to read or resolve a target is
unknown, not absence.

### 7. Shared analysis exposure and attribution

Revision boundaries become first-class conditions, but they do not create a separate analytics
stack.

- Rules: ambient revision state.
- Skills: revision metrics only for invocations that can be linked to the skill; otherwise
  display configured/available revision only.
- Revision views preserve the prerequisite's supported token units and attribution provenance;
  a fingerprint does not turn cumulative session tokens into per-invocation usage. Missing or
  evicted snapshots remain unknown. Snapshot updates must invalidate the shared report cache.
- All revision event/token comparisons consume [[k8mngttv]]'s canonical normalized observation
  API, including observation identity, flow dedupe, condition evaluability, cohort denominators,
  token reconciliation, and coverage semantics.
- Revision-specific code supplies revision state; it must not independently count raw telemetry
  rows or invent its own denominators.
- If multiple skills/rules are present on one operation/session, the same token/event
  observation may appear in multiple revision views. Those views are non-additive and must
  never be summed as independent attribution.

### 8. Ledger wording

When source metadata contains an explicit version:

`Skill revision — jcodemunch search v1.1 → v1.2`

Otherwise:

`Skill revision — jcodemunch search · revision changed`

Optionally expose short hashes in detail/popover:

`a91c2d → f77e31`

A rules edit follows the same rule. Before per-file fingerprints exist, the conditions report
shows only changes supported by captured ambient configuration. Current snapshots cannot detect
a same-ID rules edit, so even a coarse rules-content-change row requires this follow-up.

If a version label changes but the content hash does not, do not render a content-revision
boundary solely from that metadata change.

## Implementation checklist

- [ ] Audit fingerprint targets:
      - provider-correct installed skill paths;
      - global rules;
      - workspace rules;
      - package-rendered rule sources.
- [ ] Fix provider-path assumptions before fingerprinting.
- [ ] Define canonical provider-aware `source_key` values independent of machine install roots.
- [ ] Define stable `{id, source_key, status, hash?, display_version?}` records.
- [ ] Define positive absence vs unknown/unresolvable semantics for each provider/source kind.
- [ ] Normalize line endings/BOM only; preserve behaviorally meaningful whitespace.
- [ ] Add fingerprints to `buildEffectiveSnapshot`.
- [ ] Include sorted revision records in `computeSnapshotId`; bump snapshot schema version.
- [ ] Ensure absolute paths/user-home prefixes do not participate in persisted fingerprint identity.
- [ ] Verify unchanged revisions dedupe exactly as before across different local install roots.
- [ ] Mixed-version reads: old snapshots resolve revision as unavailable, not pseudo-version.
- [ ] Current unreadable/unresolvable sources resolve revision as unknown, not absence/empty hash.
- [ ] Analysis: revision boundary condition rows feed the shared normalized analysis layer.
- [ ] Analysis: per-revision skill metrics only where invocation attribution is known.
- [ ] Analysis: non-additive multi-resource caveat and dimension-specific coverage metadata.
- [ ] Ledger: exact revision row copy follows metadata-vs-hash rules above.
- [ ] Tests:
      - same-ID edit changes fingerprint/snapshot ID;
      - unchanged content dedupes;
      - same normalized content at different install roots has the same content fingerprint;
      - canonical source identity is stable across supported provider path layouts;
      - CRLF/LF normalization is stable;
      - meaningful whitespace edit changes the fingerprint;
      - unreadable/unresolvable source = unknown;
      - proven missing source = absent;
      - missing/unreadable source never hashes as empty content;
      - no file text persists;
      - no absolute home/install path persists in revision identity;
      - provider-correct path resolution;
      - old snapshot revision = unavailable/unknown;
      - semantic-version-only metadata change does not create a content-revision boundary;
      - co-occurring revisions are not summed as disjoint attribution;
      - duplicate raw telemetry rows still count once through the shared observation layer.

## Validation

- `npm run test:unit`
- Extend schema/capture checks for fingerprint sensitivity, canonical source identity, and mixed versions.
- Privacy assertions ensure raw skill/rule content and machine-local absolute paths never appear
  in spool or snapshot fingerprint records.
- Real-path checks resolve an actually installed skill for each supported harness, then map that
  local path to the expected canonical `source_key`.
- Report fixture proves:
  - a revision boundary is shown as "first observed";
  - semantic versions appear only when source metadata supplies them;
  - hash-only changes never become invented `vN` labels;
  - semantic-version-only metadata changes do not masquerade as content revisions;
  - unknown old-snapshot revisions are excluded from revision deltas;
  - unreadable/unresolvable current revisions are also excluded as unknown;
  - known absence is distinct from unknown;
  - token/event metrics inherit canonical observation dedupe, with/without denominators, and coverage.

## Risks

- **Revision churn:** any meaningful text edit creates a new identity. This is expected; the
  UI says "content revision," not "behavior changed."
- **Path churn/privacy:** absolute install paths can vary by machine and reveal local details.
  Mitigation: canonical source keys only in persisted identity.
- **Over-normalization:** stripping whitespace could collapse behaviorally distinct prompts.
  Mitigation: normalize representation only, not general whitespace.
- **Unknown accidentally becoming absence:** failed reads or unsupported paths could fabricate a
  control cohort. Mitigation: explicit present/absent/unknown status and regression tests.
- **Attribution overreach:** several revisions can co-occur. Mitigation: non-additive language
  and no causal claim.
- **Observation-time ambiguity:** SessionStart is not edit time. Mitigation: "first observed"
  copy and deterministic persisted ordering.
- **Semantic drift:** revision analytics could diverge from condition/report math. Mitigation:
  consume [[k8mngttv]]'s shared normalized analysis API rather than raw rows.
- **Schema bump:** mixed-version fixtures are required before merge.
- **I/O cost:** hashing happens only on the heavier SessionStart path and is bounded by tracked
  file count.

## Open questions

- **Which paths count?** Provider-specific installed skill paths, global rules, workspace rules,
  and package-rendered rules are the expected set; audit decides the exact list.
- **Canonical source-key format:** provider-relative path is the likely default, but the audit
  should confirm whether a structured `{provider, kind, id}` key is more stable than a path-like key.
- **Hash granularity:** whole-file first. Per-entry fingerprints only if later UI requirements
  truly need individual rule identities.
- **Semantic version source:** if package/skill metadata has a canonical version, persist it only
  as optional display metadata. Never derive it from the hash and never let it replace hash identity.
- **Harness identity in snapshot identity:** confirm current cross-harness dedupe behavior still
  makes sense once provider-specific revision records are added.
