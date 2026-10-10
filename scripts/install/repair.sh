#!/usr/bin/env bash
set -euo pipefail

# roborepo repair — fix install damage after checkout moves, plus targeted local config recovery.
#
# Symptom this fixes: every managed link under ~/.claude and ~/.codex (including per-skill links
# under skills/) and the ~/.local/bin/roborepo command point at the checkout's old absolute path,
# so they dangle and `roborepo` drops off PATH.
#
# What it does: reclaim stale symlinks that still point at the prior checkout (or dangle),
# re-link the bin command against the current checkout, refresh the base shared skill view,
# and rewrite the recorded root. It does NOT re-copy managed content files/dirs; those are
# path-independent and are left untouched.
#
# Idempotent: a no-op when every link already points at the current checkout.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
backup_root="${ROBOREPO_BACKUP_ROOT:-${HOME}/.cli-backups/$(date +%Y%m%d-%H%M%S)}"
export ROBOREPO_BACKUP_ROOT="${backup_root}"
export ROBOREPO_INSTALL_TIMESTAMP="${ROBOREPO_INSTALL_TIMESTAMP:-$(date +%Y%m%d-%H%M%S)}"
dry_run=0
on_conflict="${ROBOREPO_ON_CONFLICT:-}"

usage() {
  echo "usage: $0 [local-config] [--dry-run|--apply] [--on-conflict overwrite|keep|abort]" >&2
}

if [[ "${1:-}" == "local-config" ]]; then
  shift
  exec node "${repo_root}/scripts/cli/local-config-repair.mjs" "$@"
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      dry_run=1
      shift
      ;;
    --on-conflict)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      on_conflict="$2"
      shift 2
      ;;
    --on-conflict=*)
      on_conflict="${1#*=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

case "${on_conflict}" in
  ""|overwrite|keep|abort) ;;
  *)
    usage
    exit 2
    ;;
esac

if [[ -n "${on_conflict}" ]]; then
  export ROBOREPO_ON_CONFLICT="${on_conflict}"
fi

# shellcheck source=scripts/install/install-lib.sh
source "${repo_root}/scripts/install/install-lib.sh"   # provides install_copy_item, link_global_skills
# shellcheck source=scripts/build/skill-lib.sh
source "${repo_root}/scripts/build/skill-lib.sh"       # provides list_source_skills (for link_global_skills)
# shellcheck source=scripts/lib/manifests-data.sh
source "${repo_root}/scripts/lib/manifests-data.sh"    # provides manifest_rows
# shellcheck source=scripts/install/state-lib.sh
source "${repo_root}/scripts/install/state-lib.sh"     # provides read_install_repo / write_install_state

if [[ -z "${on_conflict}" ]]; then
  on_conflict="$(read_install_on_conflict 2>/dev/null || true)"
fi
recorded_repo="$(read_install_repo 2>/dev/null || true)"
export ROBOREPO_RECORDED_REPO="${recorded_repo}"

# Reclaim cleanup rows that are now stale because the checkout moved or the symlink dangles.
repair_cleanup_target() {
  local home_abs="$1"
  if [[ ! -L "${home_abs}" ]]; then
    return 0
  fi

  local current
  current="$(readlink "${home_abs}" 2>/dev/null || true)"

  if [[ -n "${recorded_repo}" ]]; then
    case "${current}" in
      "${recorded_repo}"/*) ;;
      "${repo_root}"/*) ;;
      *)
        if [[ -e "${home_abs}" ]]; then
          return 0
        fi
        ;;
    esac
  elif [[ -e "${home_abs}" ]]; then
    case "${current}" in
      "${repo_root}"/*) ;;
      *)
        return 0
        ;;
    esac
  fi

  if [[ "${dry_run}" -eq 1 ]]; then
    echo "remove: ${home_abs}"
  else
    rm "${home_abs}"
    echo "remove: ${home_abs}"
  fi
}

repair_cleanup_rows() {
  local harness="$1"
  while IFS=$'\t' read -r _h kind src_rel home_abs _flags; do
    [[ "${kind}" == "cleanup" ]] || continue
    repair_cleanup_target "${home_abs}"
  done < <(manifest_rows "$1")
}

# Per-skill copies: repair only re-materializes the base support skill. Optional skills are
# controlled by onboarding/package toggles.
repair_skill_links() {
  link_global_skills "${1%/skills}" builtin-support
}

# Iterates every registered provider instead of a fixed Claude/Codex pair. home_path is always the resolved manifest location
# regardless of presence, so the -d guard still decides whether repair touches this machine's copy.
while IFS=$'\t' read -r id home_path _present _display_name _root_config_path; do
  [[ -z "${id}" ]] && continue
  [[ -d "${home_path}" ]] && repair_cleanup_rows "${id}"
done < <(harness_detected_rows)

while IFS=$'\t' read -r id home_path _present _display_name _root_config_path; do
  [[ -z "${id}" ]] && continue
  [[ -d "${home_path}" ]] && repair_skill_links "${home_path}/skills"
done < <(harness_detected_rows)

# Bin command: install-global-commands.sh now self-heals a dangling link. Pass --dry-run
# only when set; avoid expanding an empty array under `set -u` (unbound on bash 3.2 / macOS).
if [[ "${dry_run}" -eq 1 ]]; then
  "${repo_root}/scripts/install/install-global-commands.sh" --dry-run
else
  "${repo_root}/scripts/install/install-global-commands.sh"
fi

# Re-record the current checkout as the active install.
write_install_state "${on_conflict}"

echo "Repair complete. Run 'roborepo doctor --installed' to confirm."
node "${repo_root}/scripts/cli/local-config-repair.mjs" --hint || true
