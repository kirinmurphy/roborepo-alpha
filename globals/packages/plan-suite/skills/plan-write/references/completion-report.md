# Completion Report

Every plan command ends by writing a completion report in the chat: the message it writes when it
stops, whether it finished, refused, or needs the user. Read this reference before writing one.
Each command's own instructions add only what is specific to it; everything here applies to all of
them, whether or not any general output rules are enabled.

## Contents

- The reader
- Shape
- No unintroduced terms
- Visual evidence
- Cold-reader check
- What to leave out
- `next_action`

## The reader

Write for a cold reader: the user coming back hours later from other work, or someone who never saw
the session. They do not remember what the plan was for, have not watched the agent build anything,
and may not know the domain. From the report alone they must be able to answer three questions:

1. What is this plan for?
2. What changed, for a person using it?
3. What must I do or decide?

A report has two layers. The first is plain context the cold reader needs, and it is always shown.
The second is technical detail (commit ids, check names, files, Validator passes, the Decision Log),
offered in one line and given when asked. Part of it is already in the plan document, such as the
Decision Log and a `## Review` record; the rest the session gives in the chat. When short and self-contained
conflict, self-contained wins: a report that drops the one sentence a cold reader needs has saved
nothing, because the reader has to ask anyway.

## Shape

In this order, skipping any section that would be empty. Separate sections with a `━` rule in a
report longer than one screen.

1. **Headline.** One bold line naming the plan by its H1 title and what happened to it, with the
   plan's id in parentheses on first mention only.
2. **What this plan is for.** One sentence a cold reader understands. Write it fresh for this
   reader rather than copying the plan's Summary, which was written for someone reading the plan.
3. **What changed.** Each change as something a person would notice: what they can now do, what
   behaves differently, what the command did to the plan. Outcome first; the mechanism only when
   the reader needs it to act. Visual evidence goes here (see Visual evidence).
4. **Needs you.** Everything the reader must do or decide, in the order to do it:
   - each decision with its options, what each option leads to, and a recommendation;
   - each action with why it matters and the exact command when there is one.
   The last item is the next command, when there is one. When nothing needs the reader, say so.
5. **Record.** A short lookup block: the plan's store-relative path, its lifecycle folder, the
   branch when there is one, and a link to the plan document. End with a one-line offer of the
   technical detail.

```text
Record
- Plan: "<title>" (<id>), <store-relative path>
- Lifecycle: <where the plan is now>
- Branch: <branch> | none
- Details: decisions and findings the plan records are in the plan document; ask here for any detail
```

Add a Record line only for a non-default fact the prose did not state, such as a shareable link or
a server left running.

## No unintroduced terms

Every term, command, flag, plan id, file, or internal name in the report is either explained in
plain words in the report itself or is common knowledge for a developer. A command or identifier
appears only beside a plain description of what it does; the description comes first.

Not self-contained:

> Delivery refusals name the field that failed, such as `head commit is X, expected pushed head Y`.

Self-contained:

> When the new `roborepo delivery` commands refuse to open or update a pull request, the error now
> says which value was wrong, for example the commit it found and the commit it expected.

A term explained earlier in the session does not count: the reader returns to the report cold.

## Visual evidence

- A change visible in an interface comes with a screenshot or recording.
- A change to a flow or sequence comes with a before/after diagram.
- When such a change has neither, the report says why in one line.

Reuse evidence `/plan-execute` or `feature-verification` already captured; do not capture it again
for the report. Put images in the conversation, not only a path to them. A diagram illustrates; it
never stands in for a check that did not run.

## Cold-reader check

Before delivering the report, test it the way a cold reader would meet it.

| Command | Check |
| --- | --- |
| `/plan-promote`, `/plan-execute`, `/plan-review`, `/plan-close` | Checker agent |
| `/plan-write`, `/plan-archive` | In-session self-check |

**Checker agent.** Start a separate agent with a fresh context; a cheaper model is fine, since the
task is reading comprehension. Give it only the drafted report, never the plan, the diff, or an
account of the session, with this instruction:

```text
You are reading a report with no other context. Using only the report, answer:
1. What is this plan for?
2. What changed, for a person using it?
3. What must the reader do or decide?
Then list every term, command, flag, id, or name you would have to ask about before you could act
on the report: one it uses without saying in plain words what it is or does. Do not list common
developer knowledge, the plan's own title and id, or a term the report describes, even briefly.
Do not guess from outside knowledge.
```

Compare its three answers with what the report was meant to say. If any answer is wrong or missing,
or the term list is not empty, rewrite the report and check again. Allow at most two rewrites, then
deliver; if the last check still flagged terms or wrong answers, say in one line which ones.

**In-session self-check.** Where no subagent is available, and for the two commands that always use
it, run the same test as a separate step: reread the report as if seeing it for the first time,
answer the three questions from the report alone, and list each term beside the place in the report
where it is introduced. A term with no such place is unexplained. Rewrite and repeat under the same
two-rewrite cap.

The check is not shown to the user unless the cap was reached.

## What to leave out

Unless it is the point of an exception or the reader needs it to act:

- commit ids;
- counts of tasks, decisions, findings, passes, or checks;
- a passing gate, a clean validation pass, or a passing preflight;
- file lists, Git status, validator output, and Decision Log entries;
- anything already said earlier in the report.

## `next_action`

Whenever a plan command writes a plan's `next_action`, it meets the same standard: one sentence a
cold reader can act on, naming the step in plain words and the command when there is one. The Plans
portal shows this line on its own, beside the plan's title, so it cannot lean on the session.

Not actionable: `Fix V2 findings, then rerun gate`.
Actionable: `Two review findings about the retry limit need fixing; run /plan-execute on this plan.`
