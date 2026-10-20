#!/usr/bin/env bash
# Shared helpers for install scripts. Source this file, do not execute directly.

# State-dir helpers (cli_state_dirname/cli_state_dir/cli_state_file). Guarded: main.sh sources
# state-lib.sh itself; standalone entries (install-harness.sh) source only this file.
if [[ "$(type -t cli_state_dirname 2>/dev/null || true)" != "function" ]]; then
  # shellcheck source=scripts/install/state-lib.sh
  source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/state-lib.sh"
fi

# --------------------------------------------------------------------------- output styling
# Color only when stdout is a real terminal, so redirected/captured logs stay plain. Guarded with
# ROBOREPO_NO_COLOR for an explicit opt-out. Set once; reused by main.sh and every sub-script.
if [[ -t 1 && -z "${ROBOREPO_NO_COLOR:-}" ]]; then
  RR_BOLD=$'\033[1m'; RR_DIM=$'\033[2m'; RR_RESET=$'\033[0m'
  RR_CYAN=$'\033[36m'; RR_GREEN=$'\033[32m'; RR_YELLOW=$'\033[33m'; RR_MAGENTA=$'\033[35m'
else
  RR_BOLD=""; RR_DIM=""; RR_RESET=""; RR_CYAN=""; RR_GREEN=""; RR_YELLOW=""; RR_MAGENTA=""
fi

# Bold cyan section header preceded by a blank line: visually breaks the install log into stages.
install_section() {
  printf '\n%s━━━ %s %s%s\n' "${RR_CYAN}${RR_BOLD}" "$1" "$(install_rule "$1")" "${RR_RESET}"
}

# Colorize a leading action keyword, preserving the legacy "<keyword>: <rest>" plain text exactly
# (tests assert on these strings, and the color codes are empty when stdout is not a TTY).
# Usage: say link "${home} -> ${src}"   ->  "<green>link<reset>: ${home} -> ${src}"
say() {
  local kw="$1"; shift
  local color="${RR_DIM}"
  case "${kw}" in
    link|relink|added) color="${RR_GREEN}" ;;
    copy) color="${RR_CYAN}" ;;
    backup|"pre-install backup") color="${RR_YELLOW}" ;;
    ok) color="${RR_DIM}" ;;
  esac
  printf '%s%s%s: %s\n' "${color}" "${kw}" "${RR_RESET}" "$*"
}

# Pad a section title's trailing rule out to a fixed width so headers line up.
install_rule() {
  local width=44 used=$(( ${#1} + 4 )) n=0 out=""
  n=$(( width - used )); (( n < 0 )) && n=0
  while (( n-- > 0 )); do out+="━"; done
  printf '%s' "${out}"
}

unique_backup_path() {
  local home_path="$1"
  local backup_path="${backup_root}${home_path}"

  if [[ ! -e "${backup_path}" && ! -L "${backup_path}" ]]; then
    echo "${backup_path}"
    return 0
  fi

  local i=1
  while [[ -e "${backup_path}.${i}" || -L "${backup_path}.${i}" ]]; do
    i=$((i + 1))
  done
  echo "${backup_path}.${i}"
}

timestamped_path() {
  local path="$1"
  local tag="$2"
  local ts="${ROBOREPO_INSTALL_TIMESTAMP:-$(date +%Y%m%d-%H%M%S)}"
  local dir base name ext

  dir="$(dirname "${path}")"
  base="$(basename "${path}")"
  if [[ -d "${path}" && ! -L "${path}" ]]; then
    echo "${dir}/${base}_${tag}_${ts}"
    return 0
  fi

  case "${base}" in
    *.*)
      name="${base%.*}"
      ext=".${base##*.}"
      echo "${dir}/${name}_${tag}_${ts}${ext}"
      ;;
    *)
      echo "${dir}/${base}_${tag}_${ts}"
      ;;
  esac
}

# Newest existing <name>_<tag>_<timestamp><ext> sibling of a file, or nothing. Timestamps sort
# lexically, so the last glob match is the newest.
latest_timestamped_sibling() {
  local path="$1"
  local tag="$2"
  local dir base name ext match latest=""

  dir="$(dirname "${path}")"
  base="$(basename "${path}")"
  case "${base}" in
    *.*) name="${base%.*}"; ext=".${base##*.}" ;;
    *) name="${base}"; ext="" ;;
  esac
  for match in "${dir}/${name}_${tag}_"*"${ext}"; do
    [[ -f "${match}" ]] && latest="${match}"
  done
  [[ -n "${latest}" ]] && echo "${latest}"
  return 0
}

copy_tree() {
  local src="$1"
  local dest="$2"

  if [[ -d "${src}" && ! -L "${src}" ]]; then
    mkdir -p "$(dirname "${dest}")"
    cp -R "${src}" "${dest}"
  else
    mkdir -p "$(dirname "${dest}")"
    cp -p "${src}" "${dest}"
  fi
}

stdin_is_interactive() {
  [[ -t 0 || "${ROBOREPO_ASSUME_INTERACTIVE:-0}" == "1" ]]
}

