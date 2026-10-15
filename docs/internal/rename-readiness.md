# Rename-readiness audit (Phase 1 of the RoboRepo rename preparation)

Snapshot date: 2026-09-13 · branch: `rename-prep` · counts from `git ls-files` (910 tracked files, 495 contain the name).

## Canonical naming surfaces (what actually exists)

| Surface | Value | Where defined |
|---|---|---|
| Display/product name | `RoboRepo` | prose, `manifests/platform/cli-commands.json` `title`, portal HTML |
| CLI command name | `roborepo` | `bin/roborepo` (bash entry), `package.json` `bin`, `manifests/platform/cli-commands.json` `commandName` |
| npm package | `codethings-roborepo-alpha` | `package.json` `name`, `scripts/cli/uninstall.mjs`, `scripts/install/uninstall-lib.sh`, release tests |
| State/config dir | `~/.roborepo` | `scripts/cli/roots.mjs` (`stateRoot` default), shell install scripts |
| Env-var prefix | `ROBOREPO_*` | 38 distinct vars, ~690 occurrences across CLI/tests/installers |
| Portal client global | `window.ROBOREPO_PORTAL` | injected `scripts/cli/portal-server.mjs:131`, read by `portal/shared/{theme,api}.js` |
| Auth header | `X-Roborepo-Portal-Token` | `portal/shared/api.js:22` (+ server-side check) |
| localStorage key / custom event | `roborepo-theme` / `roborepo:themechange` | `portal/shared/theme.js` |
| Generated policy filename | `generated/gemini/policies/roborepo-permissions.toml` (+ `commandPrefix = "roborepo dev"`) | renderer + generated output |
| Managed-file markers | `MANAGED_BY_ROBOREPO.md`, `.roborepo-managed` marker files, `roborepo-write-guard` hook | `globals/harnesses/*`, `manifests/platform/manifest.tsv`, `scripts/install/*.sh`, hooks |
| Ownership predicates | `is_builtin_authored()`, `is_roborepo_managed` | `scripts/install/install-lib.sh` (+ consumers) |
| Shell PID/state paths | `~/.local/state/roborepo/...` | `scripts/cli/state-paths.mjs`, install scripts |
| Package-internal dirs | `~/.roborepo/workspace` (workspaceRoot default) | `scripts/cli/roots.mjs` |
| Test fixtures | `codethings-roborepo-alpha` fixture dirs, `github.com/kirinmurphy/roborepo` fixture URLs | `scripts/test/*` |
| Telemetry identity | `version` reported as `app_version`, repo label `roborepo` | telemetry modules |

Non-code surfaces: `docs/user/reference/roborepo{,-cli,-skills}.md` (185 refs), README (44), docs/plans (2,868 refs, historical), skill dirs `builtin-support` / `roborepo-development` / `builtin-code-style`, generated harness output, `docs/plans/backlog/roborepo-repository-plans.zip`.

## Classification

### 1. References that should remain explicit (no consolidation)
- **`bin/roborepo`, `package.json` `bin`** — the executable boundary itself.
- **`scripts/cli/roots.mjs`** `stateRoot`/`workspaceRoot` defaults — the machine-facing contract.
- **Env-var literals `ROBOREPO_*`** — they are a public interface; each literal is its own definition site. (A rename later maps them explicitly, one rule per var family — see manifest.)
- **`package.json` name/bin/version fields** — metadata, inherently a literal.
- **Historical plan docs under `docs/plans/`** — dated records; they stay as-written (like git history). Only *living* docs matter for the rename.
- **`docs/plans/backlog/roborepo-repository-plans.zip`** — binary artifact.

### 2. Consolidated behind a canonical source (Phase 1 cleanup)
- **CLI display name in help text** — `manifests/platform/cli-commands.json` already has `commandName` + `title` and `help-renderer.mjs` already interpolates `catalog.commandName` (the interactive help tree is fine). But ~39 hardcoded `usage: roborepo …` strings in `scripts/cli/*.mjs` bypass the catalog. Those live in module-local usage printers; consolidating all of them is churn with real regression risk in a zero-dep CLI. **Decision: leave the usage-string literals; the rename manifest maps them mechanically (single unambiguous pattern `usage: roborepo`), and `cli-commands.json` remains the one canonical definition the tool rewrites.**
- **Portal window global / auth header / theme key** — server + client pairs already reference each other through one injection point (`portal-server.mjs`) and one read module (`portal/shared/api.js`); no third copy exists. Nothing to consolidate; the rename manifest carries each pair explicitly.

