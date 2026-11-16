## Branch Safety

Ask before moving a checkout: `checkout`, `switch`, `reset --hard`, `rebase`, `merge`, or stashing
edits you did not make. A branch that looks wrong for the task is still the one the user chose.

Ask before creating a branch or worktree, even to isolate work or to commit. Invoking a workflow
that explicitly creates its own worktree, such as `/plan-execute`, authorizes that worktree under
the workflow's directory policy. Follow the selected delivery procedure for other work and retain
the harness approval for worktree creation or checkout changes.

Need a different base (once the user agrees)? `git worktree add -b <name> <path> <base>` — isolated tree, checkout untouched.

Once work belongs in a worktree, whether you created it or the user named it, move the session into
it before the first edit, so the user approves the folder once rather than every file in it.

Uncommitted changes you did not make belong to someone else. Never revert or stash them, and stage
explicit paths rather than `-A`/`.` so they cannot ride along in your commit.
