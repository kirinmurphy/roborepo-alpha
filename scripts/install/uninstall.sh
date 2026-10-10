#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
dry_run=0
check_clean=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --check-clean) check_clean=1 ;;
    *) echo "usage: $0 [--dry-run] [--check-clean]" >&2; exit 2 ;;
  esac
  shift
done

# shellcheck source=scripts/lib/manifests-data.sh
source "${repo_root}/scripts/lib/manifests-data.sh"
# shellcheck source=scripts/install/state-lib.sh
source "${repo_root}/scripts/install/state-lib.sh"
# shellcheck source=scripts/install/install-lib.sh
# Provides is_builtin_authored and content_matches_repo_source — single source of truth shared
# with install.sh's mutation path instead of two hand-kept-in-sync copies.
source "${repo_root}/scripts/install/install-lib.sh"
# shellcheck source=scripts/install/uninstall-lib.sh
# Reusable removal building blocks — also sourced by `roborepo harness withdraw <id>`
# (scripts/cli/harness.mjs shells to a small bash entrypoint) to reuse the same logic scoped to
# one provider.
source "${repo_root}/scripts/install/uninstall-lib.sh"

if [[ "${check_clean}" -eq 1 ]]; then
  check_no_active_remnants
  exit $?
fi

stop_cli_processes

while IFS=$'\t' read -r _h kind src_rel home_abs _flags; do
  case "${kind}" in
    managed_copy)    reclaim_link_target          "${src_rel}" "${home_abs}" "${_h}" ;;
    link)            reclaim_link_target          "${src_rel}" "${home_abs}" "${_h}" ;;
    cleanup)         remove_repo_symlink          "${home_abs}" ;;
    root_config)     remove_root_config           "${home_abs}" "${_h}" "${src_rel}" ;;
    rendered_rules)  reclaim_rendered_rules_target "${home_abs}" "${_h}" ;;
  esac
done < <(manifest_rows)

strip_package_hooks
if command -v node >/dev/null 2>&1; then
  if [[ "${dry_run}" -eq 1 ]]; then
    node "${repo_root}/scripts/cli/package-projection-cleanup.mjs" --all --dry-run || true
  else
    node "${repo_root}/scripts/cli/package-projection-cleanup.mjs" --all || true
  fi
fi

while IFS=$'\t' read -r _id home_path _present _display_name _root_config_path; do
  [[ -z "${home_path}" ]] && continue
  remove_skill_links "${home_path}/skills"
done < <(harness_detected_rows)

remove_file_if_repo_symlink "${HOME}/.local/bin/roborepo" "${repo_root}/bin/roborepo"
remove_shell_wiring

state_file="$(cli_state_file)"
if [[ -f "${state_file}" ]]; then
  if [[ "${dry_run}" -eq 1 ]]; then
    echo "remove: ${state_file}"
  else
    rm "${state_file}"
    echo "remove: ${state_file}"
  fi
fi

remove_mcp_servers
remove_gitignore_globals
remove_preset_state
remove_rules_state
remove_install_backups
remove_runtime_state
remove_durable_install_backups

# A dry run removed nothing, so the remnant check would always report the state it just previewed
# and exit nonzero. Verifying cleanliness is only meaningful after a real run.
if [[ "${dry_run}" -eq 1 ]]; then
  echo "Dry run complete. Nothing was removed."
  exit 0
fi

check_no_active_remnants
echo "Uninstall complete."