### 3. Permanently reworded so they stop mentioning the product name
Fixed in this cleanup (commit 1):
- `scripts/cli/state-paths.mjs:8` comment — "since roborepo has several small state files" → "since the CLI has several small state files".
- `scripts/cli/roots.mjs:72` — `requireDevelopmentCheckout` error: "this roborepo install is running in package mode" → "this install is running in package mode" (user-facing message that gains nothing from the brand).
- `scripts/cli/roots.mjs:9-11` comment — `~/.roborepo/workspace` prose stays (it names the real path, see §4).

Deliberately NOT reworded (prose that legitimately names the product): README, user-guide docs, portal home/config copy ("Welcome to RoboRepo", "Uninstall RoboRepo"), `MANAGED_BY_ROBOREPO.md` (it IS the branding artifact), `globals/system/skills/builtin-support/SKILL.md`, plan docs.

### 4. Identifiers that cannot be abstracted — explicit migration later
These are real persisted identifiers; a rename must handle them deliberately (they are enumerated in the rename manifest, never swept):
1. `~/.roborepo` — existing installs' state dir. Every state path derives from `stateRoot`; the tool moves the dir + writes a pointer, or a compat fallback reads the old path. **Proposed simplest strategy: one-time migrate-on-first-run in `roots.mjs` (if new dir missing and old exists → rename dir), no parallel-path compat layer.**
2. `codethings-roborepo-alpha` — npm package identity. Changing it breaks `npm install -g` for existing users (old install keeps working but never updates). Migration = new package + `npm deprecate` on the old.
3. `bin/roborepo` + package.json `bin` — old global symlink remains after update; uninstall path in `uninstall-lib.sh` knows both layouts.
4. `.roborepo-managed` marker files — written into harness skill dirs; old markers must still be *recognized* by `install-lib.sh` ownership checks or old installs' content looks un-owned (see `is_builtin_authored`). **Simplest strategy: recognize both markers, write only the new one.**
5. `MANAGED_BY_ROBOREPO.md` — filename is content-addressed in `manifests/platform/manifest.tsv` (managed_copy rows) and referenced by presets; rename is a manifest+file rename in lockstep, plus a cleanup row for the old name.
6. `X-Roborepo-Portal-Token` / `window.ROBOREPO_PORTAL` / `roborepo-theme` — internal (same-repo server+client), safe to rename atomically; no persisted data except localStorage key (cosmetic: users lose saved theme once).
7. `roborepo-write-guard` hook name + `roborepo-permissions.toml` filename — referenced in harness config files already applied on user machines; rename requires regenerate + cleanup of old files (manifest.tsv cleanup rows handle this pattern already).
8. Env vars `ROBOREPO_*` — test harnesses, installers, and user shells may export them. Rename manifest maps each family; keep `ROBOREPO_STATE_DIR` as a read fallback for one release if we want zero user action.
9. Telemetry persisted identity: `app_version` field name and `git:github.com/kirinmurphy/roborepo` repo IDs in machine-local registries — changing the field name orphans existing spool data; changing repo IDs is NOT desirable (they track real repos). Manifest marks these intentionally-unchanged or versioned.
10. `github.com/kirinmurphy/roborepo` remote/URLs in test fixtures — external identity, rename only when the GitHub repo itself is renamed.

## Remaining canonical naming surfaces after Phase 1 (the rename manifest's job)

Exactly these definition points remain (all others derive or are prose):
1. `package.json` (`name`, `bin`)
2. `bin/roborepo` (filename + shebang script)
3. `manifests/platform/cli-commands.json` (`commandName`, `title`, `helpLabels.scopedHelpHint`)
4. `scripts/cli/roots.mjs` (`~/.roborepo` default)
5. `scripts/cli/state-paths.mjs` (`~/.local/state/roborepo` legacy PID path)
6. `scripts/cli/uninstall.mjs` (`NPM_PACKAGE` const)
7. `scripts/install/uninstall-lib.sh` (npm layout matchers)
8. `scripts/install/install-lib.sh` / manifests (`MANAGED_BY_ROBOREPO.md`, `.roborepo-managed`, `is_builtin_authored`)
9. `scripts/cli/portal-server.mjs` + `portal/shared/{api,theme}.js` (`ROBOREPO_PORTAL`, `X-Roborepo-Portal-Token`, `roborepo-theme`, `roborepo:themechange`)
10. `~/.local/state/roborepo` + `generated/gemini/policies/roborepo-permissions.toml` filename references
11. Docs/skill display-name prose (README, docs/user, portal HTML copy) — free-text sweep
12. ~39 `usage: roborepo …` strings in CLI modules — mechanical free-text sweep
13. Env-var prefix `ROBOREPO_` — explicit per-family mapping
14. Test fixtures using the npm name / GitHub URL — explicit mapping
