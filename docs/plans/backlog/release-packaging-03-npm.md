---
id: 1rajbd5o
priority: low
next_action: Compare existing local release safeguards with the remaining CI, provenance, exact-artifact verification, and stable-release acceptance requirements; verify registry/account state before changing release identity.
blocked_by: []
depends_on: []
related: ["c7b7swuh", "46up8y7a", "qjsbhel5"]
reviewed_commit: 57f8f2199b6db87d829af8d41e387800518024c9
---

# RoboRepo Packaging 03: Publish npm Releases

## Summary

Finish the registry release channel around the existing local publisher: establish reviewed
package metadata, controlled CI publication, provenance, exact registry-artifact verification, and
stable-release acceptance.

## Context

`package.json` declares `codethings-roborepo-alpha` at `0.1.0-beta.8`. The checked-in version is not
evidence of a registry publication. `scripts/release/publish-npm.sh` already provides explicit beta
publication, clean-tree/auth/duplicate-version checks, version selection, and release checks.
`promote-npm-latest.sh` moves dist-tags. `docs/internal/npm-release.md` owns the current runbook.

| Delivered baseline | Remaining requirement |
| --- | --- |
| Explicit beta/default tag and latest opt-in | Verify the intended account, package identity, metadata, and stable-promotion policy |
| Local publisher and duplicate-version safeguards | Controlled CI entry point and configured trusted publisher or narrow credentials |
| Packed artifact smoke checks | Prove the exact tested bytes are published and verify the exact registry version independently |
| Release commands and runbook | Durable source/integrity manifest, provenance, rollback, migration, and soak evidence |

`.github/workflows/ci.yml` has no publication job. Registry contents, account ownership, and trusted
publisher configuration have not been verified by this backlog sync. The shared install lifecycle
and local transfer prerequisites are completed; Homebrew remains separately owned by [[qjsbhel5]].

## Goals

- Publish intentionally from reviewed source through a controlled CI workflow.
- Verify exact artifact integrity, provenance, executable resolution, and lifecycle behavior.
- Keep beta and stable promotion explicit, with recorded real-machine acceptance.
- Preserve application/workspace/state boundaries across upgrades and rollback.

## Non-goals

Rebuild local publication, implement Homebrew, or introduce semantic-release without a separate
decision. Publication and dist-tag changes require an explicit release request; implementing this
plan does not itself authorize publishing a release.

## Proposed design

```mermaid
flowchart LR
  Source[Reviewed source and version] -->|validate| Pack[Exact packed tarball]
  Pack -->|smoke-test| Publish[Explicit CI publish with provenance]
  Publish -->|fetch exact version| Registry[Independent registry verification]
  Registry -->|record acceptance| Promote[Explicit stable or tag promotion]
```

Reuse the existing publisher and package-install fixture contract. Record version, source commit,
integrity, and file list, and compare the published artifact with the exact validated tarball.
Do not infer a release from every merge to main. Define whether promotion publishes a new stable
version or moves a tag, and prevent beta-to-latest movement without intentional approval.

## Implementation plan

- [ ] Verify package/account ownership and complete repository, bugs, homepage, license, and
      installation metadata; check existing registry versions before changing identity.
- [ ] Document version-bump ownership, stable numbering, dist-tag movement, and accidental-tag recovery.
- [ ] Preserve existing clean-tree/auth/duplicate/tag checks and add any missing full parity and
      reviewed-allowlist checks for CI publication.
- [ ] Emit a source/version/integrity/file-list release manifest for the exact tarball.
- [ ] Add an explicit manually triggered or tag-driven CI workflow and configure trusted publishing
      or narrowly scoped credentials; validate expected branch/tag relationships.
- [ ] Verify duplicate-version failures and publish beta without moving latest.
- [ ] Install the exact published version into a disposable prefix/home; verify registry integrity,
      command resolution, initialization/apply/doctor, upgrade, and retained workspace/state.
- [ ] Record real clean-machine beta use, an explicit soak period, and migration from a checkout or
      existing workspace before proposing the first stable release.
- [ ] Update release and rollback guidance from observed behavior and record source/version evidence.

## Validation

Use `node scripts/test/publish-npm-check.mjs`, `bash -n scripts/release/publish-npm.sh`,
`npm run test:package-install`, `npm run pack:dry-run`, and `npm run check` for implementation.
Registry acceptance must test an exact version and cannot be satisfied by local tarball tests alone.
Keep external publication and soak steps unconfirmed until their evidence is recorded.

## Documentation impact

Update `docs/internal/npm-release.md`, `docs/internal/testing.md`, and user install/update/uninstall
guides with the final CI, provenance, exact-version, and recovery contract.

## Open questions

- Does the current package identity remain the intended public identity?
- Which trusted-publisher/account setup and source/tag policy should CI enforce?
- What soak evidence and stable-version policy are required before latest promotion?
