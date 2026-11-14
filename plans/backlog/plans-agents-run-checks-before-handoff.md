---
id: 5xw1mmqy
next_action: Run /plan-promote on this plan, deciding first whether it lands before or after "Plan reports a reader can understand after time away" (9671042v).
blocked_by: []
depends_on: []
related: ["9671042v", "i5mnkm7z", "0jped168", "9njvfh5z", "vzgsx5vz"]
reviewed_commit: 62e86111d947f66b6ce61f991cf152d90c13b8a1
worktree:
---

# Agents run every check they can before asking the user to check by hand

## Summary

When a finished plan reaches the user for review, the agent often asks the user to run checks the
agent could have run itself. The user wants to be asked only for what an agent cannot do. The
cause is in the plan suite's own instructions: they tell the implementing agent to list every
unverified check for the user and never to clear one itself. The one rule that says to run them
first sits in the Validator's checklist and loses to that explicit instruction, and the only step
that tries the checks is in `/plan-close`, after the user has already approved and merged.

This plan changes three things the user will notice:

1. By the time a plan reaches review, every check an agent can run has been run, with the result
   written into the plan.
2. The review asks the user only for checks a person must make, each with steps, the expected
   result, and the reason an agent could not do it, plus any command a tool blocked, for the user
   to allow.
3. A plan cannot be submitted for review while any open check lacks that reason.

Human approval of the reviewed commit is unchanged.

## Context

### Terms

| Term | Meaning in this plan |
| --- | --- |
| Plan suite | The `plan-suite` package in this repo: slash commands that carry a plan from idea to merged work. Its skills live under `globals/packages/plan-suite/skills/`; paths below such as `plan-execute/SKILL.md` are relative to that folder |
| `/plan-execute` | Implements a plan in its own worktree, runs a fresh-context Validator over the work, then submits the plan for review |
| `/plan-review` | Rechecks the finished work, fixes what it can, and asks the user to approve the exact commit |
| `/plan-close` | Runs after the user merges: confirms the work landed and the approval is still valid, then marks the plan completed |
| Validator | A separate agent with a fresh context that checks the work against the plan and reports problems. It never edits. It classes each problem as `fix` (the right fix is clear and within the plan, so the agent fixes it without asking) or `escalate` (a real choice, which goes to the user) |
| `## Not tested` | A section of a plan: one checkbox per piece of built work that no automated test covers. An unchecked entry is a check nobody has made yet |
| Agent-runnable check | A check an agent can make with the tools it has: running a command or test, driving the app in a browser, reading output. It may still need the user to allow a command |
| Person-only check | A check only a person can make: judging look and feel, using an account or credential an agent must not use, a physical device, or a third-party system the agent cannot reach |
| Plan-document check | `roborepo plans validate`, code in `modules/plan-suite/`. It checks the plan file itself, not the code, and reports each problem as a finding with a stable code. Its findings are either blocking or advisory (reported only) |
| Review packet | The summary `/plan-review` shows the user before asking for approval (step 6 of its skill): evidence for each criterion, fixes made, and the manual checks the user must make |
| Needs you | The part of a completion report that lists what the user must do or decide |
| Review Result | The `### Result` record `/plan-review` writes before asking for approval. It may be marked complete only when every finding and manual check is settled |
| Submit | `roborepo plans submit`: the command `/plan-execute` runs to move a finished plan from `active/` to `review/`. It reruns `roborepo plans preflight`, which refuses while required work is open |
| `feature-verification` | The skill that captures evidence a change works: command output, screenshots, and browser recordings through `roborepo browser` |

### What happens today

```mermaid
sequenceDiagram
  participant E as /plan-execute
  participant R as /plan-review
  participant U as User
  participant C as /plan-close
  E->>E: lists every unverified check under Not tested
  E->>E: submits: plan moves to review/ with open entries
  R->>R: Validator flags entries an agent could run, as a finding
  R->>U: lists every Not tested entry as a manual check
  U->>R: reports the checks run by hand
  U->>R: approves the reviewed commit
  U->>U: merges the pull request
  U->>C: runs /plan-close
  C->>C: attempts each agent-runnable check
```

