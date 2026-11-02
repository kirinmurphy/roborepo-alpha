#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/install/install-lib.sh
source "${repo_root}/scripts/install/install-lib.sh"  # RR_* colors + say()
zshrc="${HOME}/.zshrc"
backup_root="${ROBOREPO_BACKUP_ROOT:-${HOME}/.cli-backups/$(date +%Y%m%d-%H%M%S)}"
dry_run=0

case "${1:-}" in
  --dry-run) dry_run=1 ;;
  "") ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

# shellcheck source=scripts/lib/manifests-data.sh
source "${repo_root}/scripts/lib/manifests-data.sh"

source_snippets=()
stale_snippet_globs=()
while IFS=$'\t' read -r kind snippet_path; do
  case "${kind}" in
    active) source_snippets+=("${snippet_path}") ;;
    stale)  stale_snippet_globs+=("${snippet_path}") ;;
  esac
done < <(shell_snippet_rows)

# Only create ~/.zshrc if we actually have something to write into it. With no snippets wired
# and no existing profile, do nothing — don't leave behind an empty ~/.zshrc the user never had.
if [[ ${#source_snippets[@]} -gt 0 ]]; then
  if [[ "${dry_run}" -eq 1 ]]; then
    [[ -e "${zshrc}" ]] || say "would touch" "${zshrc}"
  else
    touch "${zshrc}"
  fi
fi

needs_backup=true

for snippet in "${source_snippets[@]+"${source_snippets[@]}"}"; do
  source_line="source \"${repo_root}/${snippet}\""
  if [[ -e "${zshrc}" ]] && grep -Fqx "${source_line}" "${zshrc}"; then
    say ok "${zshrc} already sources ${snippet}"
  else
    if [[ "${dry_run}" -eq 1 ]]; then
      say source "${source_line}"
      continue
    fi
    if [[ "${needs_backup}" == "true" ]]; then
      mkdir -p "${backup_root}${HOME}"
      cp -p "${zshrc}" "${backup_root}${zshrc}"
      say backup "${zshrc} -> ${backup_root}${zshrc}"
      needs_backup=false
    fi
    printf '\n# Harness config shell helpers\n%s\n' "${source_line}" >> "${zshrc}"
    say source "${source_line}"
  fi
done

# Prune stale snippet `source` lines: any `source ".../shell/*.zsh"` line from this checkout that is
# no longer in source_snippets is removed.
# Also drops the "# Harness config shell helpers" marker comment that preceded each.
prune_stale_snippets() {
  [[ -e "${zshrc}" ]] || return 0

  local wanted=()
  local s stale_regex
  for s in "${source_snippets[@]+"${source_snippets[@]}"}"; do
    wanted+=("source \"${repo_root}/${s}\"")
  done

  stale_regex="^source \"${repo_root}/("
  local sep=""
  for s in "${stale_snippet_globs[@]+"${stale_snippet_globs[@]}"}"; do
    s="${s//./\\.}"
    s="${s//\*/.*}"
    stale_regex+="${sep}${s}"
    sep="|"
  done
  stale_regex+=")\"$"
  [[ ${#stale_snippet_globs[@]} -eq 0 ]] && return 0

  # Find managed snippet source lines currently present but not wanted.
  local stale_found=0 line
  while IFS= read -r line; do
    [[ "${line}" =~ ${stale_regex} ]] || continue
    local keep=0 w
    for w in "${wanted[@]+"${wanted[@]}"}"; do
      [[ "${line}" == "${w}" ]] && keep=1 && break
    done
    [[ "${keep}" -eq 0 ]] && stale_found=1
  done < "${zshrc}"

  [[ "${stale_found}" -eq 0 ]] && return 0

  if [[ "${dry_run}" -eq 1 ]]; then
    say prune "would remove stale shell snippet source line(s) from ${zshrc}"
    return 0
  fi

  if [[ "${needs_backup}" == "true" ]]; then
    mkdir -p "${backup_root}${HOME}"
    cp -p "${zshrc}" "${backup_root}${zshrc}"
    say backup "${zshrc} -> ${backup_root}${zshrc}"
    needs_backup=false
  fi

  # Rewrite without the stale source lines and their immediately-preceding marker comment.
  local tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/zshrc.XXXXXX")"
  awk -v stale_regex="${stale_regex}" '
    {
      line = $0
      is_stale = (line ~ stale_regex)
      if (is_stale) {
        # Drop a buffered "# Harness config shell helpers" marker that preceded this line.
        if (held != "") { held = "" }
        next
      }
      if (held != "") { print held; held = "" }
      if (line == "# Harness config shell helpers") { held = line; next }
      print line
    }
    END { if (held != "") print held }
  ' "${zshrc}" > "${tmp}"
  mv "${tmp}" "${zshrc}"
  say prune "removed stale shell snippet source line(s) from ${zshrc}"
}
prune_stale_snippets