# Subdirectories of ${dest} that roborepo itself installs from a DIFFERENT manifest row, and which
# therefore have no counterpart under the repo source of THIS row. One manifest target may nest
# inside another (claude: `hooks/provider` lands inside `hooks`), so a plain `diff -r` sees
# roborepo's own second install as an extra directory and concludes the user modified the first.
# Emitted as `diff` exclude patterns, matched by basename.
_nested_manifest_excludes() {
  local dest="$1" home_abs
  declare -f manifest_rows >/dev/null 2>&1 || return 0
  while IFS=$'\t' read -r _harness _kind _src_rel home_abs _flags; do
    [[ -n "${home_abs}" ]] || continue
    # Strictly BELOW dest, and only the immediate child dest/<name> — deeper paths are already
    # inside a child this loop emits.
    [[ "${home_abs}" == "${dest}/"* ]] || continue
    local rel="${home_abs#"${dest}"/}"
    [[ "${rel}" == */* ]] && continue
    printf -- '--exclude=%s\n' "${rel}"
  done < <(manifest_rows)
}

# THE content comparison. Both public predicates below delegate here; do not add a third copy.
#
# True when ${dest} is a REAL (non-symlink) path byte-for-byte identical to repo source ${src}:
# files compared with cmp, directories with `diff -r`. Any divergence — an extra file, one edited
# line — returns false, so callers never treat user content as a disposable repo copy.
#
# The one thing that does NOT count as divergence is another roborepo manifest target nested inside
# this one: that content is roborepo's own, installed by a different row and reclaimed by that row's
# own pass. Counting it would make two nested rows permanently unreclaimable (the outer dir looks
# user-modified from the moment the inner row installs) AND non-idempotent to reinstall (the same
# mismatch routes an already-current path to the collision prompt).
_paths_have_identical_content() {
  local src="$1"
  local dest="$2"

  if [[ -f "${src}" && -f "${dest}" ]]; then
    cmp -s "${src}" "${dest}"
    return $?
  fi
  if [[ -d "${src}" && -d "${dest}" ]]; then
    # bash 3.2 (the macOS default) treats "${arr[@]}" on an empty array as an unbound variable under
    # `set -u`, so the no-nested-rows case must not expand the array at all.
    local -a excludes=()
    while IFS= read -r line; do
      [[ -n "${line}" ]] && excludes+=("${line}")
    done < <(_nested_manifest_excludes "${dest}")
    if [[ ${#excludes[@]} -eq 0 ]]; then
      diff -r "${src}" "${dest}" >/dev/null 2>&1
    else
      diff -r "${excludes[@]}" "${src}" "${dest}" >/dev/null 2>&1
    fi
    return $?
  fi
  return 1
}

# Install-side: is ${dest} already exactly what this copy would write, so the copy is a no-op?
# ${dest} must exist; a symlink is never "equivalent" (the copy replaces it with a real path).
paths_equivalent_for_copy() {
  local src="$1"
  local dest="$2"

  [[ -e "${dest}" || -L "${dest}" ]] || return 1
  [[ -L "${dest}" ]] && return 1
  _paths_have_identical_content "${src}" "${dest}"
}

# Uninstall/backup-side: is ${dest} a builtin-authored copy (adopt-mode install, or a legacy
# materialized link) rather than genuine user content? Additionally requires ${src} to exist —
# with no repo source to compare against there is no basis to call ${dest} roborepo's.
content_matches_repo_source() {
  local src="$1"
  local dest="$2"

  [[ -e "${src}" ]] || return 1
  [[ -e "${dest}" && ! -L "${dest}" ]] || return 1
  _paths_have_identical_content "${src}" "${dest}"
}

path_has_meaningful_content() {
  local path="$1"

  [[ -e "${path}" || -L "${path}" ]] || return 1
  if [[ -L "${path}" ]]; then
    return 0
  fi
  if [[ -f "${path}" ]]; then
    [[ -s "${path}" ]]
    return $?
  fi
  if [[ -d "${path}" ]]; then
    [[ -n "$(find "${path}" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]
    return $?
  fi
  return 0
}

# Shared overwrite/keep/quit prompt core for BOTH conflict decisions roborepo asks about: the
# top-level "what's your default policy" prompt (main.sh choose_adopt_conflict_policy) and the
# per-path "this specific file collides" prompt (choose_path_conflict_action below). Same three
# choices, same read-loop; only the header text and I/O redirection differ per caller.
#   header_lines: pre-formatted lines to print above the menu (context-specific — pass "" for none)
#   prompt_out / prompt_in: file descriptors to write/read through (defaults to real stdio)
# Prints the resolved choice ("overwrite"|"keep"|"abort") on stdout; caller captures it via $(...).
prompt_conflict_choice() {
  local header_lines="$1"
  local prompt_out="${2:-/dev/stderr}"
  local prompt_in="${3:-/dev/stdin}"
  local choice

  while true; do
    if [[ -n "${header_lines}" ]]; then
      # header_lines usually arrives via $(...) capture, which trims trailing newlines regardless
      # of how many the caller printf'd — force exactly one blank line before the menu ourselves.
      prompt_write "${prompt_out}" '%s\n\n' "${header_lines}"
    fi
    prompt_write "${prompt_out}" 'Choose:\n'
    prompt_write "${prompt_out}" '  1) overwrite     backup local as *_original_TIMESTAMP; install repo item\n'
    prompt_write "${prompt_out}" '  2) keep originals leave local active; stage repo item as *_update_TIMESTAMP\n'
    prompt_write "${prompt_out}" '  q) quit\n'
    prompt_write "${prompt_out}" 'Selection [1/2/q]: '
    if ! prompt_read "${prompt_in}" choice; then
      echo "abort"
      return 0
    fi

    case "${choice}" in
      1|overwrite) echo "overwrite"; return 0 ;;
      2|keep|original|originals) echo "keep"; return 0 ;;
      q|Q|quit|exit) echo "abort"; return 0 ;;
      *) prompt_write "${prompt_out}" 'Invalid selection.\n' ;;
    esac
  done
}

prompt_write() {
  local prompt_out="$1"
  shift
  if [[ "${prompt_out}" == "/dev/stderr" ]]; then
    printf "$@" >&2
  else
    printf "$@" > "${prompt_out}"
  fi
}

prompt_read() {
  local prompt_in="$1"
  local __var="$2"
  if [[ "${prompt_in}" == "/dev/stdin" ]]; then
    read -r "${__var}"
  else
    read -r "${__var}" < "${prompt_in}"
  fi
}

choose_path_conflict_action() {
  local repo_rel="$1"
  local home_path="$2"
  local src="${repo_root}/${repo_rel}"
  local prompt_in="/dev/stdin"
  local prompt_out="/dev/stderr"

  if [[ -n "${ROBOREPO_ON_CONFLICT:-}" ]]; then
    # Entry points validate their own flag, but ROBOREPO_ON_CONFLICT can also be set directly in the
    # environment. Re-check here because the dispatch below has no catch-all case: an unrecognized
    # value would match nothing and silently skip the collision, leaving the path unconfigured while
    # the install still exits 0.
    case "${ROBOREPO_ON_CONFLICT}" in
      overwrite|keep|abort) ;;
      *)
        echo "error: invalid ROBOREPO_ON_CONFLICT '${ROBOREPO_ON_CONFLICT}' (expected overwrite|keep|abort)" >&2
        return 1
        ;;
    esac
    CONFIG_COLLISION_ACTION="${ROBOREPO_ON_CONFLICT}"
    return 0
  fi

  if [[ "${dry_run}" -eq 1 ]]; then
    echo "collision: ${home_path}"
    echo "dry-run: would ask overwrite or keep originals"
    return 0
  fi

  if ! stdin_is_interactive; then
    if [[ -r /dev/tty && -w /dev/tty ]]; then
      prompt_in="/dev/tty"
      prompt_out="/dev/tty"
    else
      echo "error: ${home_path} exists and stdin is not interactive." >&2
      echo "Run interactively, pass --on-conflict overwrite|keep, or use --dry-run to inspect collisions." >&2
      return 1
    fi
  fi

  local header
  header="$(printf '\nExisting harness target:\n  local:   %s\n  harness: %s\n\n' "${home_path}" "${src}")"
  CONFIG_COLLISION_ACTION="$(prompt_conflict_choice "${header}" "${prompt_out}" "${prompt_in}")"
  [[ "${CONFIG_COLLISION_ACTION}" == "abort" ]] || export ROBOREPO_ON_CONFLICT="${CONFIG_COLLISION_ACTION}"
}

stage_update_item() {
  local repo_rel="$1"
  local home_path="$2"
  local src="${repo_root}/${repo_rel}"
  local update_path
  update_path="$(timestamped_path "${home_path}" update)"

  if [[ "${dry_run}" -eq 0 ]]; then
    copy_tree "${src}" "${update_path}"
  fi
  echo "stage: ${update_path} <- ${src}"
}

# A root_config file is "builtin-authored" once install has written its hooks/markers into it.
# Backing such a file up as a "pre-install" original would poison the backup: a later uninstall would
# restore roborepo hooks into a supposedly-clean file. Detect the install-injected signatures so we
# only ever back up a genuine pre-install file. Conservative: any hit means do-not-back-up.
# Package hook signatures (jcmwatch = jcodemunch, jdm-indexed = jdocmunch) guard against a partial-
# uninstall state where package hooks survive in settings.json without the main roborepo markers.
# Single source of truth: uninstall.sh sources this file rather than keeping its own copy.
is_builtin_authored() {
  local file="$1"
  [[ -f "${file}" ]] || return 1
  grep -Eq "roborepo telemetry capture|write-guard|BEGIN GENERATED AGENT PERMISSIONS|MANAGED_BY_ROBOREPO|# Generated Harness Rules|BEGIN managed:builtin-code-style|BEGIN managed:managed-agents-import|jcmwatch|jdm-indexed" "${file}" 2>/dev/null
}

# Persist the user's genuine pre-install file/dir at ${home_path} to
# ~/.roborepo/backups/pre-install/<harness>/<basename>, exactly once, so uninstall can restore it
# verbatim. Applies to both root_config files and managed link targets (CLAUDE.md, AGENTS.md, hooks,
# rules, …) — anything roborepo replaces. Skips, so the backup can never be poisoned with roborepo
# content: missing harness, a symlink/absent target, an already-captured backup, a file roborepo
# itself authored, or content byte-identical to the repo source (a roborepo copy, not a user
# original). ${src} is the repo source used for the identical-content check.
save_pre_install_backup() {
  local home_path="$1"
  local harness="$2"
  local src="$3"

  [[ -n "${harness}" ]] || return 0
  [[ -e "${home_path}" && ! -L "${home_path}" ]] || return 0

  local pre_install_backup="${HOME}/$(cli_state_dirname)/backups/pre-install/${harness}/$(basename "${home_path}")"
  if [[ -e "${pre_install_backup}" ]]; then
    return 0  # already have the user's original — never overwrite it
  fi
  if is_builtin_authored "${home_path}"; then
    # The live file is already roborepo's (prior install or stray apply). Backing it up would
    # capture roborepo hooks as a fake "original" — skip, so a real original isn't replaced by poison.
    echo "skip pre-install backup: ${home_path} is already builtin-authored"
    return 0
  fi
  if content_matches_repo_source "${src}" "${home_path}"; then
    # The live path is byte-identical to what roborepo installs (a prior adopt-mode copy / legacy
    # materialized link). It is roborepo's, not a user original — skip so we don't capture it as one.
    echo "skip pre-install backup: ${home_path} matches repo source (roborepo copy, not a user original)"
    return 0
  fi
  if [[ "${dry_run}" -eq 0 ]]; then
    mkdir -p "$(dirname "${pre_install_backup}")"
    cp -a "${home_path}" "${pre_install_backup}"
  fi
  say "pre-install backup" "${home_path} -> ${pre_install_backup}"
}

# One-time, durable snapshot of the user's genuine pre-install config: the small set of paths
# roborepo can modify (manifest root_config + link targets for present harnesses, shell profiles, the
# global gitignore). Written ONCE to ~/.cli-backups/pre-install-original.tar.gz and never
# overwritten or deleted by uninstall, so there is always a "this is what my machine looked like
# before roborepo" image to inspect or hand-restore from (`tar xzf <archive> -C ~`). This is an
# escape hatch, NOT the uninstall restore path — uninstall still restores per-file surgically.
# Captures only real, user-authored paths: skips roborepo symlinks, builtin-authored files, and
# content byte-identical to the repo, so the archive can never be poisoned with roborepo's own
# content. Best-effort: silently no-ops without tar. Needs ${repo_root}, ${dry_run}, manifest_rows.
snapshot_pre_install_original() {
  local archive="${HOME}/.cli-backups/pre-install-original.tar.gz"
  [[ -e "${archive}" ]] && return 0           # once only — never overwrite the pristine image
  command -v tar >/dev/null 2>&1 || return 0

  local -a candidates=()
  local _h kind src_rel home_abs _flags src
  while IFS=$'\t' read -r _h kind src_rel home_abs _flags; do
    case "${kind}" in root_config|link|managed_copy|rendered_rules) ;; *) continue ;; esac
    src="${repo_root}/${src_rel}"
    [[ -e "${home_abs}" && ! -L "${home_abs}" ]] || continue   # absent or our symlink — nothing to keep
    is_builtin_authored "${home_abs}" && continue
    content_matches_repo_source "${src}" "${home_abs}" && continue
    candidates+=("${home_abs}")
  done < <(manifest_rows)

  local extra
  for extra in "${HOME}/.zshrc" "${HOME}/.bashrc" "${HOME}/.bash_profile" "${HOME}/.profile" "${HOME}/.gitignore_global"; do
    [[ -f "${extra}" && ! -L "${extra}" ]] && candidates+=("${extra}")
  done

  [[ ${#candidates[@]} -gt 0 ]] || return 0    # pristine machine — nothing pre-existing to capture

  if [[ "${dry_run}" -eq 1 ]]; then
    say "pre-install backup" "would snapshot ${#candidates[@]} original config path(s) -> ${archive}"
    return 0
  fi

  # Store HOME-relative so the archive restores cleanly with `tar xzf <archive> -C ~`.
  local -a rel=()
  local c
  for c in "${candidates[@]}"; do rel+=("${c#"${HOME}/"}"); done
  mkdir -p "$(dirname "${archive}")"
  # tar's stderr is captured rather than discarded. A failure here deletes the archive, and the next
  # install then finds no archive, so the once-only guard above does not fire and a second snapshot
  # is taken — the "written once" property silently stops holding. Discarding the error made that
  # indistinguishable from a machine with nothing to capture. The reason is now reported.
  local tar_err="${archive}.err"
  if tar czf "${archive}" -C "${HOME}" "${rel[@]}" 2>"${tar_err}"; then
    rm -f "${tar_err}"
    say "pre-install backup" "snapshot of ${#candidates[@]} original config path(s) -> ${archive}"
  else
    local reason
    reason="$(head -n 1 "${tar_err}" 2>/dev/null)"
    say "pre-install backup" "snapshot skipped: ${reason:-tar failed with no message}"
    rm -f "${archive}" "${tar_err}"   # never leave a partial/corrupt image behind
  fi
}

install_copy_item() {
  local repo_rel="$1"
  local home_path="$2"
  local harness="${3:-}"
  local src="${repo_root}/${repo_rel}"

  if [[ ! -e "${src}" ]]; then
    echo "missing source: ${src}" >&2
    return 1
  fi

  save_pre_install_backup "${home_path}" "${harness}" "${src}"

  if [[ ! -e "${home_path}" && ! -L "${home_path}" ]]; then
    if [[ "${dry_run}" -eq 0 ]]; then
      copy_tree "${src}" "${home_path}"
    fi
    say copy "${home_path} <- ${src}"
    # home_path now holds a real write — callers that track "did roborepo just write this path"
    # (record_root_config_write) key off this signal, not off CONFIG_COLLISION_ACTION alone, which
    # is otherwise left stale from any prior call when this early-return path is taken.
    CONFIG_COLLISION_ACTION="wrote"
    return 0
  fi

  if paths_equivalent_for_copy "${src}" "${home_path}"; then
    say ok "${home_path}"
    CONFIG_COLLISION_ACTION="wrote"
    return 0
  fi

  CONFIG_COLLISION_ACTION=""
  choose_path_conflict_action "${repo_rel}" "${home_path}"
  if [[ "${dry_run}" -eq 1 && -n "${harness}" ]]; then
    describe_user_config "${harness}" "${home_path}"
  fi
  case "${CONFIG_COLLISION_ACTION}" in
    overwrite)
      local original_path
      original_path="$(timestamped_path "${home_path}" original)"
      if [[ "${dry_run}" -eq 0 ]]; then
        mkdir -p "$(dirname "${original_path}")"
        mv "${home_path}" "${original_path}"
        copy_tree "${src}" "${home_path}"
      fi
      say backup "${home_path} -> ${original_path}"
      say copy "${home_path} <- ${src}"
      print_install_conflict_prompt "${repo_rel}" "${home_path}"
      # overwrite replaced home_path with the repo source — a real write, same as the fresh-copy
      # path above. Re-affirm the signal here since it was cleared to "" above for the prompt.
      CONFIG_COLLISION_ACTION="wrote"
      ;;
    keep)
      stage_update_item "${repo_rel}" "${home_path}"
      print_install_conflict_prompt "${repo_rel}" "${home_path}"
      # "keep" stages the candidate as a sibling and leaves home_path exactly as the user had it —
      # CONFIG_COLLISION_ACTION stays "keep" so callers know home_path was NOT written by roborepo.
      ;;
    abort)
      echo "abort: install canceled by user" >&2
      exit 1
      ;;
  esac
}

install_link_item() {
  local repo_rel="$1"
  local home_path="$2"
  local harness="${3:-}"
  local src="${repo_root}/${repo_rel}"

  if [[ ! -e "${src}" ]]; then
    echo "missing source: ${src}" >&2
    return 1
  fi

  # Persist a genuine pre-install target before we move it aside below, so uninstall can restore it.
  # No-op for symlinks/absent targets and roborepo's own content (see save_pre_install_backup).
  save_pre_install_backup "${home_path}" "${harness}" "${src}"

  if [[ -L "${home_path}" ]]; then
    local current
    current="$(readlink "${home_path}")"
    if [[ "${current}" == "${src}" ]]; then
      say ok "${home_path}"
      return 0
    fi
    case "${current}" in
      "${repo_root}"/*)
        if [[ "${dry_run}" -eq 0 ]]; then
          ln -sfn "${src}" "${home_path}"
        fi
        say relink "${home_path} -> ${src}"
        return 0
        ;;
    esac
  fi

  if [[ ! -e "${home_path}" && ! -L "${home_path}" ]]; then
    if [[ "${dry_run}" -eq 0 ]]; then
      mkdir -p "$(dirname "${home_path}")"
      ln -s "${src}" "${home_path}"
    fi
    say link "${home_path} -> ${src}"
    return 0
  fi

  CONFIG_COLLISION_ACTION=""
  choose_path_conflict_action "${repo_rel}" "${home_path}"
  case "${CONFIG_COLLISION_ACTION}" in
    overwrite)
      local original_path
      original_path="$(timestamped_path "${home_path}" original)"
      if [[ "${dry_run}" -eq 0 ]]; then
        mkdir -p "$(dirname "${original_path}")" "$(dirname "${home_path}")"
        mv "${home_path}" "${original_path}"
        ln -s "${src}" "${home_path}"
      fi
      say backup "${home_path} -> ${original_path}"
      say link "${home_path} -> ${src}"
      print_install_conflict_prompt "${repo_rel}" "${home_path}"
      ;;
    keep)
      stage_update_item "${repo_rel}" "${home_path}"
      print_install_conflict_prompt "${repo_rel}" "${home_path}"
      ;;
    abort)
      echo "abort: install canceled by user" >&2
      exit 1
      ;;
  esac
}

link_item() {
  local repo_rel="$1"
  local home_path="$2"
  local src="${repo_root}/${repo_rel}"

  if [[ ! -e "${src}" ]]; then
    echo "missing source: ${src}" >&2
    return 1
  fi

  if [[ "${dry_run}" -eq 0 ]]; then
    mkdir -p "$(dirname "${home_path}")"
  fi

  if [[ -L "${home_path}" ]]; then
    local current
    current="$(readlink "${home_path}")"
    if [[ "${current}" == "${src}" ]]; then
      say ok "${home_path}"
      return 0
    fi
    case "${current}" in
      "${repo_root}"/*)
        if [[ "${dry_run}" -eq 0 ]]; then
          ln -sfn "${src}" "${home_path}"
        fi
        say relink "${home_path} -> ${src}"
        return 0
        ;;
    esac
  fi

  if [[ -e "${home_path}" || -L "${home_path}" ]]; then
    local backup_path
    backup_path="$(unique_backup_path "${home_path}")"
    if [[ "${dry_run}" -eq 0 ]]; then
      mkdir -p "$(dirname "${backup_path}")"
      mv "${home_path}" "${backup_path}"
    fi
    say backup "${home_path} -> ${backup_path}"
  fi

  if [[ "${dry_run}" -eq 0 ]]; then
    ln -s "${src}" "${home_path}"
  fi
  say link "${home_path} -> ${src}"
}

print_install_conflict_prompt() {
  local repo_rel="$1"
  local home_path="$2"
  local src="${repo_root}/${repo_rel}"

  echo ""
  echo "${RR_YELLOW}${RR_BOLD}================================================================================${RR_RESET}"
  echo "${RR_MAGENTA}${RR_BOLD}MERGE REVIEW REQUIRED: harness install conflict${RR_RESET}"
  echo "${RR_YELLOW}${RR_BOLD}Merge review prompt:${RR_RESET} ${RR_DIM}${home_path}${RR_RESET}"
  echo "${RR_YELLOW}${RR_BOLD}================================================================================${RR_RESET}"
  cat <<EOF
Resolve this harness install conflict.

Repo harness path:
  ${src}

Existing local path:
  ${home_path}

Default stance: preserve the existing local path as source of truth unless you can prove a repo change can be added without breaking local behavior.

Required first step: compute your own complete comparison of both paths. Do not rely on this prompt as an exhaustive conflict summary. For directories, inspect the full recursive file list and content diffs. For structured files, parse the format when possible instead of using only text matching.

Goal: preserve the user's existing local behavior while installing useful harness behavior from the repo.

Merge instructions:
- Keep local-only behavior by default.
- Add repo-only harness behavior only when it does not conflict with local behavior.
- If both sides edit the same setting, hook, rule, command, skill, or MCP/server entry, explain the conflict and stop for user choice.
- Do not delete, replace, or move the local path unless the user explicitly approves that exact action.
- Report the files changed and the conflicts left unresolved.
EOF
  echo "${RR_YELLOW}${RR_BOLD}================================================================================${RR_RESET}"
  echo ""
}

link_item_clean() {
  local repo_rel="$1"
  local home_path="$2"
  local src="${repo_root}/${repo_rel}"

  if [[ ! -e "${src}" ]]; then
    echo "missing source: ${src}" >&2
    return 1
  fi

  if [[ "${dry_run}" -eq 0 ]]; then
    mkdir -p "$(dirname "${home_path}")"
  fi

  if [[ -L "${home_path}" ]]; then
    local current
    current="$(readlink "${home_path}")"
    if [[ "${current}" == "${src}" ]]; then
      say ok "${home_path}"
      return 0
    fi
    case "${current}" in
      "${repo_root}"/*)
        if [[ "${dry_run}" -eq 0 ]]; then
          ln -sfn "${src}" "${home_path}"
        fi
        say relink "${home_path} -> ${src}"
        return 0
        ;;
    esac
  fi

  if [[ -e "${home_path}" || -L "${home_path}" ]]; then
    echo "conflict: ${home_path} already exists; not replacing it"
    print_install_conflict_prompt "${repo_rel}" "${home_path}"
    return 1
  fi

  if [[ "${dry_run}" -eq 0 ]]; then
    ln -s "${src}" "${home_path}"
  fi
  say link "${home_path} -> ${src}"
}

# Record the content hash of a root_config file roborepo just wrote, so a later install/update can
# tell "roborepo's own baseline changed" apart from "something else touched this file since."
# Best-effort: node is already required elsewhere in
# these scripts, but never let hash bookkeeping block an install.
record_root_config_write() {
  local harness="$1"
  local home_path="$2"
  if [[ "${dry_run}" -eq 1 ]]; then return 0; fi
  command -v node >/dev/null 2>&1 || return 0
  node "${repo_root}/scripts/cli/root-config-state.mjs" record "${harness}" "${home_path}" 2>/dev/null || true
}

root_config_drift_status() {
  local harness="$1"
  local home_path="$2"
  command -v node >/dev/null 2>&1 || { echo "unwritten"; return 0; }
  node "${repo_root}/scripts/cli/root-config-state.mjs" check "${harness}" "${home_path}" 2>/dev/null || echo "unwritten"
}

cleanup_original_backup_if_redundant() {
  local home_path="$1"
  local original_path
  original_path="$(timestamped_path "${home_path}" original)"

  [[ -f "${original_path}" ]] || return 0
  [[ -f "${home_path}" ]] || return 0
  if cmp -s "${home_path}" "${original_path}"; then
    rm -f "${original_path}"
    say cleanup "${original_path}"
  fi
}

export_user_config() {
  local harness="$1"
  local repo_rel="$2"
  local home_path="$3"
  local src="${repo_root}/${repo_rel}"
  local merge_helper="${repo_root}/scripts/cli/root-config-merge.mjs"
  local converted_from_symlink=0
  local merge_tmp=""

  if [[ "${dry_run}" -eq 1 ]]; then
    # A real pre-existing local file is a collision the preview must name — and, for Claude,
    # surface whether it even parses (a malformed settings.json can't be safely merged). Root
    # configs route through this function rather than install_copy_item, so the JSON/collision
    # diagnostics that path prints have to be emitted here too or dry-run goes silent on them.
    if [[ -e "${home_path}" && ! -L "${home_path}" ]]; then
      echo "collision: ${home_path}"
      describe_user_config "${harness}" "${home_path}"
    fi
    say merge "${home_path} <- ${src}"
    return 0
  fi

  if [[ ! -e "${merge_helper}" ]]; then
    echo "missing merge helper: ${merge_helper}" >&2
    return 1
  fi

  # Honor --on-conflict abort for root configs too. A genuine collision is a real local file the
  # user already had or edited (drift status "unwritten" or "drifted") that the merge would change.
  # A clean file is only receiving a baseline update, which is not a conflict. The documented abort
  # contract is "stop before writing anything",
  # so we bail before mutating instead of silently merging. Matches abortOnConflict in presets.mjs.
  if [[ "${ROBOREPO_ON_CONFLICT:-}" == "abort" && -f "${home_path}" && ! -L "${home_path}" ]]; then
    local abort_status abort_tmp
    abort_status="$(root_config_drift_status "${harness}" "${home_path}")"
    if [[ "${abort_status}" == "drifted" || "${abort_status}" == "unwritten" ]]; then
      abort_tmp="$(mktemp "${home_path}.abortcheck.XXXXXX")"
      if ! node "${merge_helper}" "${harness}" "${src}" "${home_path}" "${abort_tmp}" || ! cmp -s "${abort_tmp}" "${home_path}"; then
        rm -f "${abort_tmp}"
        echo "abort: install canceled by user (${home_path} conflicts with the repo version; this file was not changed)" >&2
        exit 1
      fi
      rm -f "${abort_tmp}"
    fi
  fi

  # Drift-aware collision routing: a *drifted* root config is one the user hand-edited after
  # roborepo's last write (sidecar hash mismatch). For a fresh adopt ("unwritten") or a
  # builtin-clean file, the non-destructive merge below is correct and policy-agnostic. But once a
  # file has genuinely drifted, the merge must NOT silently fold the baseline into the user's edits
  # and — critically — must not record a fresh "clean" write that hides the drift on the next run.
  #   keep      -> leave home_path exactly as the user has it; stage the repo candidate as a
  #                *_update_TIMESTAMP sibling; do not merge, do not record a write (drift stays visible).
  #   overwrite -> back the drifted file up to *_original_TIMESTAMP, then merge/write the baseline
  #                (user allow/deny/profiles are still preserved by the merge; the backup is the
  #                honest record of what was replaced). Falls through to the merge below.
  local backup_drifted=0
  if [[ -f "${home_path}" && ! -L "${home_path}" ]]; then
    local drift_status
    drift_status="$(root_config_drift_status "${harness}" "${home_path}")"
    if [[ "${drift_status}" == "drifted" ]]; then
      case "${ROBOREPO_ON_CONFLICT:-}" in
        keep)
          # The JS bundle apply may already have staged this exact candidate earlier in the same
          # install; don't pile up a duplicate per run.
          local staged
          staged="$(latest_timestamped_sibling "${home_path}" update)"
          if [[ -n "${staged}" ]] && cmp -s "${staged}" "${src}"; then
            say ok "${home_path} ${RR_DIM}(drifted local root config kept; candidate already staged as $(basename "${staged}"))${RR_RESET}"
            return 0
          fi
          stage_update_item "${repo_rel}" "${home_path}"
          say ok "${home_path} ${RR_DIM}(drifted local root config kept; candidate staged as *_update_*)${RR_RESET}"
          return 0
          ;;
        overwrite)
          backup_drifted=1
          ;;
      esac
    fi
  fi

  if [[ "${backup_drifted}" -eq 1 ]]; then
    local original_path
    original_path="$(timestamped_path "${home_path}" original)"
    mkdir -p "$(dirname "${original_path}")"
    cp "${home_path}" "${original_path}"
    say backup "${home_path} -> ${original_path}"
  fi

  if [[ -L "${home_path}" ]]; then
    converted_from_symlink=1
    rm "${home_path}"
  fi

  mkdir -p "$(dirname "${home_path}")"
  merge_tmp="$(mktemp "${home_path}.merge.XXXXXX")"
  if ! node "${merge_helper}" "${harness}" "${src}" "${home_path}" "${merge_tmp}"; then
    rm -f "${merge_tmp}"
    return 1
  fi
  if [[ -f "${home_path}" ]] && cmp -s "${merge_tmp}" "${home_path}"; then
    rm -f "${merge_tmp}"
    say ok "${home_path} ${RR_DIM}(local root config already current)${RR_RESET}"
    record_root_config_write "${harness}" "${home_path}"
    cleanup_original_backup_if_redundant "${home_path}"
    return 0
  fi
  mv "${merge_tmp}" "${home_path}"
  if [[ "${converted_from_symlink}" -eq 1 ]]; then
    say merge "${home_path} <- ${src} ${RR_DIM}(converted from repo symlink, local root config preserved)${RR_RESET}"
  else
    say merge "${home_path} <- ${src} ${RR_DIM}(local root config preserved)${RR_RESET}"
  fi
  record_root_config_write "${harness}" "${home_path}"
  cleanup_original_backup_if_redundant "${home_path}"
}

preflight_clean_item() {
  local repo_rel="$1"
  local home_path="$2"
  local src="${repo_root}/${repo_rel}"

  if [[ ! -e "${home_path}" && ! -L "${home_path}" ]]; then
    return 0
  fi

  if [[ -L "${home_path}" ]]; then
    case "$(readlink "${home_path}")" in
      "${src}"|"${repo_root}"/*) return 0 ;;
    esac
  fi

  echo "conflict: ${home_path} already exists; not replacing it" >&2
  print_install_conflict_prompt "${repo_rel}" "${home_path}" >&2
  return 1
}

remove_repo_link() {
  local home_path="$1"

  if [[ ! -L "${home_path}" ]]; then
    return 0
  fi

  local current
  current="$(readlink "${home_path}")"
  case "${current}" in
    "${repo_root}"/*)
      local backup_path
      backup_path="$(unique_backup_path "${home_path}")"
      if [[ "${dry_run}" -eq 0 ]]; then
        mkdir -p "$(dirname "${backup_path}")"
        mv "${home_path}" "${backup_path}"
      fi
      echo "cleanup: ${home_path} -> ${backup_path}"
      ;;
  esac
}

# Copy a shared skill into the machine-local cache at ~/.roborepo/skills/<name>.
# The cache is the derived machine state; harness skill dirs symlink to it.
link_skill_item() {
  local repo_rel="$1"
  local cache_path="$2"
  local src="${repo_root}/${repo_rel}"
  local marker="${cache_path}/.builtin-managed"

  if [[ ! -e "${src}" ]]; then
    echo "missing source: ${src}" >&2
    return 1
  fi

  if [[ -L "${cache_path}" ]]; then
    local current
    current="$(readlink "${cache_path}")"
    case "${current}" in
      "${repo_root}"/*|${HOME}/$(cli_state_dirname)/skills/*)
        if [[ "${dry_run}" -eq 0 ]]; then
          rm -f "${cache_path}"
          copy_tree "${src}" "${cache_path}"
          : > "${marker}"
        fi
        say copy "${cache_path} <- ${src}"
        return 0
        ;;
      *)
        echo "skip (unmanaged symlink): ${cache_path}"
        return 0
        ;;
    esac
  fi

  if [[ -e "${cache_path}" && ! -e "${marker}" ]]; then
    if [[ "${dry_run}" -eq 0 ]]; then
      rm -rf "${cache_path}"
      copy_tree "${src}" "${cache_path}"
      : > "${marker}"
    fi
    say copy "${cache_path} <- ${src}"
    return 0
  fi

  if [[ -e "${marker}" ]]; then
    if diff -rq -x '.builtin-managed' "${src}" "${cache_path}" >/dev/null 2>&1; then
      say ok "${cache_path}"
      return 0
    fi
    if [[ "${dry_run}" -eq 0 ]]; then
      rm -rf "${cache_path}"
      copy_tree "${src}" "${cache_path}"
      : > "${marker}"
    fi
    say copy "${cache_path} <- ${src}"
    return 0
  fi

  if [[ "${dry_run}" -eq 0 ]]; then
    mkdir -p "$(dirname "${cache_path}")"
    copy_tree "${src}" "${cache_path}"
    : > "${marker}"
  fi
  say copy "${cache_path} <- ${src}"
}

link_skill_view() {
  local cache_path="$1"
  local home_path="$2"

  if [[ -L "${home_path}" ]]; then
    local current
    current="$(readlink "${home_path}")"
    case "${current}" in
      "${cache_path}")
        say ok "${home_path}"
        return 0
        ;;
      "${HOME}/$(cli_state_dirname)/skills"/*|"${repo_root}"/*)
        if [[ "${dry_run}" -eq 0 ]]; then
          rm -f "${home_path}"
          ln -s "${cache_path}" "${home_path}"
        fi
        say relink "${home_path} -> ${cache_path}"
        return 0
        ;;
      *)
        echo "skip (unmanaged symlink): ${home_path}"
        return 0
        ;;
    esac
  fi

  if [[ -e "${home_path}" || -L "${home_path}" ]]; then
    if [[ -e "${home_path}/.builtin-managed" ]]; then
      if [[ "${dry_run}" -eq 0 ]]; then
        rm -rf "${home_path}"
        ln -s "${cache_path}" "${home_path}"
      fi
      say relink "${home_path} -> ${cache_path}"
      return 0
    fi
    echo "skip (native skill): ${home_path}"
    return 0
  fi

  if [[ "${dry_run}" -eq 0 ]]; then
    mkdir -p "$(dirname "${home_path}")"
    ln -s "${cache_path}" "${home_path}"
  fi
  say link "${home_path} -> ${cache_path}"
}

# One-shot migration: tear down the legacy ~/.agents/skills runtime tree.
# Pre-native-alignment, roborepo fanned skills into ~/.agents/skills via a single dir-level managed
# symlink (agents link globals/agents/skills -> ~/.agents/skills), and Codex also scans ~/.agents.
# Now that skills are linked per-skill into each harness's native dir, a leftover ~/.agents/skills
# link makes Codex discover the same skills twice. Reclaim it only when it is a builtin-managed
# symlink into the repo (back up first, mirroring remove_repo_link); never touch a user's real
# ~/.agents content (a real dir/file is left alone). Idempotent: a no-op once removed.
# Self-contained (provides defaults for backup_root/dry_run) so it is safe from every call site.
remove_legacy_agents_skills() {
  local legacy="${HOME}/.agents/skills"

  [[ -L "${legacy}" ]] || return 0
  local current
  current="$(readlink "${legacy}")"
  case "${current}" in
    "${repo_root}"/*) ;;
    *) return 0 ;;
  esac

  local backup_root="${backup_root:-${HOME}/.cli-backups/$(date +%Y%m%d-%H%M%S)}"
  local dry_run="${dry_run:-0}"
  local backup_path
  backup_path="$(unique_backup_path "${legacy}")"
  if [[ "${dry_run}" -eq 0 ]]; then
    mkdir -p "$(dirname "${backup_path}")"
    mv "${legacy}" "${backup_path}"
    rmdir "${HOME}/.agents" 2>/dev/null || true  # remove ~/.agents only if now empty
  fi
  echo "cleanup (legacy ~/.agents/skills): ${legacy} -> ${backup_path}"
}

# Enumerate package-owned skills plus system support skills, materialize each into ~/.roborepo/skills/<name>,
# then symlink each present harness skill dir entry to the cache copy.
# Also prunes stale managed cache entries and stale harness symlinks.
# Requires: ${repo_root}, ${dry_run}, list_source_skills (from skill-lib.sh).
link_global_skills() {
  local home_dir="$1"
  shift || true
  local preserve_existing=0
  if [[ "${1:-}" == "--preserve-existing" ]]; then
    preserve_existing=1
    shift || true
  fi
  local skills_home="${home_dir}/skills"
  local cache_home="${HOME}/$(cli_state_dirname)/skills"
  local allowed_names=("$@")

  # Migrate off the legacy ~/.agents/skills location before linking. Idempotent and global, so the
  # redundant second call (this runs once per harness) is a cheap no-op.
  remove_legacy_agents_skills

  local name repo_rel cache_path
  while IFS=$'\t' read -r name repo_rel; do
    [[ -n "${name}" ]] || continue
    if [[ "${#allowed_names[@]}" -gt 0 ]]; then
      local wanted=0 allowed
      for allowed in "${allowed_names[@]}"; do
        [[ "${name}" == "${allowed}" ]] && wanted=1 && break
      done
      [[ "${wanted}" -eq 1 ]] || continue
    fi
    cache_path="${cache_home}/${name}"
    link_skill_item "${repo_rel}" "${cache_path}"
    link_skill_view "${cache_path}" "${skills_home}/${name}"
  done < <(list_global_skill_sources)

  [[ "${preserve_existing}" -eq 1 ]] && return 0

  # Prune cache entries and harness symlinks whose source has been removed or is not allowed.
  [[ -d "${cache_home}" ]] || return 0
  local entry skill_name
  for entry in "${cache_home}"/*; do
    [[ -d "${entry}" && -e "${entry}/.builtin-managed" ]] || continue
    skill_name="$(basename "${entry}")"
    if [[ "${#allowed_names[@]}" -gt 0 ]]; then
      local still_allowed=0 allowed
      for allowed in "${allowed_names[@]}"; do
        [[ "${skill_name}" == "${allowed}" ]] && still_allowed=1 && break
      done
      if [[ "${still_allowed}" -ne 1 ]]; then
        if [[ "${dry_run}" -eq 0 ]]; then
          rm -rf "${entry}"
        fi
        echo "prune: ${entry} (not in base skill set)"
        [[ -d "${skills_home}" ]] || continue
        [[ -L "${skills_home}/${skill_name}" ]] && [[ "$(readlink "${skills_home}/${skill_name}")" == "${entry}" ]] \
          && { [[ "${dry_run}" -eq 0 ]] && rm -f "${skills_home}/${skill_name}"; echo "prune: ${skills_home}/${skill_name} (not in base skill set)"; }
        continue
      fi
    fi
    global_skill_source_exists "${skill_name}" || {
      if [[ "${dry_run}" -eq 0 ]]; then
        rm -rf "${entry}"
      fi
      echo "prune: ${entry} (source removed)"
      [[ -d "${skills_home}" ]] || continue
      [[ -L "${skills_home}/${skill_name}" ]] && [[ "$(readlink "${skills_home}/${skill_name}")" == "${entry}" ]] \
        && { [[ "${dry_run}" -eq 0 ]] && rm -f "${skills_home}/${skill_name}"; echo "prune: ${skills_home}/${skill_name} (source removed)"; }
      continue
    }
    [[ -d "${skills_home}" ]] || continue
    [[ -L "${skills_home}/${skill_name}" ]] || continue
    [[ "$(readlink "${skills_home}/${skill_name}")" == "${entry}" ]] || continue
    say ok "${skills_home}/${skill_name}"
  done
}

list_global_skill_sources() {
  local skill_dir name rel
  if [[ -f "${repo_root}/globals/system/skills/builtin-support/SKILL.md" ]]; then
    printf 'builtin-support\tglobals/system/skills/builtin-support\n'
  fi
  for skill_dir in "${repo_root}"/globals/packages/*/skills/*; do
    [[ -d "${skill_dir}" && -f "${skill_dir}/SKILL.md" ]] || continue
    name="$(basename "${skill_dir}")"
    rel="${skill_dir#${repo_root}/}"
    printf '%s\t%s\n' "${name}" "${rel}"
  done | sort
}

global_skill_source_exists() {
  local name="$1" found source_name _rel
  while IFS=$'\t' read -r source_name _rel; do
    [[ "${source_name}" == "${name}" ]] && found=1 && break
  done < <(list_global_skill_sources)
  [[ "${found:-0}" -eq 1 ]]
}

describe_user_config() {
  local harness="$1"
  local home_path="$2"

  if [[ "${harness}" == "claude" ]]; then
    if command -v node >/dev/null 2>&1; then
      if node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "${home_path}" >/dev/null 2>&1; then
        echo "  parse: valid JSON"
      else
        echo "  parse: invalid JSON or non-JSON content"
      fi
    fi
    grep -E '"(permissions|hooks|mcpServers|enabledPlugins|extraKnownMarketplaces|model|statusLine)"[[:space:]]*:' "${home_path}" 2>/dev/null \
      | sed 's/^/  has: /' \
      | head -n 12 || true
    return 0
  fi

  echo "  parse: TOML not fully parsed by installer"
  grep -E '^[[:space:]]*(model|model_provider|approval_policy|sandbox_mode)[[:space:]]*=|^[[:space:]]*\[(mcp_servers|model_providers|profiles|features|hooks|projects|plugins)(\.|\])' "${home_path}" 2>/dev/null \
    | sed 's/^/  has: /' \
    | head -n 20 || true
}

choose_profile() {
  if [[ -n "${ROBOREPO_SHELL_PROFILE:-}" ]]; then
    echo "${ROBOREPO_SHELL_PROFILE}"
    return 0
  fi

  case "${SHELL:-}" in
    */zsh)
      echo "${HOME}/.zshrc"
      ;;
    */bash)
      if [[ -f "${HOME}/.bashrc" ]]; then
        echo "${HOME}/.bashrc"
      elif [[ -f "${HOME}/.bash_profile" ]]; then
        echo "${HOME}/.bash_profile"
      else
        echo "${HOME}/.bashrc"
      fi
      ;;
    *)
      if [[ -f "${HOME}/.profile" ]]; then
        echo "${HOME}/.profile"
      else
        echo "${HOME}/.zshrc"
      fi
      ;;
  esac
}
