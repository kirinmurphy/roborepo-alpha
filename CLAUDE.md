## Roborepo

This repo (roborepo) is the version-controlled source for global Claude and Codex harness configs.
Prefer editing tracked repo files instead of adding ad hoc files under `~/.claude` or `~/.codex`.
If useful config is added directly under those dirs, capture it in the repo or update `scripts/sync-from-home.sh` / `scripts/install/main.sh`.

## Naming: "runtime"

The bare word **Runtime** is the canonical name of the user-facing service that observes local dev activity
(the portal page at `/runtime`, `roborepo runtime`, README and user docs, and prose that names the feature).
Everything internal that involves "runtime" carries a prefix so the bare word stays unambiguous:

| Name | Meaning | Examples |
|------|---------|----------|
| `developer-runtime` | Code for the Runtime service | `modules/developer-runtime/`, `portal/developer-runtime/`, `DeveloperRuntime*`, `/api/developer-runtime`, `<stateRoot>/developer-runtime/` |
| `package-runtime` | Assets a package installs for harnesses | `package-runtime-asset` component type, `${package-runtime:...}`, `~/.roborepo/package-runtime/` |
| `harness-runtime` | Harness provider registry runtime | `scripts/harnesses/harness-runtime.mjs` |

Generic English ("at runtime") and the `"runtime": "bash"|"node"` script-interpreter field in `cli-commands.json` are unrelated.

## Naming: "repo"

In anything the user reads in the app (portal pages, dialogs, buttons, tooltips, toasts, error and
empty-state copy, URL parameters such as `?repo=`), say **repo** / **Repo** / **repos**, never
"repository". "All repos", "Manage Repos", "Repo-level agent config", "Ignore Repo".

Code, file names, API field names, and internal docs keep `repository` (`repositoryId`, `urlKey`,
`modules/repositories/`, class names, `data-slot` values). Only the words a person reads change. Text
copied for an agent (plan prompts) is not app UI and is left as written.
