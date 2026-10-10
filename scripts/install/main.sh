#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
dry_run=0
skip_presets_onboard=0
package_mode="${ROBOREPO_PACKAGE_MODE:-0}"
on_conflict="${ROBOREPO_ON_CONFLICT:-}"
on_conflict_explicit=0
on_conflict_persisted=0
[[ -n "${on_conflict}" ]] && on_conflict_explicit=1
backup_root="${ROBOREPO_BACKUP_ROOT:-${HOME}/.cli-backups/$(date +%Y%m%d-%H%M%S)}"
export ROBOREPO_BACKUP_ROOT="${backup_root}"
export ROBOREPO_INSTALL_TIMESTAMP="${ROBOREPO_INSTALL_TIMESTAMP:-$(date +%Y%m%d-%H%M%S)}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      dry_run=1
      shift
      ;;
    --no-presets-onboard)
      skip_presets_onboard=1
      shift
      ;;
    --telemetry-only)
      exec node "${repo_root}/scripts/cli/main.mjs" telemetry install
      ;;
    --on-conflict)
      [[ $# -ge 2 ]] || { echo "usage: $0 [--dry-run] [--no-presets-onboard] [--on-conflict overwrite|keep|abort]" >&2; exit 2; }
      on_conflict="$2"
      on_conflict_explicit=1
      shift 2
      ;;
    --on-conflict=*)
      on_conflict="${1#*=}"
      on_conflict_explicit=1
      shift
      ;;
    *)
      echo "usage: $0 [--dry-run] [--no-presets-onboard] [--on-conflict overwrite|keep|abort]" >&2
      exit 2
      ;;
  esac
done

case "${on_conflict}" in
  "" ) ;;
  overwrite|keep|abort) ;;
  *) echo "usage: $0 [--dry-run] [--no-presets-onboard] [--on-conflict overwrite|keep|abort]" >&2; exit 2 ;;
esac
export ROBOREPO_ON_CONFLICT="${on_conflict}"

dry_args=()
[[ $dry_run -eq 1 ]] && dry_args=(--dry-run)

# shellcheck source=scripts/install/install-lib.sh
source "${repo_root}/scripts/install/install-lib.sh"
# shellcheck source=scripts/build/skill-lib.sh
source "${repo_root}/scripts/build/skill-lib.sh"  # provides list_source_skills (for link_global_skills)
# shellcheck source=scripts/install/state-lib.sh
source "${repo_root}/scripts/install/state-lib.sh"
# shellcheck source=scripts/lib/manifests-data.sh
source "${repo_root}/scripts/lib/manifests-data.sh"  # provides manifest_rows

choose_adopt_conflict_policy() {
  if [[ -n "${on_conflict}" ]]; then
    return 0
  fi

  on_conflict="$(read_install_on_conflict 2>/dev/null || true)"
  if [[ -n "${on_conflict}" ]]; then
    on_conflict_persisted=1
    return 0
  fi

  if ! stdin_is_interactive; then
    on_conflict="keep"
    echo "non-interactive install: defaulting --on-conflict=keep (pass --on-conflict to override)" >&2
    return 0
  fi

  local header
  header="$(printf '\n===============================================\nWelcome to roborepo, your CLI harness manager\n===============================================\n\nThis install will add certain content to your system to optimize your experience.\nIf you already have active files, should we:\n\n')"
  on_conflict="$(prompt_conflict_choice "${header}" "/dev/stderr" "/dev/stdin")"
  if [[ "${on_conflict}" == "abort" ]]; then
    echo "install canceled by user" >&2
    exit 1
  fi
}

choose_adopt_conflict_policy
export ROBOREPO_ON_CONFLICT="${on_conflict}"

run_with_dry_args() {
  if [[ $dry_run -eq 1 ]]; then
    "$1" --dry-run
  else
    "$1"
  fi
}

