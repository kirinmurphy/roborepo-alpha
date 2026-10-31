#!/usr/bin/env bash
set -euo pipefail

# The fast check run before every push (scripts/git-hooks/pre-push). It runs the few checks that
# take seconds and catch the mistakes that turn main red; CI runs the full gate (scripts/test/ci.sh)
# after the push. Reads git's pre-push lines on stdin: <local ref> <local sha> <remote ref> <remote sha>.
#
# Usage: scripts/test/pre-push-check.sh <remote> < refs

remote="${1:-origin}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${repo_root}"

# doctor's Node release check reads nodejs.org; keep the push off the network, as ci.sh does.
export ROBOREPO_SKIP_NODE_RELEASE_CHECK=1

failed=()

is_zero() {
  [[ "$1" =~ ^0+$ ]]
}

# The commit a new branch is diffed from: its merge base with the remote's default branch.
new_branch_base() {
  local local_sha="$1" default
  default="$(git symbolic-ref --quiet "refs/remotes/${remote}/HEAD" 2>/dev/null)" \
    || default="refs/remotes/${remote}/main"
  git rev-parse --verify --quiet "${default}^{commit}" >/dev/null || return 1
  git merge-base "${default}" "${local_sha}"
}

# Whitespace errors and leftover conflict markers in the commits being pushed, per ref. A deletion
# pushes no commits; a new branch is checked from where it left the default branch.
while read -r local_ref local_sha remote_ref remote_sha; do
  [[ -n "${remote_ref:-}" ]] || continue
  is_zero "${local_sha}" && continue
  if is_zero "${remote_sha}"; then
    if ! base="$(new_branch_base "${local_sha}")"; then
      echo "pre-push: skipped git diff --check for new ${remote_ref}: no ${remote}/HEAD or ${remote}/main to diff from" >&2
      continue
    fi
  elif git cat-file -e "${remote_sha}^{commit}" 2>/dev/null; then
    base="${remote_sha}"
  else
    echo "pre-push: skipped git diff --check for ${remote_ref}: ${remote} has commits this checkout does not" >&2
    continue
  fi
  if ! git diff --check "${base}" "${local_sha}" >&2; then
    failed+=("git diff --check ${base:0:12}..${local_sha:0:12} (${remote_ref})")
  fi
done

# These read the working tree, not the pushed commits, so they run once per push.
check() {
  if ! "$@" >&2; then
    failed+=("$*")
  fi
}
check bash scripts/doctor.sh --quiet
check node scripts/test/docs-reference-check.mjs

if (( ${#failed[@]} > 0 )); then
  echo "" >&2
  echo "pre-push: push refused. Failed:" >&2
  printf '  %s\n' "${failed[@]}" >&2
  echo "Fix them and push again. CI runs the full gate after the push." >&2
  exit 1
fi
