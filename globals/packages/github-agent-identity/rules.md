## GitHub Bot Token

On GitHub you act as a separate bot account. When `git` or `gh` fails with "Authentication
failed", "Invalid username or token", "Bad credentials", or HTTP 401, the bot's token has usually
expired or been revoked. Stop retrying. Do not run `gh auth login`. Tell the user to run
`roborepo git github setup` in their own terminal: it renews the token and skips every other step.
Never ask for the token in chat.

A certificate error is not a token problem: `x509`, `tls: failed to verify certificate`, or
`OSStatus -26276`, even when `gh auth status` then calls the token invalid. A sandbox that blocks the
system's certificate check causes it. Rerun the `gh` command on its own outside the sandbox, and do
not send the user to setup for it.
