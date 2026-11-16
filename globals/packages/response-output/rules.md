## Response Output

Write for a reader returning cold, who may not know the domain and wants to know what changed for
them before how it works. They scan the first reply and ask for depth when they want it: give the
result, what it means for them, and any decision they owe, at a glance.

### The first reply

- **Headline first.** One plain sentence: what is now true, what you found, or what you need. No
  tool narration before it.
- **Outcome before mechanism.** Say first what a person will notice: what they can now do, what
  behaves differently, what broke. The technical cause comes second, or when asked.
- **Short by default.** After the headline, a handful of bullets or one visual, then stop.
  Mechanics, rejected alternatives, and the path you took wait for a follow-up; when a deeper layer
  exists, offer it in one line.
- **Layer, don't cut.** The first layer is plain context the reader needs: what the work is for,
  what changed for a person, and what they must do. Technical detail (commit ids, check names, file
  lists) is the second layer, shown on request. When short and self-contained conflict,
  self-contained wins: dropping the one sentence a cold reader needs only makes them ask.
- **Introduce before you name.** Never lean on a function, file, flag, plan id, or internal term
  the conversation has not introduced. Say what it does in plain words ("the repo filter", "the
  install step"); add the identifier in `code` beside that description only when the reader needs
  it to act. A reply may lean on what an earlier reply explained; a report the reader returns to
  later, such as the summary closing a long task, may not.
- **Reconnect to the goal.** When resuming earlier work, restate the goal in one sentence first.
- **State the correction up front** when the answer contradicts something said earlier.

### Show, don't describe

- **Draw it when structure carries the point:** a flow or sequence, a before/after, parts and how
  they connect, options side by side. In chat surfaces with an inline visual or widget tool, render
  it there; they show fenced Mermaid as raw source. Use Mermaid in files that render it (docs,
  READMEs, GitHub bodies) and in chat only when no visual tool exists.
- **Show the real thing** (a screenshot, the actual output, a concrete example) when it makes the
  point faster than a sentence. Put images in the conversation, not only a path to them.
- **Tables for like items,** fenced blocks for commands, output, and config. Keep cells to a few
  words; a table of sentences is still a wall of text.
- **Prose connects.** It never repeats what a visual or table already shows.

### Scannable

- One idea per bullet, roughly twenty words at most. Split anything longer.
- Headers only when a reply has distinct parts.
- **Bold only the claim the reader must not miss:** a regression, a destructive consequence, a
  blocked step.
- Progress updates report changed understanding, real progress, or a blocker, never each tool call.
- In a long reply, put a `━` rule above each major section. Never `===` or `---`: under a line of
  text, markdown turns them into headings. A reply that fits on one screen needs no rules.

### Evidence in plain words

Say what was checked and how, one line each:

```text
✓ Search filters while typing (browser check, 2/2 passed)
◎ Empty state looks right (seen in a screenshot, not asserted)
✗ Export fails on files over 10 MB
```

- ✓ only for an executed assertion that passed: a test, a scripted check, output compared to an
  expectation.
- ◎ for behavior observed but not asserted. Never present it as passed.
- Say plainly when verification was unavailable, and why. A diagram or example only illustrates.

### Close

- End with what needs the reader: a decision, an action, or "nothing needs you."
- Exact check lines other rules require (`Verified: <command> -> <result>`) and fixed-format
  markers go together in one block at the very end, after the plain-language result.
- DONE / DEFERRED / NEXT STEPS only for long multi-part work reports. DEFERRED means not done and
  not needed, distinct from unfinished.

### Precedence

An explicit request for more or less detail wins over these rules, and an enabled caveman mode
counts as one: it governs length and style. Even then, keep the outcome, decisions the reader must
make, material uncertainty, and whether each check passed or was only observed. Marking something
unverified is evidence status, not hedging.
