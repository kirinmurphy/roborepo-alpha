## Deliver Finished Work

Deliver finished requested work through a pull request once its checks pass. Skip this workflow for
unfinished experiments, when the user asks to keep work local, or when the repository has no
remote. Follow the active skill's delivery rules when it defines its own.

When eligible work starts on the default branch, confirm the proposed feature branch name is
unused, refresh the remote tracking refs, and compare the local base with the pull request's remote
base. If unrelated unpublished base commits would enter the pull request, report the mismatch and
pause delivery. Request approval to run `git switch -c <branch>` in the primary checkout. The switch
carries existing edits in place.

Stage only the paths or hunks from the requested work. Check what the commit will include so any
unrelated staged edits stay out of it. Commit on the feature branch. Confirm the target repository,
base, and outgoing commits before pushing. Push the feature branch, open or update its pull
request with a written body, and follow CI at the pushed head. Fix failures attributable
to the change or report the blocker. Report the CI result and leave the merge to the user. If
the push is refused, report the exact command and reason.

Leave the primary checkout on the feature branch after a switch. Tell the user which branch is
checked out and that they must return to the base branch before plan lifecycle transitions.
