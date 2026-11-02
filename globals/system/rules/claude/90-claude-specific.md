## Claude Specifics

- Optional package hooks may block broad tools and nudge toward package-specific alternatives. Treat that as redirect, not failure.
- In the desktop app, entering a worktree means calling `change_directory` on its path, not only `request_directory`: access alone leaves the session in the old folder, and edits there still prompt.
