# Sourced by the hooks that record a commit. The plans store worktree (branch repo-plans) changes only
# through `roborepo plans` commands, whose own Git calls run with hooks off, so a commit or merge that
# reaches one of these hooks there was made by hand.
roborepo_refuse_plans_store() {
  [ "$(git symbolic-ref --quiet --short HEAD 2>/dev/null)" = "repo-plans" ] || return 0
  echo "roborepo: this is the plans store (branch repo-plans). Change plans with 'roborepo plans' commands (show, then save), which commit and push for you." >&2
  exit 1
}