The skill text, checked against `main` at `62e86111`:

| Where | What it says | Effect |
| --- | --- | --- |
| `plan-execute/SKILL.md`, "Not Tested" | Write each gap as an entry. "Never check an entry off yourself; the user confirms it by hand" | Nothing tells the agent to try a check before listing it |
| `plan-execute/references/validation-loop.md`, rubric item 4 | "Every `## Not tested` entry is a real gap: a check an agent can run is run, not listed" | Already the right rule, but it contradicts the line above, and the agent follows the explicit "never check off" |
| `plan-write/references/plan-schema.md`, "Not tested" | "Only the user clears an entry" | Same contradiction, in the schema every plan skill reads |
| `plan-review/SKILL.md`, step 3 | The Validator reports "`## Not tested` entries an agent could run instead" | Reported as a finding, not run |
| `plan-review/SKILL.md`, step 6 | The review packet lists "the manual checks that need the human, from `## Not tested`" | Every open entry reaches the user, runnable or not |
| `plan-close/SKILL.md`, step 5 | "Attempt each check the agent can perform", check off with recorded evidence | The only place that tries the checks, after approval and merge. It also contradicts "only the user clears" |
| `modules/plan-suite/review-freshness.mjs` | A review Result is incomplete while any entry is unchecked | Every entry must already be settled before approval, so close's attempt step can only run on an empty list |

The plan-document check reports open entries as `UNCONFIRMED_NOT_TESTED`, an advisory finding that the
submit transition, preflight, and `plans save` all tolerate. It does not look at what an entry
says. `docs/internal/plan-suite-deferred-topics.md` lists the gap under "Making execute prove
the work" and "Gates and lifecycle rules" (rows "Behavior checks", "QA script", and "Not tested
timing"); no plan owns it yet.

### Evidence from recent plans

- "Cut Claude permission prompts by running shell commands in the native sandbox" (`9njvfh5z`):
  review found that a `## Not tested` entry was checkable by the portal UI suite, and fixed it.
  Its three remaining entries were then run during review, at the user's request, and cleared
  with written evidence.
- "Clear agent friction" (`vzgsx5vz`): five Not tested entries kept the plan active because checks
  failed on sandbox write errors and missing dependencies. An agent later ran all of them once
  those were out of the way.

Both show agents can run most entries. In each case the user had to ask.

### Tooling limits that also push checks onto the user

Some handoffs come from tools, not instructions. Findings, each with its source:

| Limit | Evidence | Status |
| --- | --- | --- |
| The shell sandbox refuses local port binding and writes outside the checkout | `9njvfh5z` review: 15 gate checks failed inside the reviewing agent's sandbox on write errors, port binding, and `.git/worktrees`; the unsandboxed rerun passed | `9njvfh5z` keeps `allowLocalBinding: false`. Its decision log notes the app's preview tools run outside the shell sandbox. Whether `roborepo browser run --serve` can start a dev server inside the sandbox is not verified; see Open Questions |
| Plan-store commands cannot lock the store inside the sandbox | `9njvfh5z` current state: `roborepo plans show` reports "The plans worktree could not be locked" | Workaround is a sandbox-bypass rerun, which needs a permission prompt or auto-mode approval |
| The browser suites failed in a fresh worktree with no installed dependencies | `vzgsx5vz` verification: four suites failed with `ERR_MODULE_NOT_FOUND` until `npm ci` | Fixed on `main` by `c77b4649`, which installs dev dependencies on demand |
| Playwright may be missing | `feature-verification/SKILL.md`: a missing browser makes the run `blocked`, and installing it goes through a permission prompt | Unchanged; a declined prompt leaves the check blocked |

Today nothing distinguishes a check blocked by a tool from one only a person can make; both reach the user as
a manual check.

## Goals

- `/plan-execute` attempts every agent-runnable check before it submits, and records the result.
- Every open `## Not tested` entry says why an agent cannot clear it: a person-only reason, or the
  exact command a tool blocked.
