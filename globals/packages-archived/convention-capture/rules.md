## Session Capture

When a convention, architectural decision, or behavior is confirmed by explicit user signal or clear mutual agreement, flag it:

`> 📌 **Capture candidate:** [one-line description]`

Exact format every time. Put it on its own line at the end of the response, never inside a paragraph. Do not write to any file automatically —
flagging only; the user triggers capture when ready.

Only flag what still needs a home in a skill, rule, hook, doc, or config not currently open.

| Qualifies | Does not qualify |
| --- | --- |
| Naming/file/import conventions | Debugging steps, temp fixes, generic knowledge |
| Architectural decisions, business logic | Already-documented things, in-progress work |
| Tool choices, explicit user request | Anything you can just write down as part of the work in front of you — do it and say so, don't flag |
| — | Anything already enforced by code just written/found — the code carries it, a flag would duplicate it |

Before flagging, ask: "would the user have to add this to a skill/rule/hook for it to hold?" If no
because the code already makes it hold, say nothing.

## Determinism Opportunity

When a repeatable task is being done by agent reasoning that a script, helper, lint rule, hook, or test could do instead, flag it:

`> ⚙️ **Determinism opportunity:** [one-line description] — [what would implement it]`

Exact format. Put it on its own line at the end of the response, never inside a paragraph.

The test is whether the task has a checkable right answer that does not need judgment about the current change. Flag when:

- **The same check is being repeated by hand** — a test or lint rule would answer it once, for everyone, without a model call.
- **A rule is stated but nothing enforces it** — name the helper/hook/test that would make it hold by construction.
- **Correctness was established by manual inspection** — say what assertion would have caught it.

Prefer the cheapest durable mechanism that actually runs: an existing test file over a new one, a shared helper over a repeated snippet, a hook over an instruction the model must remember.

**Build it, don't flag it, when the work is additive and non-destructive.** A new assertion, test, shared helper, or stricter check that only adds coverage is not a proposal — it is the work. If there is no compelling argument against it, implement it and report what you built. Flagging is for cases where the mechanism would change existing behavior, delete something, force a design decision, or land well outside the current task's scope. "The user might not want more validation" is not a compelling argument.

This is the Decide, Don't Ask rule applied to determinism specifically: what breaks if this is wrong, and how hard is it to undo?

Do not flag one-off work, exploratory debugging, or tasks that genuinely need judgment about intent. Do not flag when the deterministic version already exists — point at it instead.
