# manifests/inventory

The **supplied catalog** — the config items roborepo ships and fans out to the harnesses.
This is the place to *add things*. It is deliberately separate from `manifests/platform/`
(the install/verify/render plumbing) so adding an item can never accidentally disturb how
the installer wires `~/.claude` / `~/.codex`.

## Files

| File | What it holds | How to add an item |
| --- | --- | --- |
| `mcp-presets.json` | MCP server presets offered by `roborepo mcp add` | **Hand-edit.** No add command. `roborepo mcp add` *reads* a preset and writes it into live config; it never writes back here. |
| `agent-permissions.json` | Flat permission behaviors and arbitrary command buckets (`allow` / `ask` / `deny`) | **Hand-edit.** No add command. The renderer (`roborepo permissions`) reads the buckets and generates the `globals/*` blocks; it never writes back here. |
| `package-categories.json` | Valid package presentation categories for onboarding and Config UI | **Hand-edit.** Package configs reference these stable IDs. |

## Package-owned resources

Optional packages now live under `globals/packages/<package-id>/package.config.json`.
Skill invocation policy, slash-command entrypoints, and skill trigger fixtures are declared inside
the owning package, not in separate inventory manifests. Trigger fixtures live in an optional
`globals/packages/<package-id>/skill-triggers.json`.

`roborepo skill new` and `roborepo package dev create` write package directories. The remaining
inventory files are hand-edited shared registries.

After editing any file here, run `roborepo doctor` (and `roborepo permissions --check` /
`roborepo skill render-commands --check` for the rendered ones) to confirm nothing drifted. After
editing a package's `skill-triggers.json`, run `roborepo skill triggers --check`.
