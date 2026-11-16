# Sourced by pre-merge-commit, pre-commit, and pre-rebase. Agents never merge into a protected
# branch: main, master, each remote's recorded default branch, and ROBOREPO_PROTECTED_BRANCHES
# (comma-separated).
# The protected-branch shell hook denies the commands first; this catches what reaches git another
# way (an alias, a script). A fast-forward makes no merge commit, so it never gets here.
roborepo_protected_branch() {
  name=$1
  [ -n "$name" ] || return 1
  protected="main master $(printf '%s' "${ROBOREPO_PROTECTED_BRANCHES:-}" | tr ',' ' ')"
  for remote in $(git remote 2>/dev/null); do
    head=$(git symbolic-ref --quiet --short "refs/remotes/$remote/HEAD" 2>/dev/null) && protected="$protected ${head#"$remote"/}"
  done
  for candidate in $protected; do
    [ "$candidate" = "$name" ] && return 0
  done
  return 1
}

# $1: what is being refused; $2: the branch it changes (default: the checked-out branch).
roborepo_refuse_protected_merge() {
  branch=${2:-$(git symbolic-ref --quiet --short HEAD 2>/dev/null)}
  roborepo_protected_branch "$branch" || return 0
  echo "roborepo: $1 into protected branch \"$branch\" is blocked for agents. Merge $branch into a feature branch instead ('roborepo plans sync-base' from its worktree), and update $branch itself only with 'git pull --ff-only'." >&2
  exit 1
}
