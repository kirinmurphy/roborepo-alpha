# NPM Release Workflow

## Purpose

This is the maintainer reference for publishing the roborepo npm package. It is not end-user
package documentation. It records the canonical command, release checks, and the pre-launch
compatibility stance for release tooling.

## Maintainer Doc Location

Docs for people using the installed package belong in `docs/user/guides/` or `docs/user/reference/`.
Docs for people changing, releasing, or maintaining this repo belong in `docs/internal/`.

Use this split:

| Audience | Location | Examples |
| --- | --- | --- |
| End user learning the package | `docs/user/guides/` | install flow, daily use, telemetry walkthrough |
| End user needing exact behavior | `docs/user/reference/` | CLI commands, telemetry service, hooks behavior |
| Repo maintainer or contributor | `docs/internal/` | release workflow, config collision internals, harness anatomy |
| Active implementation work | `plans/` on the `repo-plans` branch | planned or completed implementation records |

## Release Commands

The canonical release command is:

```sh
npm run publish:npm
```

There is no compatibility alias for older pre-launch script names. Until roborepo launches, release
tooling should expose one current interface and remove stale command paths when behavior changes.

| Command | Use when | What it does | What it avoids |
| --- | --- | --- | --- |
| `npm run publish:npm -- --next-release-info` | You want quick facts about the next publish target. | Computes next version, npm tag, publish command, and install command. | No clean-tree check, npm auth, registry lookup, tests, version write, or publish. |
| `npm run publish:npm -- --dry-run` | You want to know whether publishing is safe right now. | Requires clean tree, checks npm auth and registry state, runs release checks, prints publish/install commands. | No version write and no publish. |
| `npm run publish:npm` | You are ready to publish. | Requires clean tree, checks npm auth and registry state, writes next version, runs release checks, publishes with explicit dist-tag, prints install command. | Refuses duplicate versions and refuses `latest` unless explicitly requested. |
| `npm run publish:npm -- --confirm` | You want a manual final gate after release checks pass. | Runs the same publish flow, then prompts before `npm publish`. | Noninteractive terminals will abort at the prompt. |
| `npm run promote:npm-latest` | You already published and want unpinned installs to resolve to the newest published version. | Queries npm for all published versions and moves the `latest` dist-tag to the highest semver version. | No package version write and no tarball publish. |

## Default Version And Tag

The workflow defaults to the next `beta` prerelease:

```text
0.1.0-beta.0 -> 0.1.0-beta.1
```

The default dist-tag is `beta`. Publishing with `latest` requires `--latest`; `--tag latest` by
itself is rejected.

Use an explicit version or preid only when the release intent differs from the default:

```sh
npm run publish:npm -- --version 0.1.0-beta.2
npm run publish:npm -- --preid rc
npm run publish:npm -- --latest
npm run publish:npm -- --confirm
```

## Checks

The real publish workflow and dry run both run:

```sh
npm test
npm run pack:dry-run
npm run test:package-install
bash scripts/doctor.sh --quiet
```

`--next-release-info` intentionally does not run these checks. It is for quick release metadata,
not release readiness.

See [Testing RoboRepo](testing.md) for the full maintainer test matrix, focused post-merge checks,
portal smoke guidance, and sandbox-specific rerun rules.

## Failure Rules

The workflow stops before publishing when:

- the worktree is dirty
- npm auth fails
- npm registry lookup fails for reasons other than the target version not existing
- target version already exists on npm
- any release check fails
- `latest` is requested without `--latest`

## Verification For Workflow Changes

After editing `scripts/release/publish-npm.sh` or its package scripts, run:

```sh
npm run --silent test:publish-npm
bash -n scripts/release/publish-npm.sh
git diff --check
```

Run `bash scripts/doctor.sh --quiet` when docs, generated files, or repo health assumptions are in
scope.
