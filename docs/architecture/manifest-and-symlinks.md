# Manifest And Materialization

## Purpose

`manifests/platform/manifest.tsv` is the install manifest for files that roborepo materializes into harness homes. The current model is copy/render first: home paths do not depend on the checkout staying in place.

## Row Kinds

| Kind | Meaning |
| --- | --- |
| `managed_copy` | Copy a roborepo-owned source path into the harness home. Re-run updates the copy. |
| `root_config` | Copy or stage mutable harness config such as `settings.json` and `config.toml`, using `onConflict`. |
| `rendered_rules` | Generate the home rules file from base fragments plus enabled package fragments. |
| `cleanup` | Remove an old repo-managed symlink from a retired path. This is migration-only. |

`link` is legacy. New install rows should not use it.

## Skills

Shared skills live in:

```text
globals/packages/<package>/skills/<name>/
globals/system/skills/roborepo-support/
```

The installer materializes package-owned skills and `roborepo-support` into
`~/.roborepo/skills/<name>`. Each enabled harness's native skills directory links each managed
skill name to that cache entry. Package toggles control which optional skills are active. Each
roborepo-owned cache entry contains:

```text
.builtin-managed
```

That marker is the ownership signal for refresh, prune, uninstall, and native-skill collision
handling. A real skill directory without the marker is treated as user-owned and is left alone.

## Rules

Tracked baselines are still rendered in the repo:

```text
generated/claude/CLAUDE.md
generated/codex/AGENTS.md
```

Home files are rendered separately:

```text
~/.claude/CLAUDE.md
~/.codex/AGENTS.md
```

Home rendering uses:

- base fragments from `globals/system/rules/shared/` plus harness-specific fragments
- enabled package IDs from `~/.roborepo/enabled-packages.json`
- package rule fragments from `globals/packages/<package>/rules.md`

## Source Checklists

`manifests/platform/source-files.tsv` is a repo-health checklist, not an install manifest. `doctor.sh` asserts these source paths exist so package or install artifacts are not accidentally omitted.

## Validation

Use:

```sh
./scripts/doctor.sh
./scripts/doctor.sh --installed
```

Repo doctor checks source files and tracked generated outputs. Installed doctor additionally checks
home render state, managed cache entries, and harness skill links.
