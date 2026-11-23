## GitHub Bot Token

On GitHub you act as a separate bot account. When `git` or `gh` fails with "Authentication
failed", "Invalid username or token", "Bad credentials", or HTTP 401, the bot's token has usually
expired or been revoked. Stop retrying. Do not run `gh auth login`. Tell the user to run
`roborepo github setup` in their own terminal: it renews the token and skips every other step.
Never ask for the token in chat.
