# Config Collision Internals

Implementation notes for root-config drift and collision handling, for people changing the
installers. User-facing behavior is in
[Config Collision Handling](../user/reference/config-collision-handling.md).

## Install Paths

All three install paths (`presets.mjs` JS bundle-apply,
`install-lib.sh` bash direct-installer, `install-windows.ps1` PowerShell) implement the drift check. On
Windows both the `Invoke-RootConfigPreflight` collision resolver and the later
`Export-UserConfig` write path are drift-aware, so a clean baseline change is not wrongly prompted as
a collision.

In the full `scripts/install/main.sh` flow, the JS bundle apply (`presets.mjs` `copyItem`) runs
before the bash `export_user_config`, so it decides what happens to a drifted root config first.
Both paths must apply the same policy table, and staging skips a candidate identical to one already
staged so the two passes do not stage twice.

## Uninstall

The same drift signal governs removal: `uninstall.sh`'s `remove_root_config` deletes a
root config only when it still matches the recorded hash (`clean`), or when there is no recorded write
(`unwritten`/`missing`) and the content-based checks say it is roborepo's. A `drifted` file — one the
user edited after roborepo's last write — is left in place with its path reported, never deleted, even
though its roborepo markers would otherwise match. `--check-clean` treats a deliberately-kept drifted
file as expected, not a remnant.

## Drift View

`roborepo config root inspect` (terminal) and the `/agents` portal
drift chip both render from one shared producer, `config.mjs::buildRootConfigView()`, which maps each
harness to a single state: `not-installed`, `unwritten`, `in-sync`, `drifted`, or `staged-pending` (a
`*_update_TIMESTAMP` sibling beside the active file, which outranks plain drift because a pending
staged update is the actionable signal).

## Tests

Run:

```sh
./scripts/test/test-install-collisions.sh
./scripts/test/test-cli.sh
node scripts/test/root-config-state-check.mjs
```

These tests use temporary home directories and cover collision policies, backup behavior, rendered
rules, package toggles, and uninstall restoration. `test-install-collisions.sh` includes root-config
drift regression coverage:

- `test_root_config_drift_silent_update_vs_real_collision` — a baseline change updates silently, a
  real user edit is treated as a collision.
- `test_root_config_keep_policy_does_not_record_false_clean` — `keep` policy must not record a write
  for a file it left untouched.
- `test_uninstall_preserves_drifted_root_config` /
  `test_uninstall_check_clean_tolerates_drifted_root_config` — uninstall leaves a drifted root config
  in place (reporting its path) and `--check-clean` does not flag it as a remnant.
- `test_windows_installer_root_collision_dedup_and_drift` — the Windows installer's collision menu is
  a single shared helper, and its preflight is drift-aware (structural assertions; no PowerShell on
  the host).
- `test_full_install_drifted_root_config_honors_policy` — runs the full `main.sh` flow with stub
  harness binaries and checks `keep`, `overwrite`, and `abort` against a drifted root config.

`root-config-state-check.mjs` unit-tests the hash sidecar directly; `root-config-view-check.mjs`
unit-tests the per-harness drift *view* (`not-installed` / `unwritten` / `in-sync` / `drifted` /
`staged-pending`) that both `roborepo config root inspect` and the `/agents` portal drift chip render
from. Both are wired into `test-cli.sh`.