# Windows: delegate to PowerShell installer, then continue for bash-specific steps
case "$(uname -s 2>/dev/null || echo unknown)" in
  MINGW*|MSYS*|CYGWIN*)
    echo "Windows + bash detected (Git Bash or similar)."
    if command -v powershell.exe &>/dev/null; then
      echo "Running PowerShell installer..."
      ps_args=(-ExecutionPolicy Bypass -File "${repo_root}/scripts/install/install-windows.ps1")
      [[ $dry_run -eq 1 ]] && ps_args+=(-DryRun)
      powershell.exe "${ps_args[@]}"
    else
      echo "powershell.exe not found. Run scripts/install/install-windows.ps1 from PowerShell manually."
    fi
    # Shell snippets and global commands still need bash in checkout mode. In package mode npm owns
    # command exposure, so applying harness config must not mutate PATH or ~/.local/bin.
    run_with_dry_args "${repo_root}/scripts/install/install-gitignore-globals.sh"
    if [[ $dry_run -eq 0 && "${package_mode}" != "1" ]]; then
      "${repo_root}/scripts/install/install-global-commands.sh"
      "${repo_root}/scripts/install/install-shell-snippets.sh"
    fi
    exit 0
    ;;
esac

# Detect which harnesses are present, from the provider registry (scripts/harnesses/) via
# `roborepo harness detected` — not a fixed two-harness enum. present_harness_ids holds the ids
# present on this machine; present_harness_rows/all_harness_rows keep the full
# id/home/present/displayName/rootConfigPath rows for the sections below.
present_harness_ids=()
present_harness_rows=()
all_harness_rows=()
while IFS=$'\t' read -r id home_path present display_name root_config_path; do
  [[ -z "${id}" ]] && continue
  all_harness_rows+=("${id}	${home_path}	${present}	${display_name}	${root_config_path}")
  if [[ "${present}" == "1" ]]; then
    present_harness_ids+=("${id}")
    present_harness_rows+=("${id}	${home_path}	${present}	${display_name}	${root_config_path}")
  fi
done < <(harness_detected_rows)

preflight_shell_setup() {
  "${repo_root}/scripts/install/install-global-commands.sh" --dry-run
  "${repo_root}/scripts/install/install-shell-snippets.sh" --dry-run
}


# Durable, once-only snapshot of the user's genuine pre-install config — taken before the first
# mutation below so uninstall/reinstall cycles always have a pristine image to fall back on.
snapshot_pre_install_original

install_section "Shell & PATH"
if [[ "${package_mode}" == "1" ]]; then
  echo "package mode: npm owns the roborepo command; skipping ~/.local/bin and shell profile setup."
else
  preflight_shell_setup
fi

# Harness-agnostic setup
run_with_dry_args "${repo_root}/scripts/install/install-gitignore-globals.sh"

# Shell and PATH setup (harness-agnostic, bash only)
if [[ $dry_run -eq 0 && "${package_mode}" != "1" ]]; then
  "${repo_root}/scripts/install/install-global-commands.sh"
  "${repo_root}/scripts/install/install-shell-snippets.sh"
fi

write_install_state "${on_conflict}"

install_section "Base Skill"
if [[ $dry_run -eq 0 && "${#present_harness_rows[@]}" -gt 0 ]]; then
  for row in "${present_harness_rows[@]}"; do
    IFS=$'\t' read -r _id home_path _present _display_name _root_config_path <<< "${row}"
    link_global_skills "${home_path}" --preserve-existing builtin-support
  done
fi

presets_onboarded() {
  node -e '
const fs = require("fs");
try {
  const state = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.exit(state?.onboardedAt ? 0 : 1);
} catch {
  process.exit(1);
}
' "$(cli_state_dir)/presets/state.json"
}

