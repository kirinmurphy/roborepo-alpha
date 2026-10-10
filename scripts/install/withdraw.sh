#!/usr/bin/env bash
set -euo pipefail

# `roborepo harness withdraw <id>`: actively unmerges RoboRepo's previously-written content back
# out of ONE provider's live config, reusing uninstall's per-capability removal logic
# (scripts/install/uninstall-lib.sh) scoped to that provider instead of running the full
# uninstall. Distinct from `harness disable <id>` (flips a state bit only, never touches
# files): withdraw is the explicit, confirmable action that actually removes RoboRepo's content.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
dry_run=0
assume_yes=0
harness_id=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --yes) assume_yes=1 ;;
    -*) echo "usage: $0 <harness-id> [--dry-run] [--yes]" >&2; exit 2 ;;
    *)
      if [[ -n "${harness_id}" ]]; then
        echo "usage: $0 <harness-id> [--dry-run] [--yes]" >&2
        exit 2
      fi
      harness_id="$1"
      ;;
  esac
  shift
done

if [[ -z "${harness_id}" ]]; then
  echo "usage: $0 <harness-id> [--dry-run] [--yes]" >&2
  exit 2
fi

# shellcheck source=scripts/lib/manifests-data.sh
source "${repo_root}/scripts/lib/manifests-data.sh"
# shellcheck source=scripts/install/state-lib.sh
source "${repo_root}/scripts/install/state-lib.sh"
# shellcheck source=scripts/install/install-lib.sh
source "${repo_root}/scripts/install/install-lib.sh"
# shellcheck source=scripts/install/uninstall-lib.sh
source "${repo_root}/scripts/install/uninstall-lib.sh"

if ! harness_detected_rows | cut -f1 | grep -Fqx "${harness_id}"; then
  echo "unknown harness: ${harness_id}" >&2
  exit 2
fi

if [[ "${dry_run}" -eq 0 && "${assume_yes}" -eq 0 ]]; then
  if ! stdin_is_interactive; then
    echo "withdraw mutates live files — pass --yes to confirm in a non-interactive shell, or --dry-run to preview." >&2
    exit 1
  fi
  echo "This will remove RoboRepo's managed content from ${harness_id}'s live config (root config, hooks, MCP entries, linked skills/commands)."
  read -r -p "Continue? [y/N] " reply
  case "${reply}" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "withdraw canceled." >&2; exit 1 ;;
  esac
fi

echo "withdraw: ${harness_id}"

while IFS=$'\t' read -r _h kind src_rel home_abs _flags; do
  case "${kind}" in
    managed_copy)    reclaim_link_target          "${src_rel}" "${home_abs}" "${_h}" ;;
    link)            reclaim_link_target          "${src_rel}" "${home_abs}" "${_h}" ;;
    cleanup)         remove_repo_symlink          "${home_abs}" ;;
    root_config)     remove_root_config           "${home_abs}" "${_h}" "${src_rel}" ;;
    rendered_rules)  reclaim_rendered_rules_target "${home_abs}" "${_h}" ;;
  esac
done < <(manifest_rows "${harness_id}")

# hooks.write and mcp.remove are Claude-only real adapters as of this pass (Codex hooks/MCP live in
# separate sidecars not yet migrated — see uninstall-lib.sh's strip_package_hooks/remove_mcp_servers
# comments). Report that gap explicitly for a Codex withdraw rather than silently doing nothing.
if [[ "${harness_id}" == "claude" ]]; then
  strip_package_hooks
  remove_mcp_servers
else
  echo "unsupported: hooks.write has no ${harness_id} adapter yet — hooks/permissions were not withdrawn" >&2
  echo "unsupported: mcp.remove has no ${harness_id} adapter yet — MCP entries were not withdrawn" >&2
fi

while IFS=$'\t' read -r id home_path _present _display_name _root_config_path; do
  [[ "${id}" == "${harness_id}" ]] || continue
  [[ -z "${home_path}" ]] && continue
  remove_skill_links "${home_path}/skills"
done < <(harness_detected_rows)

echo "withdraw complete: ${harness_id}"
