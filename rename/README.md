# Rename runbook

The tool: `rename/rename.mjs`, driven entirely by `rename/manifest.json`. All name knowledge
lives in the manifest; the script has none. Reusable for any future naming change — after a
successful rename the tool rewrites `identity.current` in the manifest, so the same rules keep
working.

Status: **rename not performed**. The repo still says RoboRepo everywhere user-visible.
Internal identifiers were already de-branded in phase 1b (`builtin-*`, `stateDir`, `cli-*`,
`app_version`) — the manifest's rules account for that.

## When you pick the name

```bash
# 1. Preview (no writes). Shows every file, line, and path rename.
node rename/rename.mjs --dry-run \
  --new-lowercaseName=<new> \
  --new-displayName='<New Name>' \
  --new-packageName=<scope>-<new>        # only if renaming the npm package
  # --new-configDir=.    <new>            # only if renaming ~/.roborepo (deliberate opt-in)
  # --new-repoUrl=github.com/<you>/<new>  # only if the GitHub repo is renamed too

# 2. Review the plan:
#    [explicit <rule>]  deterministic replacements from the manifest rules
#    [safe]             free-text sweep hits (prose, comments, usage strings)
#    [pending]          claimed but NOT changed — an identity field you didn't supply
#    ambiguous          never auto-changed; rewrite by hand or pass --ack

# 3. Apply (edits git-tracked files, git-mv's paths, updates manifest identity).
node rename/rename.mjs --apply --new-lowercaseName=<new> --new-displayName='<New Name>'

# 4. Regenerate generated/ output in a dev checkout (excluded from the tool by design):
#    config apply / rules-render — or pass --include-generated to force-edit instead.

# 5. Verify nothing is left behind:
node rename/rename.mjs --check          # exit 0 = no unexplained references remain
npm run check && npm test               # full gate
```

## What the tool will NOT do (by design)

- `docs/plans/`, `sketches/`, `portal/mockups/` — historical/design artifacts stay as-written
- `generated/` — regenerate from source instead (or `--include-generated`)
- `.git`, `node_modules`, binaries, lockfile data, `rename/` itself
- Ambiguous case mixes (`RoBoRePo`) without `--ack`
- Unset identity fields (`packageName`, `configDir`, `repoUrl`, `schemaDomain`) — they stay
  unchanged and are reported as pending decisions, never guessed

## Backward-compat decisions (from the manifest `backCompat` — still yours to make at rename time)

With no active users, most compat burden is gone. Remaining real-world steps if you want them:

1. **`~/.roborepo` state dir**: default is rename-gated behind `--new-configDir` (off by
   default). Simplest strategy if changed: migrate-on-first-run in `scripts/cli/roots.mjs`.
2. **npm package rename**: publish new name, `npm deprecate` the old one. `bin/roborepo`
   symlinks in user PATHs are orphaned; `scripts/install/uninstall-lib.sh` recognizes both
   layouts.
3. **`MANAGED_BY_ROBOREPO.md` / applied harness files**: rename is atomic in-repo, but files
   already applied on a machine need cleanup — add manifest.tsv cleanup rows for the old
   filename (existing pattern) so the next `config apply` removes them.
4. **`.roborepo-managed` markers** in user harness dirs: `install-lib.sh` ownership checks
   should recognize the old marker while writing only the new one.
5. **Env vars `ROBOREPO_*`**: rename maps the whole family in one rule. Users' shells may
   export them; keep `ROBOREPO_STATE_ROOT` readable as a fallback for one release if you ever
   have real users.
6. **GitHub repo URLs / `roborepo.dev` schema domain**: external identities, claimed but
   never auto-replaced.
