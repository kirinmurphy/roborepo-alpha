#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
failed=0
quiet=0
passed=0

# --quiet|-q : suppress per-check "ok:" lines; still print every failure + a summary.
for arg in "$@"; do
  case "${arg}" in
    --quiet|-q) quiet=1 ;;
    *) echo "usage: $0 [--quiet|-q]" >&2; exit 2 ;;
  esac
done

# shellcheck source=scripts/build/skill-lib.sh
source "${repo_root}/scripts/build/skill-lib.sh"
# shellcheck source=scripts/lib/manifests-data.sh
source "${repo_root}/scripts/lib/manifests-data.sh"

# Record a passing check. Honors --quiet (count always, print only when verbose).
pass_msg() {
  passed=$((passed + 1))
  [[ "${quiet}" -eq 1 ]] && return 0
  echo "ok: $*"
}

check_file_contains() {
  local path="$1"
  local pattern="$2"
  local label="$3"

  if grep -Eq "${pattern}" "${path}"; then
    pass_msg "${label}"
    return 0
  fi

  echo "fail: ${label}"
  failed=1
}

check_link() {
  local repo_rel="$1"
  local home_path="$2"
  local expected="${repo_root}/${repo_rel}"

  if [[ ! -L "${home_path}" ]]; then
    echo "fail: ${home_path} is not a symlink"
    failed=1
    return 0
  fi

  local actual
  actual="$(python3 - <<'PY' "${home_path}"
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
)"
  if [[ "${actual}" != "${expected}" ]]; then
    echo "fail: ${home_path} -> ${actual}; expected ${expected}"
    failed=1
    return 0
  fi

  if [[ -f "${expected}" ]] && ! cmp -s "${home_path}" "${expected}"; then
    echo "fail: ${home_path} content differs from ${expected}"
    failed=1
    return 0
  fi

  pass_msg "${home_path} -> ${expected}"
}

check_active_file() {
  local home_path="$1"
  if [[ -f "${home_path}" && ! -L "${home_path}" ]]; then
    pass_msg "${home_path} is active local file"
  else
    echo "fail: ${home_path} is not an active local file"
    failed=1
  fi
}

check_local_config_repair_candidates() {
  if ! command -v node >/dev/null 2>&1; then
    pass_msg "node unavailable; skipped local config repair check"
    return 0
  fi
  local output
  if output="$(node "${repo_root}/scripts/cli/local-config-repair.mjs" --check 2>&1)"; then
    pass_msg "local config repair not needed"
  else
    failed=1
    while IFS= read -r line; do
      [[ -n "${line}" ]] && echo "${line}" >&2
    done <<< "${output}"
  fi
}

check_link "bin/roborepo" "${HOME}/.local/bin/roborepo"

node "${repo_root}/scripts/cli/main.mjs" bundle check || failed=1

doctor_args=(--installed)
[[ "${quiet}" -eq 1 ]] && doctor_args+=(--quiet)
"${repo_root}/scripts/doctor.sh" "${doctor_args[@]}"
check_local_config_repair_candidates


if [[ "${failed}" -ne 0 ]]; then
  echo "verify failed (${passed} checks passed, see fail: lines above)" >&2
  exit 1
fi

echo "verify passed (${passed} checks)"
