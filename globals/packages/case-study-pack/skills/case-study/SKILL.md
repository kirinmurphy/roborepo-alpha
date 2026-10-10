---
name: case-study
description: >
  Write a long-form architecture case study about a real design decision in a
  codebase. Follows a 6-beat storyline arc (plus an optional 7th recommendation
  beat). Written so the architectural
  ideas are comprehensible across the whole audience spectrum — non-technical to
  highly technical — without becoming a coding tutorial. Trigger: /case-study,
  "write a case study", "draft the architecture case study", "case study about
  <topic>". Do not use for ordinary implementation notes, README updates,
  planning docs, PR descriptions, changelogs, or short technical explanations
  unless the user asks for a case study/article.
---

# Architecture Case Study Writer

Write a long-form architecture case study grounded in real code. The subject is an
architectural **decision** and its story, not a feature list and not a code walkthrough.

## Audience model (read this first — it governs everything)

The audience spans non-technical to highly technical and everywhere between.

- **This is NOT a coding tutorial.** The purpose is to convey architectural ideas
  and the relationships between them, not to teach programming. Code examples
  illustrate _relationships_, not _how-to_.
- **Comprehensible, not condescending.** A non-technical reader should be able to
  follow the logic of every decision — explained without assuming they already have
  the context. But the writing is not _for_ an audience with zero code background.
- **Don't overwhelm the technical reader.** The extra context that helps a less
  technical reader must stay concise and woven in. A highly technical reader should
  find the piece logical and fluid, never padded with beginner explanation.
- **One spine for everyone.** Aim for prose where every reader, at their own level,
  finds it coherent. Avoid forking the article into "simple version" and "real
  version." Explain the concept once, at the right altitude, when it's needed.
