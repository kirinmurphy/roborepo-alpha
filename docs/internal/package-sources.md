# Package Sources, Provenance, and the Install Store

The technical reference for where packages come from and how RoboRepo records them: the source
list, the lock, the managed store, same-ID resolution, and the package service. User-facing
commands are in [roborepo-cli.md](../user/reference/roborepo-cli.md#package-sources-and-installing);
the root ownership rules are in
[config-code-separation.md](../architecture/config-code-separation.md#package-ownership-across-roots).

## Contents

- Terms
- Sources
- Catalog composition and same-ID resolution
- The lock
- The managed store
- Git sources
- The package service and CLI
- Doctor
- Migration from bare-ID state
- Code map

## Terms

| Term | Meaning |
| --- | --- |
| **source** | A place packages come from, with a stable local `id`. One package system, several sources. |
| **available** | A configured source offers the package. |
| **installed** | RoboRepo holds a lock record for it, and for a remote package a copy in the store. |
| **active** | The package is applied to the harnesses (`package enable`). Unchanged by this layer. |
| **live source** | A `bundled` or `path` source. Read from disk on every catalog load; its folder *is* the installed package. |
| **qualified name** | `<source>/<package>`, for example the `code-style` package from the `local` source is local/code-style. The package's own `id` stays bare in its manifest. |

Install never activates and refresh never installs. Enabling a package from a live source still
works without a separate install: the apply step records it (see The lock).

## Sources

`<stateRoot>/package-sources.json`, owned by `scripts/cli/package-sources.mjs`:

```json
{
  "schemaVersion": 1,
  "sources": [
    { "id": "builtin", "type": "bundled", "enabled": true, "trust": "official" },
    { "id": "local", "type": "path", "workspace": true, "enabled": true, "trust": "local" },
    { "id": "team", "type": "path", "path": "~/team-packages", "enabled": true, "trust": "local" },
    { "id": "cloudflare-security-audit-skill", "type": "git", "url": "https://github.com/cloudflare/security-audit-skill.git",
      "display": "cloudflare/security-audit-skill", "enabled": true, "trust": "unverified" }
  ]
}
```

| Type | Offers | Tab | Trust | Notes |
| --- | --- | --- | --- | --- |
| `bundled` | `<appRoot>/globals/packages/*` | System | `official` | Only the `builtin` source. Temporary bridge until the official registry replaces it. |
| `path` | Subfolders of a folder | Custom | `local` | `local` follows the workspace root (`workspace: true`) instead of storing a path. |
| `git` | A public GitHub repo at one commit | Third Party | `trusted` or `unverified` | `trusted` when the URL is in the trusted catalog. |
| `registry` | Reserved | — | — | Refused until the official registry lands. |

- The file is written only when the user changes a source. Reads without a file return the two
  defaults, so a catalog load never creates state.
- `builtin` and `local` always exist: a file missing them gets them back in front. `builtin` cannot
  be disabled or removed; `local` can be disabled but not removed.
- An unreadable or invalid file throws `PackageSourceError` rather than falling back to defaults.
- The tab follows the source type, not the original author: a local clone of someone else's repo
  added as a `path` source is Custom.

## Catalog composition and same-ID resolution

`composePackageCatalog()` in `scripts/cli/package-catalog.mjs`:

1. Each enabled live source's adapter lists entries; every entry goes through the same manifest
   validation (`normalizePackageEntry`) and gains `sourceId`, `sourceType`, `trust`, `tab`,
   `qualifiedName`, `revision`, and `collection`. `origin` stays (`built-in`, `workspace`, `git`)
   for existing readers.
2. Installed copies from the lock (`kind: "materialized"`) join the candidates. A disabled or removed
   git source does not remove its installed packages.
3. Candidates are grouped by package ID and resolved:

| Order | Rule |
| --- | --- |
| 1 | A typed `replace` override in the workspace `overrides/resources.json` picks the `local` source. |
| 2 | Otherwise a lock record picks the source it names. |
| 3 | Otherwise a single candidate is used. |
| 4 | Otherwise the ID is a **collision**: `loadPackageCatalog` throws, naming every candidate and both fixes (a replace override, or `package install <source>/<id>`). |

A lock record whose source no longer offers the package leaves the ID **unresolved**: it is left
out of the catalog, another source's same-ID package is never substituted, `package reconcile`
keeps its selection and applied records, and doctor reports it.

The override outranks a lock record because the user edits it directly; lock records are written
by RoboRepo.

Validation (skill and command claims, `requires` edges) runs on the resolved set, so a package that
would claim another package's skill is refused at install time (see The package service).

A collection derived from a source (two or more Agent Skills folders in one repo) is computed from
the source's files on each read and carried on each member as `collection: { id, title }`. Nothing
about it is persisted.

## The lock

`<stateRoot>/packages/package-lock.json`, owned by `scripts/cli/package-lock.mjs`. One record per
installed package ID; it is the persisted source choice and the provenance doctor checks.

```json
{
  "schemaVersion": 1,
  "packages": {
    "code-style": {
      "sourceId": "builtin", "packageId": "code-style", "sourceType": "bundled", "trust": "official",
      "kind": "live", "selector": null, "resolved": "/…/globals/packages/code-style",
      "integrity": null, "fingerprint": "sha256-…", "installedPath": null, "url": null,
      "installedAt": "2026-11-23T00:00:00.000Z"
    },
    "security-audit": {
      "sourceId": "cloudflare-security-audit-skill", "packageId": "security-audit", "sourceType": "git",
      "trust": "unverified", "kind": "materialized", "selector": "default-branch",
      "resolved": "c1c8a8c1471069fb0e188eeaff69b8e8db6564a8", "integrity": "sha256-…",
      "fingerprint": null, "installedPath": "/…/packages/installed/cloudflare-security-audit-skill/c1c8…/security-audit",
      "url": "https://github.com/cloudflare/security-audit-skill.git", "installedAt": "…"
    }
  }
}
```

| Kind | `resolved` | Integrity | Written by |
| --- | --- | --- | --- |
| `live` | The package folder | `fingerprint`: content hash when last applied or installed; drift is expected and reported as a hint | `package install` of a live package, and every apply |
| `materialized` | Immutable revision (commit SHA) | `integrity`: content hash of the copy, checked before it is moved into place | `package install` / `package update` of a git package |

- Writes go through a temp file and a rename (`writeJsonStateAtomic`), so an interrupted write
  leaves the previous file whole. A corrupt lock throws `PackageLockError`; it is never read as
  empty, because that would forget every source choice.
- `disable` keeps the record (disabled is still installed). `package remove` deletes it.
- `enabled-packages.json` and `applied-packages.json` (`scripts/cli/package-state.mjs`) keep bare
  IDs in their lists and gain `sources: { <id>: <sourceId> }`, so each recorded package names its
  source. The lock holds the resolution behind that reference.

## The managed store

```text
<stateRoot>/
  package-sources.json
  packages/
    package-lock.json
    catalogs/<source-id>.json              last good listing of a git source
    cache/<source-id>/<revision>/packages/<package-id>/   fetched, RoboRepo-shaped packages
    installed/<source-id>/<revision>/<package-id>/        installed copies
    staging/                                copies being verified
```

`scripts/cli/package-install-store.mjs` owns it. Promotion is: copy to staging, hash, compare
with any expected integrity, rename into `installed/`, then write the lock record. A failure before
the lock write leaves the previous record and copy in place. Removal deletes only a lock record and
a copy inside `installed/`; it refuses any path outside the store and never touches a live source's
folder. Uninstall removes `package-sources.json` and `packages/`.

## Git sources

`scripts/cli/package-source-git.mjs` registers the `git` adapter.

- **URLs:** `https://github.com/<owner>/<repo>` (with or without `.git`) and `file://` URLs for a
  local mirror. Other hosts, private repos, and branch or tag selectors are out of v1. Git runs with
  `GIT_TERMINAL_PROMPT=0` and no credential helper, so a private or missing repo fails instead of
  prompting.
- **Refresh:** resolves the target commit (the trusted catalog's commit for a trusted source,
  otherwise the default branch's head), fetches exactly that commit, scans it, builds packages into
  `cache/`, validates each, and only then replaces `catalogs/<id>.json`. A failed refresh keeps the
  last listing. Refresh never installs or moves an installed pin.
- **Grouping:** decided by the repo's own files, in this order:

| Repo contains | Packages |
| --- | --- |
| `package.config.json` at the root, in `packages/*/`, or in `*/` | As declared |
| `.claude-plugin/plugin.json` | One package holding every `skills/*/SKILL.md`; plugin hooks and commands are listed as "not installed" |
| `skills/*/SKILL.md` | One package per skill, category `added-skills`; two or more form a collection |
| `SKILL.md` at the root | One package named by the skill's frontmatter `name` |

- **Safety:** a repo containing a symbolic link is refused. `contentsSummary()` lists skills, slash
  commands, rules, hooks, MCP servers, config changes, services, scripts, requirements, and plugin
  files that are not installed.
- **Trusted catalog:** `manifests/inventory/trusted-package-sources.json`,
  `{ schemaVersion: 1, entries: [{ repo, commit, description }] }`. It ships empty until curation
  is decided. `commit` must be a full SHA. A trusted source whose repo leaves the catalog stops refreshing
  (exit 5) instead of moving to the unreviewed branch head; remove it and add it again as
  unverified.

## The package service and CLI

`scripts/cli/package-service.mjs` is the domain layer the CLI and the portal share;
`scripts/cli/package-source-command.mjs` is the terminal front end. Service functions return plain
data and throw `PackageServiceError` with a `code`:

| Code | Exit | When |
| --- | --- | --- |
| `usage` | 2 | Missing or unknown argument, unknown source, unsupported URL |
| `ambiguous` | 3 | A bare ID that several sources offer with no recorded choice |
| `confirmationRequired` | 4 | Installing from an unverified source, or updating, without confirmation (`--yes`) |
| `unavailable` | 5 | The repo cannot be reached, or a revision is not cached |
| `refused` | 6 | Removing a System package, a default source, a source with installed packages, or switching an active package's source |
| `invalid` | 7 | A package that fails validation, or a repo without packages |

| Function | Does |
| --- | --- |
| `listSources`, `sourceInfo`, `addSource`, `removeSource`, `setSourceEnabled`, `refreshSources`, `trustedCatalog` | Source management |
| `listAvailablePackages`, `resolvePackageReference` | Every (source, package) pair; one pick per the reference rules |
| `previewInstall`, `installPackage` | Contents summary, then install with what it requires from the same source |
| `updatePackage` | Show the file change to the newest revision; move the pin only when confirmed; re-apply an active package |
| `removePackage` | Refuse System; disable an active package first; delete the record and any copy |
| `packageView` | Rows with `tab`, `sourceId`, `sourceBadge`, `trust`, `collection`, `available`, `installed`, `active`, `revision`, `latestRevision`, `updateAvailable`, `removable` |

A `requires` edge resolves in the requiring package's own source first, then by the reference
rules; a requirement that stays ambiguous stops the install.

The Config page's package items (`scripts/cli/config.mjs`) carry the same `tab`, `sourceId`,
`sourceBadge`, `trust`, and `collection` fields, read from the composed catalog.

## Doctor

`scripts/cli/package-provenance-doctor.mjs`, run by `doctor --installed`:

| Finding | Level |
| --- | --- |
| Unreadable source list or lock | fail |
| A configured path source whose folder is missing | fail |
| A same-ID collision | fail |
| An unresolved package | fail |
| A live package changed since it was applied | hint |
| Bare-ID state not yet migrated, or an applied package without a lock record | hint |

## Migration from bare-ID state

`scripts/cli/package-provenance-migration.mjs` runs once, from `package enable`, `disable`, and
`reconcile`, when `enabled-packages.json` or `applied-packages.json` has no `sources` map. It
records the source that offers each listed ID today (an override counts as a choice), writes a lock
record for each applied package, and never changes what is selected, deselected, or applied. A
version-1 registry keeps its version so its list keeps its meaning. An ID two sources offer with
no choice is reported and left without a source. The module is temporary: delete it once no
supported install still has bare-ID state.

## Code map

| Module | Owns |
| --- | --- |
| `package-sources.mjs` | Source records, defaults, validation, tabs, qualified names |
| `package-source-adapters.mjs` | The adapter contract and the `bundled`/`path` adapter |
| `package-source-git.mjs` | The `git` adapter, fetch, scanning, catalog cache, trusted catalog, contents summary |
| `package-catalog.mjs` | Composition, same-ID resolution, manifest validation |
| `package-lock.mjs` | The lock |
| `package-install-store.mjs` | The store, content hashes, promotion, guarded removal |
| `package-state.mjs` | Selection and applied records, with their `sources` maps |
| `package-service.mjs` | The domain operations the CLI and portal call |
| `package-source-command.mjs` | `package install`, `update`, `remove`, and `package source *` |
| `package-provenance-doctor.mjs` | Doctor findings |
| `package-provenance-migration.mjs` | The one-time bare-ID migration |
