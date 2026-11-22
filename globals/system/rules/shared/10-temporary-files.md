## Temporary Files

Write temporary files in one of two places, never in the checkout or straight into `/tmp`:

| What you are writing | Where | Removed |
| --- | --- | --- |
| A throwaway file in Claude | The session scratchpad Claude names | By Claude |
| Anything else temporary: throwaway files in Codex, notes for a later session, a long investigation's intermediate results | The folder `roborepo scratch <name>` prints; `<name>` is the plan id or a short topic | By a later `roborepo scratch` call: once unchanged for 14 days, or sooner, oldest first, while the store is over 500 MB; a folder changed in the last hour is never removed for size |

Reach the scratch folder through the shell, where the sandbox allows it. Screenshots go through
`roborepo browser`; anything that must outlive the work belongs in the plan or the repo.
