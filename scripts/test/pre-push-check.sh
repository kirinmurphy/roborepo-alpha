#!/usr/bin/env bash
set -euo pipefail

# The fast check run before every push (scripts/git-hooks/pre-push). It runs the few checks that
# take seconds and catch the mistakes that turn main red; CI runs the full gate (scripts/test/ci.sh)
# after the push. Reads git's pre-push lines on stdin: <local ref> <local sha> <remote ref> <remote sha>.
#
# Usage: scripts/test/pre-push-check.sh <remote> < refs

remote="${1:-origin}"
url="${2:-${remote}}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${repo_root}"

# doctor's Node release check reads nodejs.org; keep the push off the network, as ci.sh does.
export ROBOREPO_SKIP_NODE_RELEASE_CHECK=1

failed=()

is_zero() {
  [[ "$1" =~ ^0+$ ]]
}

# The remote's default branch as a remote-tracking ref: the recorded refs/remotes/<remote>/HEAD, or
# else the branch the remote itself advertises as HEAD, as the agent pre-push hook resolves it.
remote_default_ref() {
  local branch
  if git symbolic-ref --quiet "refs/remotes/${remote}/HEAD" 2>/dev/null; then
    return 0
  fi
  branch="$(git ls-remote --symref -- "${url}" HEAD 2>/dev/null \
    | awk '$1 == "ref:" && $3 == "HEAD" { sub("^refs/heads/", "", $2); print $2; exit }')"
  [[ -n "${branch}" ]] || return 1
  echo "refs/remotes/${remote}/${branch}"
}

# The commit a branch is diffed from when the remote has no tip this checkout knows: its merge base
# with the remote's default branch.
new_branch_base() {
  local local_sha="$1" default
  default="$(remote_default_ref)" || return 1
  git rev-parse --verify --quiet "${default}^{commit}" >/dev/null || return 1
  git merge-base "${default}" "${local_sha}"
}

# Whitespace errors and leftover conflict markers in the commits being pushed, per ref. A deletion
# pushes no commits; a new branch, or one whose remote tip this checkout lacks, is checked from where
# it left the default branch.
while read -r local_ref local_sha remote_ref remote_sha; do
  [[ -n "${remote_ref:-}" ]] || continue
  is_zero "${local_sha}" && continue
  if ! is_zero "${remote_sha}" && git cat-file -e "${remote_sha}^{commit}" 2>/dev/null; then
    base="${remote_sha}"
  elif ! base="$(new_branch_base "${local_sha}")"; then
    echo "pre-push: skipped git diff --check for ${remote_ref}: cannot find ${remote}'s default branch in this checkout to diff from" >&2
    continue
  fi
  # --no-pager: stderr is the terminal, so git would page, and a LESS without -F holds the push
  # at an empty pager until the user presses q.
  if ! git --no-pager diff --check "${base}" "${local_sha}" >&2; then
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