- Every cleared entry carries its evidence, so a later reader can see who cleared it and how.
- The review asks the user only for person-only checks and blocked commands, each with steps and
  the expected result.
- An agent never confirms a person-only check, never records approval, and never clears an entry
  without recorded passing evidence.

## Non-goals

- How reports are worded and laid out. "Plan reports a reader can understand after time away"
  (`9671042v`) owns that; this plan changes what the agent does and records.
- Fixing the tooling limits above. They are recorded so the right plan can pick them up.
- Changing human approval, `roborepo plans approve`, or the `### Approval` record.
- Renaming `## Not tested` or splitting it into two sections.
- Measuring how often agents hand over runnable checks. "Live Evals for Skill Routing and Plan Closing" (`0jped168`), which runs real
  agents against fixtures, can do that
  later.

## Proposed design

### What happens after this plan

```mermaid
sequenceDiagram
  participant E as /plan-execute
  participant R as /plan-review
  participant U as User
  participant C as /plan-close
  E->>E: runs every agent-runnable check
  E->>E: records the evidence for each passing check
  E->>E: checks off each entry it recorded evidence for
  E->>E: leaves open only person-only or blocked entries, each with its reason
  E->>E: submits: refused while any open entry lacks a reason
  R->>R: runs any open entry whose reason does not hold
  R->>U: asks for person-only checks (steps, expected result, why) and blocked commands
  U->>R: reports each person-only result
  U->>R: approves the reviewed commit
  U->>U: merges the pull request
  U->>C: runs /plan-close
  C->>C: confirms no entry is open
```

### 1. One entry format

An open entry ends with one of two reasons. A cleared entry ends with its evidence after a ` — `
dash; this plan calls that text the entry's resolution, the same convention the `## Review`
findings already use.

```markdown
## Not tested

- [ ] The dark theme reads well on the Plans page. Needs a person: judging contrast and look is a
      human judgment.
- [ ] The portal starts and lists plans in a browser. Blocked: `roborepo browser run --serve "npm run
      portal"` failed with "listen EPERM 127.0.0.1:4310"; allow it to run outside the sandbox.
- [x] `roborepo plans submit` refuses an entry with no reason. — Verified by agent 2026-11-20 at
      a1b2c3d: `node scripts/test/plan-lifecycle-transitions-check.mjs` → passed.
- [x] The approval question names the commit. — Confirmed by the user 2026-11-21: "saw the full
      commit id in the question".
```

| Entry state | Must end with | Who may write it |
| --- | --- | --- |
| Open, person-only | `Needs a person: <why an agent cannot>` | Any agent |
| Open, blocked by a tool | `Blocked: <exact command> failed with <error>` and what would unblock it | Any agent |
| Cleared by an agent | `— Verified by agent <date> at <commit>: <command or method> → <result>` | An agent, only after the check passed |
| Cleared by the user | `— Confirmed by the user <date>: <what they reported>` | The user confirms; an agent only records it, quoting the user's explicit answer in chat |
| Removed | Deleted, with the reason in `## Decision Log` | Only on the user's decision, as today |

**Safety rules.** These hold for every agent and every plan command:

- An agent never checks off a person-only entry on its own judgment.
- An agent never clears an entry without a resolution that names the passing evidence.
- An agent records a user's confirmation only from the user's explicit answer, and never records
  human approval.

Accepted reasons for `Needs a person:` are: human judgment of look, feel, or wording; an account,
credential, or payment an agent must not use; a physical device; a third-party system the agent
cannot reach; an action the user's rules reserve to the user. "No time" and "no test exists" are
not reasons: an agent writes the test or runs the check.

### 2. `/plan-execute` runs the checks before it submits

Changes to `plan-execute/SKILL.md` and its references:

