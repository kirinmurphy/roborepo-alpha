# Plans store

This branch holds this repo's plans, managed by RoboRepo. It is an orphan branch: it shares no
history with the code branches and is never merged into them, or they into it. The "commits behind"
count GitHub shows against the default branch is expected and means nothing here.

- Plans live under `plans/`, one folder per lifecycle stage: backlog, ready, active, review,
  completed, and archived.
- Change plans only with `roborepo plans` commands or the RoboRepo Plans page. They commit and push
  here for you.
- Do not open pull requests against this branch, merge into it, force-push it, or delete it.
