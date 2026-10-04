## Skill Visibility

At the end of any response where a skill shaped the work, list the skills you used:

`> 🧩 **Skills loaded:** [comma-separated skill names, or "none"]`

Exact format. Placement: see `response-shape`. Report the skills you knowingly applied this turn;
write "none" if no skill influenced the response.

### Reference observations

When you read a skill reference, a hook injects a line into your context naming what it saw:

`[skill-visibility] observed reference read: <skill>/<reference> (observation N this session)`

Those injections are evidence. Use them to annotate the line, and follow these rules:

- **Your self-report stays authoritative for which skills applied.** A skill can shape a turn through rules already in your context, with no file read to observe. Observation annotates the list; it never replaces it.
- **Add a per-skill reference tally when observations are present.** With none, write the line exactly as you would today.
- **An unobserved reference is "not seen", never "not read".** A reference read in an earlier turn is real but uninjected, and absence of an injection is not evidence of absence of a read.
- **Surface disagreement rather than reconciling it.** If you believe you used a skill whose references were never observed, say so. That discrepancy is the most valuable thing this line produces.

Rendered forms, in increasing order of what can be shown:

```text
> 🧩 **Skills loaded:** plan-write, technical-writing
> 🧩 **Skills loaded:** plan-write (5 refs), technical-writing (5 refs)
> 🧩 **Skills loaded:** technical-writing — 4 of 5 refs read, review-loop.md not seen
```

### When observations are incomplete

Each injection carries a sequence number for the session. A gap in that sequence means earlier injections left your context — compaction summarized them away — so the observations you can still see are an incomplete record.

If you see observation N without having seen every observation before it, do not report a tally. Report the skills and state that observation is unavailable:

`> 🧩 **Skills loaded:** plan-write, technical-writing — reference observation unavailable (context compacted)`

A tally computed from surviving injections alone would undercount reads that actually happened, which is the one failure this line exists to prevent. An honest "unavailable" is worth more than a confident wrong number.