- **Calibrate facts to the stated floor, not just to zero.** "Comprehensible to a
  non-technical reader" is the default floor. When the user sets a higher floor for a
  given article (e.g. "assume intermediate Claude/Codex harness knowledge"), every
  sentence has to clear THAT floor, not the default one. A sentence that states
  something the stated floor's reader already knows is padding, not an on-ramp — cut
  it. Examples that fail an intermediate-harness-knowledge floor: naming which of two
  named tools is more widely used ("the two most common coding-agent harnesses in use
  today"), restating what a term already named means ("a `PreToolUse` hook — the hook
  that fires before a tool call executes"), or explaining a general software concept
  the piece isn't about ("has to work like configuration, not a one-time setup
  script"). Test: would the stated-floor reader already know this without the
  sentence? If yes, cut it — it is scene-setting, not information.

## Code rules

- Code is **not in the foreground.** Prose and the storyline carry the article.
- Include code only when a concept is fundamental to the implementation and a small
  reference makes the architectural relationship clearer.
- Show **only enough code to explain the architectural idea** — never the full
  implementation, never every detail. Trim to the few lines that reveal the relationship.
  Strip what is ceremony rather than idea: error-handling wrappers (try/catch/throw),
  logging, optional methods the prose never names, defensive guards, multi-line branches
  that collapse to one. If a line isn't what the surrounding prose is pointing at, cut it.
  A real snippet trimmed to its intent beats a complete one that buries the point.
- Do not annotate code with general programming practice. Don't explain syntax or
  teach the language. The snippet exists to show how pieces relate, nothing more.
- **Don't show code for generic or rudimentary logic.** If the snippet is the same
  thing anyone would write regardless of this architecture (a read-decide-write loop, a
  basic null check, a standard CRUD call), describe it in one prose sentence and cut the
  block. Spend the code budget only on what is non-obvious or specific to _this_ design —
  the platform quirk, the deliberate seam, the surprising line. A block earns its place
  by showing something the prose can't say as cleanly, not by proving the code exists.
- A diagram or analogy is often better than code for this audience — prefer it when
  it conveys the relationship more directly.
- Snippets must be real, taken from the actual repo. Never invent code.

## Visualize structure, don't describe it in prose

Actively look for places a diagram, table, or chart conveys a relationship, workflow,
or comparison better than a paragraph, and use one when it does. This audience often
follows a picture of _how pieces relate_ faster than prose describing it. When the
piece is explaining something structured — a sequence, a comparison, a set of
tradeoffs, a shape of data — reach for the visual form of that structure before
defaulting to a dense paragraph.

- **Where diagrams earn their place:** a sequence of steps where order matters (what
  happens before what), a flow from one source to several outputs, a decision with
  branches, a dependency or data path between components, a state transition. If the
  prose is spending sentences establishing "A feeds B, which the renderer turns into C
  and D," a diagram says it at a glance.
- **Same bar as code.** A diagram, table, or chart must reveal a relationship the prose
  can't say as cleanly — not decorate a point already clear. Don't diagram a linear
  two-step process or restate a sentence. One strong visual beats three weak ones.
- **Use real names and real numbers.** Nodes, steps, table cells, and chart values
  carry the actual component, file, function, or measured data from the repo/source
  docs, exactly as code snippets do. Never invent structure or figures.
- **Mermaid for relationships and flow.** Fenced ` ```mermaid ` blocks. Prefer
  `sequenceDiagram` for ordered interactions, `flowchart` for data/dependency paths,
  `stateDiagram-v2` for states. Keep them small — a diagram the reader can't parse at a
  glance has failed.
- **Tables for comparison and enumeration.** When the prose is listing options,
  tradeoffs, before/after states, or any set of items sharing the same dimensions
  (Roads Not Taken is a common fit), a Markdown table reads faster than "Option A
  does X, while option B does Y, whereas option C..." prose.
- **Charts or a small code/data snippet for measured behavior.** When a decision is
  backed by real numbers (latency, size, cost, throughput), show the numbers — a small
  fenced data snippet or table beats restating them as a sentence of figures.
- **Canvas/interactive charts — only when the render target supports it, always with a
  fallback.** If the piece will be published somewhere that renders live HTML/canvas
  (e.g. an Artifact), a canvas-based chart can go beyond what mermaid or a static table
  can show — use it when the extra depth (an animated trace, an interactive
  comparison) genuinely earns its place over a static alternative. If the piece will
  also or instead be read as plain Markdown (a repo file, a doc site without canvas
  rendering), it must still work there: include a Markdown-native fallback in the same
  location — a table, a mermaid diagram, or a data snippet that conveys the same
  structure without executing anything. The fallback does not need to reproduce the
  canvas version's exact behavior; it only needs to stand in as a legible placeholder
  so the piece is never broken or empty for a reader without canvas rendering.
- The visual supports the prose; it does not replace the beat. The surrounding text
  still names what the reader should take from it.

## Before writing

1. Identify the topic. If the user named one, use it. Otherwise read the project's
   case-study-candidates list (e.g. `docs/possible-case-studies.md`) and ask which to write.
2. Read the actual code for that topic (the listed key files). Ground the article in
   what the code really does — real names, real flow. Never invent behavior.
3. Read any linked source/design docs for the original reasoning and tradeoffs.
4. Save the draft to the project's case study directory. **Name the file from the title**,
   not the slug: kebab-case the title (lowercase, drop punctuation, spaces→dashes). If
   the result runs long, truncate at a word boundary — prefer a natural semantic break
   such as the part before a `:` colon — keeping it roughly ≤50 characters. The filename
   should read as a shortened title, not a separate label. (The frontmatter `slug` is the
   public URL and may differ from the filename for SEO; the filename tracks the title.)

## Article tags

When the destination project uses article tags, read its tag manifest before choosing any.
Use only tags from the project's approved or whitelist vocabulary. Also read the project's
blacklist and never assign a blacklisted tag, even if it appears in the approved list or
would otherwise describe the article. If the project exposes both lists, the blacklist wins.

The reserved blacklist begins with:

1. `architecture`

## Splitting one source into multiple articles

When a source covers several distinct decisions, split **by architectural concept (the
decision), not by user-facing feature.** Splitting by feature slices one concept across
several articles and pads each with a neighbor's concept.

- **One article owns one decision.** "No database," "branch state is the source of truth"
  are decisions. "Preview," "publishing," "multilingual" are usually _consequences_ of a
  decision, not decisions — fold each into the article whose decision produces it.
- **Demote a feature to an example when it isn't the concept.** If the article is about a
  mechanism (atomic multi-file commit) and the feature (multilingual publishing) is one
  reason to use it, the mechanism is the title; the feature is one example.
- **No concept split across two articles.** When a second article reuses a mechanism the
  first owns, reference it ("written atomically, as in <article A>"), don't re-explain.
- Propose the regrouped set and get user confirmation before drafting.

## Anonymization (decide per article, up front)

Some articles name the real project — its brand, links, and details are part of the
point. Others quote a codebase that must stay unidentified. This is not a fixed rule;
it is a decision to make before drafting.

**Ask at the start of each case study session whether to anonymize**, unless the user has
already said which they want. Phrase it plainly: "Name the real project, or anonymize
the source?" Then follow the answer for the whole piece.

- **Explicit user instruction always wins.** If the user says to use the real project
  name, links, or terminology, use them — even in a repo that normally anonymizes.
  If the user says to anonymize, anonymize.
- **When anonymizing**, strip the identity but keep the architecture in full:
  - No real brand, product, company, or domain names from the source — replace with
    neutral stand-ins, one stand-in per real name, used consistently.
  - No source-specific proper nouns carried in from the code — table, schema, RPC, or
    internal service names that name the actual product. A name that reveals the domain
    (`restaurants`, `menu_items`) becomes a generic equivalent (`locations`, `items`,
    `listings`); the architectural point survives the rename.
  - This applies to **code snippets too**, not just prose. A leaked name in a fenced
    block is as much a leak as one in a sentence — copied snippets are where identity
    most often slips through.
- **When naming the real project**, use the actual names, links, and details freely;
  do not invent stand-ins.
- **A project may hard-enforce a blacklist** (a list file or build/check script) for
  terms that must never ship regardless of the per-article choice. Those terms are
  blocked even when the article otherwise uses real names; the draft must pass that
  check before it is done.

## The 6-beat arc (mandatory spine, in order)

Build context progressively. Introduce each technical concept ONLY at the moment a
decision requires it — concepts arrive as the answer to "why?", never as a glossary
up front. This is what keeps the piece readable across skill levels.

1. **The Problem** — Open with the real-world problem in plain language. What was
   broken, slow, fragile, or impossible before. State why it mattered through the
   concrete consequence, not through narrative or appeals to feeling.

2. **The Experience We Wanted** — The user-facing outcome driving the design. Describe
   the behavior the product should produce, stated as a goal. Do not stage a scene or
   address the reader in the second person to set it up.

3. **What That Forced On Us** — The architectural necessities the experience
   _demands_. The bridge beat: introduce the core technical concepts here, each one
   justified by beat 2. "Because we wanted X, we now needed Y."

4. **How We Built It** — The implementation and how it satisfies beat 3. Walk the
   real flow using real component/function names. Code references (small, relationship-
   focused) live here if anywhere. Prose still leads.

5. **What It Still Lacks** — Honest gaps and limits of the chosen solution. Builds
   trust. Don't oversell.

6. **Roads Not Taken** — Alternatives and their tradeoffs. Why the chosen path won,
   and fairly, where an alternative might be better. Surface the pros/cons that
   mattered. Keep this tighter than beats 3–4.

## Optional beat: Roads We Should Consider Taking

A 7th beat, included **only when it earns its place** — omit it entirely when nothing
qualifies. Most posts will not have one. It is not a summary of beats 5–6; it is a
recommendation.

Include it when an item from **What It Still Lacks** or **Roads Not Taken** rises above
"acknowledged limitation" to "this should be changed, not maintained" — a gap or
alternative the analysis concludes is worth acting on, not just living with.

What it must contain:

- **The recommendation, stated plainly.** What should change.
- **The qualitative case for why it crosses the line.** Not just _what_ the behavior
  is — that may already be covered in beat 5 or 6 — but _why_ it outranks the things the
  design currently keeps. What makes this the one worth replacing: the cost it imposes,
  the risk it carries, the leverage of fixing it, why it matters more than the other
  open items. The reader should understand the priority judgment, not just the change.

What it must avoid:

- **Do not regurgitate behavior already explained.** If beat 5 or 6 already laid out the
  mechanics, reference them and spend the words on the priority argument, not a re-tell.
- Keep it tight — shorter than beats 3–4. It is a pointed call, not a new design section.

Phrase the header in the article's voice (e.g. "Roads We Should Consider Taking", or a
more specific framing of the single recommendation).

## Voice & restraint (governs word choice everywhere)

The register is matter-of-fact. Logical and flowing, but agnostic to emotion and to
subjective coloring of an outcome. Let the reader draw the value judgment; the prose
supplies the facts and the reasoning.

- **No emotional or evaluative adjectives about the work itself.** Cut words like
  _uncomfortable, proudest, happy, striking, awkward, elegant, beautiful, painful,
  scary, gold, exciting_. If a word rates how the reader or author should _feel_ about
  a fact, remove it and let the fact stand.
- **Opinion is allowed; emotion is not.** Comparative, defensible judgments belong in
  the piece — "A is more reliable than B," "this approach is overkill for the current
  case," "the index is the better fit." State them flatly, backed by the reason. What's
  banned is sentiment _about_ the outcome, not the analytical conclusion.
- **No unfounded claims about what "most teams" or "everyone" does.** Don't open or
  argue from an unsupported generalization about industry behavior ("Most teams add a
  dedicated search engine the moment a product needs filters"). It rests on sentiment,
  not fact, and it manufactures an adversary that distracts from analyzing the problem
  itself. State the technical assumption being challenged directly ("Faceted search is
  often assumed to need a dedicated search engine") and let the analysis carry the
  point. The piece argues against an idea, not against a strawman population.
- **Don't invent a wrong explanation just to rule it out.** A clause like "not because
  of a missing setting, but because X" manufactures a hypothesis nobody raised, purely
  to knock it down before stating X. It adds a phantom scenario and makes the sentence
  longer without adding fact — the reader was never considering the ruled-out
  explanation, so ruling it out teaches nothing. State the real cause directly: "the
  two tools disagree on how many answers a permission question can have," not "not
  because of a missing setting, but because the two tools disagree on how many answers
  a permission question can have." If a real, plausible misconception exists and is
  worth heading off, name it as a misconception ("often assumed to..."), don't dress
  it up as a hypothesis introduced only to be dismissed.
- **No staged scenes or second-person narration to set up a point.** Don't write
  "Picture the end of a workday" or "You've just made a few commits." State the
  situation directly: "At the end of a set of commits, a developer wants a review."
- **Say it the short way.** Prefer the plain phrasing over the evocative one.
  "machinery we built might be more than the problem currently needs" → "the design
  may be more than the problem needs." Cut clauses that restate what was just said.
- **Cut sentences that carry no new information.** A sentence whose only job is to
  segue, announce, or restate ("That requirement is where the design starts," "This
  is where it gets interesting," "With that established, we can move on") adds words
  without adding fact. The next beat's content is the transition; let it transition.
  Delete the connector sentence and start the real point.
- **Drop enumerating scaffolding; lead with the noun.** When you list two or three
  things, the "The first is… / The second is…" framing and a preceding "There are two
  X" announce are scaffolding the items don't need. Cut the announce and open each item
  with its own subject: "The first is expiry. … The second is failure." → "Expiry. …
  Failure." The label carries the structure on its own.
- **Don't re-coin an established term.** Once a concept has a name in the piece, refer
  to it by that name. Re-describing it inline as decoration ("the logic that decides
  'this is request four, reject it'" when "the rejection logic" already names it) is
  fluff, and alliterative or vivid restatements are the worst offenders. Name it once,
  then use the name.
- **No aphoristic closers.** End on the concrete point, not a wisdom line. Ban endings
  shaped like "Sometimes the thing you're proudest of is the one that teaches you X."
  The conclusion should be the logical takeaway, stated once.

A sentence passes if removing every adjective and adverb leaves the same factual claim
intact. If removing them changes the meaning, the modifiers were probably coloring, not
information — cut them.

## Pruning pass (run after the draft reads well)

Once the draft is complete and coherent, do a separate pass whose only goal is fewer
words with zero context lost. Editing for concision is a distinct task from drafting —
do not try to do both at once. The rule for this pass: condense the _wording_, never
remove the _information_. A technical identifier, a number, a named mechanism, a tradeoff,
a caveat — all stay. Only the words spent explaining them shrink.

- **Cut duplicate references across sections.** The strongest source of bloat in a
  structured piece is the same fact stated in two sibling sections. If a "what it does"
  section and a "how it works" section both spell out the same detail, state it once in
  the section that owns it and let the other point to it. Example from practice: a
  use-case section said "tracking tokens and call count per phase" and the adjacent
  architecture section said "token counts and a `call_count`" — the same fact twice.
  Keep it in the one whose job it is; delete it from the other.
- **State the thesis once, then derive from it — don't re-argue it across beats.**
  Distinct from duplicate _facts_: this is the same load-bearing _claim_ re-asserted in a
  new framing in each successive beat. The 6-beat arc invites it — Problem, Experience,
  and What That Forced can each end up restating the piece's central constraint in their
  own words. Establish the claim in the beat that owns it, then have every later beat
  _use_ it as a given, never re-state it. The tell is a beat that opens by re-proving the
  prior beat's conclusion before doing its own job. Example from practice: a search
  article asserted "results identical for every viewer" in the Experience beat, then the
  next beat opened "If the result set must be identical for every viewer, then…" —
  restating the thesis as its own premise. Fixed by making the later beat consume it:
  "A viewer-independent result set has a hard consequence: the query cannot reference the
  user." Same information, but the claim is _used_ to derive the next step rather than
  argued a second time. Check each beat's opening sentence: if it re-establishes a claim
  an earlier beat already made, cut to the derivation.
- **Give each labeled section one job.** When the format uses repeated labels (e.g.
  _What it does_ / _How it's built_ / _When to apply_), police the boundary: the "what"
  section describes observable behavior, the "how" section describes mechanism. A detail
  that belongs to one should not also appear in the other. This both shortens the piece
  and sharpens what each section is for.
- **Don't re-explain a cross-referenced concept.** When a later section reuses a
  mechanism already explained earlier, name it and link the idea ("the same read-only
  file access as differential context") instead of re-describing how it works. One full
  explanation, referenced thereafter.
- **Trim connective and hedging filler that survived drafting.** "has a cost shape worth
  examining" → "accumulates cost worth examining"; "A crude estimate suffices to start"
  → "A crude estimate suffices"; "but deliberately leaves that disconnected" →
  "but leaves that disconnected". Each removal must leave the claim identical.

Make these as small surgical edits, not a rewrite — a rewrite risks dropping context the
prune pass is meant to preserve. After the pass, the word count should drop while every
identifier, number, and tradeoff from the previous version is still present.

## Tone & structure

- **Storyline first.** Narrate how the decision unfolded, not a static description.
- **Progressive concepts.** First use of a term gets a one-line plain gloss, tied to
  why it matters right then — kept short so it doesn't slow a technical reader.
- **No jargon before its justification.** If a concept hasn't earned its place in the
  story, don't name it yet.
- **Honest, not promotional.** Beats 5 and 6 win credibility.
- **Title: straightforward, names the architectural concept.** The title should
  state the design idea or decision the post is about, in plain terms a reader can
  understand before reading. Favor clarity over intrigue. Do not write
  "catchy," clever, curiosity-gap, or teaser titles that withhold the subject to
  pull the reader in. A good title lets someone scanning a list know exactly which
  architectural concept the post covers. Prefer naming the mechanism or tradeoff
  ("Promoting Data Through an Immutable Release Artifact", "Assigning One Owner Per
  Field to Stop Cross-System Drift") over evocative framings ("What You Reviewed Is
  What Ships", "One Save Button, Two Sources of Truth"). A subtitle or description
  may add color, but the title itself names the concept. **Name the specific
  technology when it sharpens the concept** — "Faceted Search as a Single Postgres
  Aggregation", "Typo-Tolerant Autocomplete with Postgres Trigrams", "Three Result
  Types from One UNION ALL Query" tell a scanning reader the exact mechanism, not
  just the general idea. Slight color is fine ("Typo-Tolerant") as long as it does
  not blur the principle; the test is whether someone scanning the list knows the
  architectural concept from the title alone.
- Section headers map to the 6 beats but phrased in the article's own voice.
- **Use `###` subheaders to name and split a beat's sub-topics.** When a beat covers more
  than one distinct idea, give each its own subheader rather than running them together
  under one heading. Even a single-topic beat reads better when the topic is _named_ — an
  unlabeled section makes the reader infer what it's about. Naming the sub-topic is itself
  the value: it tells the reader what they're about to read and lets a skimmer navigate.
  Phrase subheaders in the article's voice, like the beat headers.
- Target 1,200–2,000 words unless asked otherwise.
- End with a short "What's next" only if the source docs describe a real planned
  evolution.

## Validation step (run before reporting done)

After the draft and pruning pass read well, run a validation loop with two distinct
roles. The point is to catch rule violations the drafting pass missed, then fix them —
not to re-draft. Keep the roles separate; do not let the writer grade its own work in
the same pass.

- **Creator** — writes and revises the article. Owns the prose.
- **Validator** — does not write. Reads every rule in this skill (audience model, code
  rules, diagrams, the 6-beat arc, voice & restraint, pruning, tone & structure,
  anonymization and any project blacklist) and checks the current draft against each
  one. Its only output is a report of violations.

The loop:

1. **Validator pass.** Go through the whole article against the rules above and find
   violations. For each, write one report line: the rule it breaks, the offending
   location (section or quoted phrase), and what is wrong.
2. **If the validator finds violations**, hand the report to the creator. The creator
   revises the draft to address every reported item, then the loop returns to step 1
   for a fresh validator pass on the revised draft.
3. **If the validator finds nothing**, the article passes — proceed to _After drafting_.
4. **Cap the loop at 10 validator passes.** If the validator still reports violations on
   the 10th pass, stop and report the last validator report as an error — do not keep
   looping. Surface what remained unresolved so the user can decide.

Each pass validates the _revised_ draft, not the original — a fix in one round may
introduce a new violation, which the next pass catches.

**Surface the validator's report to the user in chat on each pass** — the violations
it found that round. The creator's revisions don't need restating; they show up in the
edited output already. The user should be able to see what each validation round caught.

## After drafting

- Report the saved path.
- Note any place where the code and the design-doc reasoning disagreed, so the user
  can reconcile.
