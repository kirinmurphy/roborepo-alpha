# RoboRepo Skills Interface

`roborepo skill` is the parity-managed skills interface. Use it when a skill or command should be
shared through RoboRepo source, installed into every harness that supports skills, or exported into a
project.

Use native Claude/Codex commands when the action is harness-specific, such as plugin marketplace
management, plugin enable/disable state, updates, validation, or one-session plugin loading.

## Terms

- `global` means installed machine state: `~/.roborepo/skills`, `~/.claude/skills`, and
  `~/.codex/skills`.
- `project` means the current repo or worktree.
- The CLI namespace is singular: `roborepo skill`.

## Command Reference

| Command | What it does |
| --- | --- |
| `roborepo skill new` | Scaffolds a shared automatic helper, skill-backed slash command, or standalone slash command. |
| `roborepo skill adopt <name>` | Moves an unmanaged native skill from `~/.codex/skills` or `~/.claude/skills` into shared RoboRepo source. |
| `roborepo skill sync-global` | Refreshes `~/.roborepo/skills` and the installed harness skill views from shared skill source. |
| `roborepo skill inspect <name>` | Reports source, ownership, managed marker/cache state, native collision state, harness install state, frontmatter, context files, and native-only metadata. |
| `roborepo skill export-to-project` | Copies shared skills into the current project and leaves a shareable zip bundle. |
| `roborepo skill link-project` | Links project-owned `.codex/skills/<name>` into `.claude/skills/<name>` when Claude project config exists. |
| `roborepo skill render-commands` | Renders generated slash command files from the command inventory. |
| `roborepo skill triggers [--check]` | Checks trigger and near-miss fixtures for medium-risk skills against each skill description. |
| `roborepo skill native [--full]` | Prints a concise native Claude/Codex plugin summary; `--full` prints native help output inline. |

## Managed Source And Install Shape

Package-owned shared skills are authored at
`globals/packages/<package>/skills/<name>/`. The required base support skill remains a system
skill at `globals/system/skills/builtin-support/`. The global install materializes each enabled
shared skill into `~/.roborepo/skills/<name>` with a `.builtin-managed` marker, then links
installed harness views to that cache entry:

```text
~/.claude/skills/<name> -> ~/.roborepo/skills/<name>
~/.codex/skills/<name>  -> ~/.roborepo/skills/<name>
```

Project skills use the project as the boundary. Codex reads `.codex/skills/<name>` directly, and
`roborepo skill link-project` links Claude's project skills to that source when `.claude` exists.
This never touches global `~/.claude` or `~/.codex`.

## Skill Inspection

`roborepo skill inspect <name>` is read-only. It uses the same native-aware inventory model as the
`/config` skill inspect popup, so CLI and portal reports agree.

The report distinguishes:

- builtin-managed source at `globals/packages/<package>/skills/<name>` or the system
  `globals/system/skills/builtin-support`
- managed cache entries under `~/.roborepo/skills/<name>` carrying `.builtin-managed`
- native or unmanaged real directories under `~/.claude/skills/<name>` or
  `~/.codex/skills/<name>`
- native collisions, where a builtin-managed skill name is occupied by an unmanaged native skill
  in one harness
- native-only metadata files such as `agents/openai.yaml`, `agents/claude.yaml`, `plugin.json`,
  `.codex-plugin/plugin.json`, and `skill.json`

Inspection never adopts, deletes, rewrites, or flattens native metadata. Use it before deciding
whether to edit native config, run `roborepo skill adopt <name>`, or refresh managed links with
`roborepo skill sync-global`.

## Trigger Fixtures

`roborepo skill triggers --check` is a deterministic guard for invocation policy. Each package
owns the fixtures for its own skills in an optional `skill-triggers.json` at the package root,
beside `package.config.json`:

```json
{
  "tests": [
    {
      "skill": "plan-write",
      "match": ["create an implementation plan for package reconciliation"],
      "nearMiss": ["write a quick PR summary"],
      "triggerPhrases": ["implementation plan"],
      "skipPhrases": ["PR descriptions"]
    }
  ]
}
```

The check reads every package in the catalog, including disabled ones and workspace packages, and
verifies that each fixture's expected prompts use declared trigger phrases, near-miss prompts avoid
those phrases, and the skill description still contains both trigger and skip language. A fixture
may only name a skill its own package declares. The file sits at the package root rather than in
`skills/<id>/` because skill directories are copied into harness homes and exported projects, and
fixtures are test data, not agent instructions.

This is not a model oracle. It catches accidental broadening or removal of trigger language before
the repo changes skill descriptions or invocation policy.

## Native Escape Hatch

`roborepo skill native` is a guide, not a wrapper. It prints the static RoboRepo decision rule plus
a short curated summary of the native surfaces. Run `roborepo skill native --full` when you need the
installed CLIs' exact current help:

```sh
claude plugin --help
codex plugin --help
codex plugin marketplace --help
```

The default output is short and stable. `--full` queries the native CLIs live and prints fallback
examples for any unavailable section.

Use native commands for harness-specific marketplace state and plugin lifecycle. If a native skill
should become shared and version-controlled, run:

```sh
roborepo skill adopt <name>
```
