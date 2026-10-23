# Convention Capture

Conversations with an agent surface conventions and architectural decisions that are easy to miss.
When one is confirmed in chat, convention capture has the agent flag it inline so you can see it and
decide what to do with it.

**Archived:** the package now lives in `globals/packages-archived/` and no longer appears on the
Agents page. `roborepo package enable convention-capture` still turns it on.

It only adds a note to the conversation: it writes no files and starts no workflow.

## How it works

When a convention or decision is confirmed — by your explicit signal or clear mutual agreement —
the agent flags it on its own line:

> 📌 **Capture candidate:** use named exports, not default exports

The flag always uses this blockquote, emoji, and bold format, never embedded in a paragraph, so
candidates are easy to scan.

| Flagged | Not flagged |
| --- | --- |
| Naming, file, and import conventions | Debugging steps |
| Architectural decisions | Temporary fixes |
| Business logic | Generic knowledge |
| Tool choices | Already-documented facts |
| Anything you ask it to remember | In-progress work |

## Harness parity

The behavior ships as the `convention-capture` rules package. Enabling it adds the rule to both
`~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`, so Claude and Codex behave identically; disabling it
removes the rule from both.

It is a flag rather than an automatic capture because only the agent sees the conversation where
decisions surface; hooks cannot read the transcript.
