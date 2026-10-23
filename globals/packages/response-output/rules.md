## Response Output

Write so the reader finds the result, why it matters, and any decision they owe without parsing the
work that produced it. Output renders as markdown: separation comes from position, rules, and
emphasis.

### Opening

- **Answer first.** Open with the direct answer, result, or decision in one or two sentences, before
  tool calls or reasoning. If it is not yet known, say what is about to be checked and why.
- **State the correction up front** when the answer contradicts something said earlier.
- **Give enough context to follow.** When picking up prior context (a summary, a handoff, "where are
  we"), restate the goal in a sentence before the outcome. Define an unfamiliar term the first time
  it matters. Reconnect to the user's goal without replaying the conversation.
- **Adapt detail.** Default to outcomes. Explain architecture and tradeoffs when they are material,
  and code-level mechanics when the reader needs them to act or asks for them.

### Form

- **Choose the clearest medium; prose is the fallback.** Tables for like items or comparisons;
  fenced blocks for commands, output, config, and file layout; Mermaid for workflows and
  relationships; a concrete example, screenshot, recording, or actual output when it shows the point
  faster than a description. Keep prose connective; never narrate what a table or diagram already
  shows.
- **Use headers for distinct parts** of a long response. Short answers need none.
- **Bold the load-bearing claim** the reader must not miss — a regression, a destructive
  consequence, a blocked step — and nothing else.
- **Make progress updates meaningful.** Report changed understanding, actual progress, or a blocker;
  do not narrate each tool call.
- **Report evidence by kind.** Say which checks *passed* (executed assertions), which behavior was
  *observed* but not asserted (a screenshot, a manual run), which material only *illustrates* (a
  diagram, an example), and which verification was *unavailable* and why. Never present observed or
  illustrative material as passed.

### Separators

Use `━` between major sections of a long response, directly above the section's header, and `┈`
above a list that needs separating from the prose before it or from a different list. Never `===` or
`---`: under a line of text, markdown turns them into headings. Skip rules when the reply fits on
one screen; never stack the two weights or border a section on both sides.

```text
━━━━━━━━━━━━━━━━━━━━━━━━━━
## What changed

Three files, one behavior.
┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈
- `a.mjs` — the fix
- `b.mjs` — its regression
```

### Close

- **Lead the close with what matters:** the result, the best available evidence, and what needs the
  reader's attention. Separate it from the work with one `━` rule.
- **Report each check as `Verified: <command> -> <pass|fail|blocked>`**, one per line, in a fenced
  block.
- **Mark the actionable parts** of a work report with DONE / DEFERRED / NEXT STEPS. DEFERRED means
  not done and not needed, distinct from unfinished. A short answer needs no closing block, and a
  skill's own output format may differ; keep whichever structure is used consistent within the
  response.
- Keep fixed-format lines (verification, and markers other rules define) together at the end, each
  on its own line, after the separator.

### Precedence

An explicit request for more or less detail wins over these rules, and an enabled caveman mode
counts as one: it governs length and style. Even then, keep the outcome, decisions the reader must
make, material uncertainty, and whether each check passed or was only observed. Marking something
unverified is evidence status, not hedging.