# After core install, apply the minimal default bundle set (just `base`), then hand off to the
# onboarding wizard so the user opts into the rest. The wizard (`roborepo package manage`) is interactive on
# a TTY and falls back to a headless default apply when not — so noninteractive and skipped installs
# still land a working baseline without prompting.
run_post_install_onboarding() {
  if [[ $dry_run -eq 1 ]]; then
    echo "dry-run: a real install would apply the base configuration, then start the onboarding wizard."
    return 0
  fi

  # Always land the minimal baseline first, so update can refresh rendered rules even when the
  # machine has already been onboarded. The onboarding wizard itself does not re-apply defaults.
  install_section "Base Configuration"
  node "${repo_root}/scripts/cli/main.mjs" package adopt-live
  node "${repo_root}/scripts/cli/main.mjs" bundle apply --default
  node "${repo_root}/scripts/cli/main.mjs" package reconcile
  if [[ "${#present_harness_rows[@]}" -gt 0 ]]; then
    for row in "${present_harness_rows[@]}"; do
      IFS=$'\t' read -r id _home _present _display_name root_config_path <<< "${row}"
      [[ -z "${root_config_path}" ]] && continue  # provider declares no root-config path (e.g. a future harness that lacks the capability)
      export_user_config "${id}" "generated/${id}/$(basename "${root_config_path}")" "${root_config_path}"
    done
  fi
  while IFS=$'\t' read -r _id home_path present _display_name _root_config_path; do
    [[ -z "${_id}" ]] && continue
    [[ "${present}" == "1" ]] || continue
    link_global_skills "${home_path}" --preserve-existing builtin-support
  done < <(harness_detected_rows)

  if presets_onboarded; then
    echo "Already onboarded. Run 'roborepo package manage' to change which behaviors are enabled."
    return 0
  fi

  if [[ "${skip_presets_onboard}" -eq 1 || "${ROBOREPO_PRESETS_ONBOARD:-}" == "skip" ]]; then
    # Mark onboarded without the intro: feeding /dev/null makes `onboard-intro` take its headless
    # path (record onboardedAt only — defaults already applied above), so later commands don't
    # re-prompt and the welcome page never shows.
    node "${repo_root}/scripts/cli/main.mjs" onboard-intro < /dev/null >/dev/null 2>&1 || true
    echo "Onboarding skipped. Choose optional behaviors later with: roborepo package manage"
    return 0
  fi

  # First install only: the welcome page + 4-option menu. The intro itself prints the full-width
  # "Welcome to roborepo" banner (node, terminal-width aware), so no separate bash banner here —
  # it would double up. Onboarding is no longer auto-run; option 1 of the intro launches it. Non-TTY:
  # intro records onboarding silently.
  node "${repo_root}/scripts/cli/main.mjs" onboard-intro
}

# Post-install summary: one line per known harness provider, from the registry rather than a
# fixed Claude/Codex pair.
install_section "Core Install Complete"
if [[ "${#all_harness_rows[@]}" -gt 0 ]]; then
  for row in "${all_harness_rows[@]}"; do
    IFS=$'\t' read -r _id _home present display_name _root_config_path <<< "${row}"
    status="${RR_DIM}not installed${RR_RESET}"
    [[ "${present}" == "1" ]] && status="${RR_GREEN}available${RR_RESET}"
    echo "  ${RR_BOLD}${display_name}${RR_RESET}  ${status}"
  done
fi
echo ""
echo "  ${RR_BOLD}Web portal${RR_RESET}  run ${RR_CYAN}roborepo web${RR_RESET} to manage behavior in the UI"
run_post_install_onboarding
if [[ "${package_mode}" == "1" ]]; then
  install_section "Workspace"
  if [[ $dry_run -eq 1 ]]; then
    node "${repo_root}/scripts/cli/workspace-resources.mjs" --dry-run
  else
    node "${repo_root}/scripts/cli/workspace-resources.mjs"
  fi
fi
if [[ "${#present_harness_ids[@]}" -lt "${#all_harness_rows[@]}" ]]; then
  echo ""
  echo "To add another harness later: install it, then run roborepo package manage again."
fi