| Part | Change |
| --- | --- |
| "Not Tested" section | Replace "Never check an entry off yourself" with the table above: attempt each entry, using `feature-verification` for UI, server, API, CLI, or performance behavior; clear it with evidence when it passes; leave it open only with a reason |
| A failing check | A check that runs and fails is a defect: fix it, as with any failing test. It never becomes a Not tested entry |
| A blocked check | Retry through the harness's normal route first (a sandbox-bypass rerun goes through the permission prompt; the app's preview tools for a dev server). Only then write the `Blocked:` reason, and add the command to the questions `/plan-execute` already saves for the end of its run, so its final report asks the user to allow it |
| `references/validation-loop.md`, rubric item 4 | Keep "a check an agent can run is run, not listed". Add: each open entry's reason holds, and each cleared entry's evidence names a real command or method. A reason that does not hold is a `fix` finding |
| `references/final-report.md` | The manual-checks part lists only open entries, grouped as person-only and blocked, with the reason |

### 3. `/plan-review` runs what is left, and asks only for the rest

Changes to `plan-review/SKILL.md`:

| Step | Change |
| --- | --- |
| Step 3, Validator rubric | "Entries an agent could run instead" becomes: entries whose reason does not hold, and cleared entries without evidence |
| Step 5, fixes | Run each such entry here, as a `fix`, and clear it with evidence. Retry each `Blocked:` entry once, since review may run with different permissions |
| Step 6, review packet | "The manual checks that need the human" lists only person-only entries and blocked commands. Each person-only check gives the steps, the expected result, and the reason. Each blocked command gives the exact command to allow |
| Step 6a | Approval still needs every entry settled, as today. Add: the agent writes `— Confirmed by the user` only from the user's explicit answer, quoting it |

### 4. `/plan-close` stops discovering checks

`plan-close/SKILL.md` step 5 becomes a confirmation only: refuse while any entry is open and send
the user to `/plan-review`. Remove "Attempt each check the agent can perform". The review Result
already cannot be complete while an entry is open (`review-freshness.mjs`), so any entry close
finds open means approval was recorded outside the normal path; review is where it is settled.
`plan-close/references/verdict.md` follows.

### 5. The schema and the other writers say the same thing

| File | Change |
| --- | --- |
| `plan-write/references/plan-schema.md`, "Not tested" | Replace "Only the user clears an entry" with the entry-format table and the safety rules |
| `plan-write/SKILL.md`, the "Sync" row of its Create, Revise, or Sync table (syncing brings a plan up to date after work and adds `## Not tested` entries for gaps) | A sync adds entries with a reason |
| `globals/packages/session-close/skills/session-close/SKILL.md` | Entries it adds carry a reason |

### 6. The plan-document check enforces the format

One new finding in `modules/plan-suite/`, `NOT_TESTED_UNEXPLAINED`, computed for active and
review plans only, in `validateActive` in `lifecycle-policy.mjs` (which review reuses):

- an unchecked entry that contains neither `Needs a person:` nor `Blocked:`;
- a checked entry with no text after a ` — ` dash.

The check reads the whole entry, including its wrapped lines. Today the parser in `index.mjs`
keeps only an entry's first line as its text, so it must join the indented lines that follow.

The cleared-entry check accepts any resolution after the dash rather than the exact wording, so
entries written before this plan, such as those in `9njvfh5z`, stay valid. The skills prescribe
the wording; the check only confirms evidence exists.

| Where | Treatment | Why |
| --- | --- | --- |
| `roborepo plans validate`, `roborepo plans save` | Advisory, so neither refuses it | A plan mid-work may hold an entry not yet explained. `plans save` stops only on blocking findings, so it needs no change |
| Move into `active/` (start, reopen) | Tolerated, added beside `UNCONFIRMED_NOT_TESTED` in `transition.mjs` | Resuming work must not stall on it. Lifecycle moves check advisory findings too, so this entry is needed |
| `roborepo plans preflight` and the move into `review/` (submit) | Refused: not added to the tolerated sets in `review-gates.mjs` and `transition.mjs` | Submitting is the point where every entry must be run or explained |
| Review Result freshness (`review-freshness.mjs`) | Incomplete while present | Open entries already make the Result incomplete. The new case is a checked entry with no evidence: no approval over it |
| Completed plans and the move into `completed/` | Not computed | Close already refuses any open entry. Skipping the cleared-entry check keeps older completed plans valid, and freshness has already caught a cleared entry with no evidence before approval |

