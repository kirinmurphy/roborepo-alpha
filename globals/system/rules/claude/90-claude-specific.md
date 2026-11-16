## Claude Specifics

- Optional package hooks may block broad tools and nudge toward package-specific alternatives. Treat that as redirect, not failure.
- In the desktop app, enter a linked worktree of this repo with `EnterWorktree({ path })`.
  `change_directory` re-files the whole session under the worktree. `request_directory` alone
  leaves the session in the old folder, where edits still prompt.
