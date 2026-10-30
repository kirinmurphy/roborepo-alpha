# Sourced by every hook in this directory. Agent shells point core.hooksPath here (through
# GIT_CONFIG_* environment variables set in the harness config), which would otherwise hide the
# repo's own hooks. roborepo_chain_hook runs the hook git would have run without that override.

roborepo_repo_hooks_dir() {
  # Last value wins, as in git; the "command" scope is our own override, so it is skipped.
  dir=$(git config --show-scope --type=path --get-all core.hooksPath 2>/dev/null \
    | awk -F '\t' '$1 != "command" { value = $2 } END { print value }')
  if [ -z "$dir" ]; then
    common=$(git rev-parse --git-common-dir 2>/dev/null) || return 1
    dir="$common/hooks"
  fi
  printf '%s\n' "$dir"
}

roborepo_chain_hook() {
  name=$1
  shift
  dir=$(roborepo_repo_hooks_dir) || return 0
  # CDPATH is cleared so cd resolves only the given path and prints nothing into the result.
  here=$(CDPATH= cd -- "$(dirname "$0")" && pwd -P)
  there=$(CDPATH= cd -- "$dir" 2>/dev/null && pwd -P) || return 0
  [ "$here" = "$there" ] && return 0
  [ -x "$there/$name" ] || return 0
  exec "$there/$name" "$@"
}