The plan-document check cannot tell whether a reason is true. Judging that stays with the Validator in
`/plan-execute` and `/plan-review`.

## Decisions

- **The plan-document check is in scope.** The right instruction already exists in the execute
  Validator's rubric ("run, not listed") and is ignored because other text contradicts it. A
  deterministic refusal at submit is what makes the agent stop and either run the check or write
  down why it cannot.
- **Reasons are a marker on each entry, not a second section.** A separate `## Manual checks`
  section would read clearly but needs a new parsed section, portal and docs changes, and a
  migration of the meaning of `## Not tested`. A marker reuses the existing parser.
- **Blocked is its own reason.** A check stopped by a tool is still agent-runnable. Labelling it
  person-only would ask the user to do the work; labelling it blocked asks only for permission.
- **Every entry is settled before approval, as the code already requires.** Close keeps only its
  refusal. A check that can only run after merge is either run from the worktree before approval,
  as `9njvfh5z` did, or moved to another plan by the user's decision.

## Implementation plan

- [ ] Rewrite `plan-write/references/plan-schema.md` "Not tested" with the entry format, the
      accepted reasons, and the safety rules, and correct its lifecycle paragraph: moves into
      `review/` tolerate open entries only when each carries a reason.
- [ ] Update `plan-execute/SKILL.md` "Not Tested" and its Implementation Completion lines on
      "unconfirmed Not tested entries" and "Genuinely unverified manual checks … resolved before
      `/plan-close`", so they say open entries must carry a reason and are settled in review;
      update `references/validation-loop.md` item 4 and `references/final-report.md`.
- [ ] Update `plan-review/SKILL.md` steps 3, 5, 6, and 6a.
- [ ] Reduce `plan-close/SKILL.md` step 5 and `references/verdict.md` to a confirmation. Align
      its refusal report (which quotes each open entry "so the user can confirm") and its
      Boundaries line on manual-only entries with the entry format: the refusal sends the user to
      `/plan-review`, and only person-only entries need the user.
- [ ] Add `NOT_TESTED_UNEXPLAINED`, and that submit refuses it, to the finding list in
      `plan-write/references/workflow-validate.md`.
- [ ] Update the "Sync" row in `plan-write/SKILL.md` and the Not tested line in `session-close`.
- [ ] Parse wrapped entry lines in `modules/plan-suite/index.mjs`; add `NOT_TESTED_UNEXPLAINED` to
      `findings.mjs` and `lifecycle-policy.mjs`; tolerate it for the `active` destination in
      `transition.mjs`; leave it out of the tolerated sets for preflight in `review-gates.mjs` and
      the `review` destination; mark freshness incomplete in `review-freshness.mjs`.
- [ ] Rewrite the resolution text of `UNCONFIRMED_NOT_TESTED` in `findings.mjs` ("Confirm each
      entry by hand and check it off") and the comment above `notTestedFindings` in
      `lifecycle-policy.mjs` ("until someone confirms it by hand") to match: run the check and
      record its evidence, or give the reason an agent cannot. In `review-gates.mjs`, rewrite the
      comment above the tolerated set ("/plan-close resolves it") and the preflight message "no
      findings apart from Not tested entries" to name the new rule.
- [ ] Update the pinned phrases in `scripts/test/plan-suite-skills-check.mjs` ("Never check an
      entry off yourself", "manual-only `## Not tested` entries") and pin the new ones.
- [ ] Update the docs under Documentation impact.

## Validation

New behavior, each case failing before the change:

- `node scripts/test/plan-suite-findings-check.mjs`: an unchecked entry with no reason yields
  `NOT_TESTED_UNEXPLAINED`; a checked entry with no resolution yields it; the parsed text of an
  entry includes its wrapped second line.
- `node scripts/test/plan-lifecycle-transitions-check.mjs`: submit refuses an active plan with an
  unexplained entry and accepts it once a reason is added; `plans preflight` fails on the entry
  and names it; a complete review Result whose only problem is a checked entry with no evidence
  reads `incomplete`.
- `plan-suite-findings-check.mjs`: the `UNCONFIRMED_NOT_TESTED` resolution no longer tells the
  reader to confirm every entry by hand.
- `node scripts/test/plan-suite-skills-check.mjs`: new pins for the entry format, the two reason
  markers, and review asking only for person-only checks and blocked commands.

Behavior that must not change, each case passing before and after:

- `plan-suite-findings-check.mjs`: entries with `Needs a person:` or `Blocked:`, and checked
  entries written like those in `9njvfh5z` (a resolution such as "— Done 2026-11-13; …"), yield
  no `NOT_TESTED_UNEXPLAINED`; a completed plan with a checked entry and no dash yields none.
- `plan-lifecycle-transitions-check.mjs`: start and reopen still succeed for a plan whose open
  entry has no reason, and `plans save` still accepts that plan.
- `bash scripts/doctor.sh --quiet` passes. CI runs the full gate, because skills are package
  outputs.

## Not tested

- [ ] On a real plan run, `/plan-execute` runs its runnable checks and the review asks the user
      only for person-only checks. Needs a person: only the user can judge whether the request
      they receive contains nothing an agent could have done; text pins cannot show an agent
      follows the procedure, and behavior evals (`0jped168`) do not exist yet.

## Documentation impact

| Doc | Update |
| --- | --- |
| `docs/user/guides/plan/lifecycle/plan-suite.md` | The "Not Tested" section (entry format, who clears what), the preflight list, the `/plan-review` packet's "manual checks waiting on you", and close step 4 |
| `docs/user/reference/plans-portal.md` | "Not Tested Entries" and the `plans preflight` row: the new finding and where it blocks |
| `docs/internal/plan-suite-deferred-topics.md` | Remove the rows this plan settles: "Behavior checks" and "QA script" under "Making execute prove the work", and "Not tested timing" under "Gates and lifecycle rules" |

## Related plans

| Plan | Relationship |
| --- | --- |
| Plan reports a reader can understand after time away (`9671042v`) | The wording side of the same review request. It reshapes the review packet into layers; this plan decides which checks belong in it. Both edit `plan-review/SKILL.md` step 6 and `plan-execute/references/final-report.md`. Recommended order: this plan first, so the report plan formats the final contents of "Needs you" once |
| Deliver finished plans as a watched pull request (`i5mnkm7z`) | Also edits `plan-execute` completion, `validation-loop.md`, `final-report.md`, and `plan-review` steps 5 and 6. Independent in behavior; whichever lands second merges the other's wording |
| Live Evals for Skill Routing and Plan Closing (`0jped168`) | Could later count entries cleared by an agent versus handed to the user, using the markers this plan adds |
| Cut Claude permission prompts by running shell commands in the native sandbox (`9njvfh5z`) | In review. Fewer prompts means fewer `Blocked:` entries. Its port-binding decision decides whether `roborepo browser --serve` works inside the sandbox |
| Clear agent friction (`vzgsx5vz`) | Merged 2026-11-13. This plan builds on the skill text as it is on `main` after it |

## Risks

| Risk | Mitigation |
| --- | --- |
| Agents write a plausible `Needs a person:` reason to pass the gate | The Validator in execute and review checks each reason holds; a false one is a `fix` finding and the entry is run |
| `/plan-execute` takes longer and spends more tokens running checks | The deferred-topics doc accepted this trade; the checks were going to run anyway, by the user or at close |
| An agent clears an entry on weak evidence | Evidence must name the command or method and its result, at a commit; review's Validator checks it |
| Plans already in active or review gain the finding | At the time of writing, only `9njvfh5z` is in review, and its entries are all cleared with a resolution |

## Open Questions

- **Can `roborepo browser run --serve` start a dev server inside the shell sandbox?** Unverified.
  If not, every UI check an agent runs from the shell becomes a `Blocked:` entry unless it uses the
  app's preview tools. `/plan-promote` should try it once and, if it fails, name the preview-tool
  route in the `/plan-execute` text.

- **Order against `9671042v`.** Both are ready to promote and edit the same review packet.
  Recommendation: this plan first, because it decides what the packet contains. The other order
  works too, at the cost of reworking "Needs you" twice.
