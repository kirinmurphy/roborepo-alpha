---
name: implementation-review
description: "Use when a lifecycle workflow (/plan-execute, /plan-review, /plan-close, or /session-close) reviews implementation quality: it supplies the scope and requirements, and this skill supplies the review rubric, risk checkpoints, severities, finding classes, and report format. Do not use for drafting code, reviewing prose-only documents, choosing tests (test-harness), or ad hoc review requests outside those workflows."
---

# Implementation Review

The one review rubric that `/plan-execute`, `/plan-review`, `/plan-close`, and `/session-close` use.
The caller owns the loop: who reviews, how many passes run, where findings are recorded, and what a
finding blocks. This skill owns what a pass checks and how it reports.

## Contents

- Inputs from the caller
- Paired Skills
- Checklist
- Convention checks
- Risk checkpoints
- Severity and class
- Report format

## Inputs from the caller

| Input | Example |
| --- | --- |
| Scope | A plan's implementation (`git diff <base>...HEAD`), or the files a session edited |
| Requirements | A plan's acceptance criteria and `## Documentation impact`; for a session, what the user asked for |
| Gate evidence | CI's result for the head commit, or the affected checks' commands and output |
| Loaded paired skills | The caller's paired skills that applied to this work |

Judge from the scope, the requirements, and the evidence, never from the author's account of the
work. A checked task is a claim, not evidence.

## Paired Skills

Load these when the scope calls for them; do not wait to be asked for them by name.

| Skill | Relationship | Load when | Contributes |
| --- | --- | --- | --- |
| `code-style` | recommends | The scope places code: module boundaries, orchestration vs. execution, reuse | Ownership and layering constraints the convention checks apply |
| `javascript-typescript` | recommends | The scope changes JS/TS — ESM, exports, types, framework-less DOM | Language and markup conventions |

## Checklist

Each pass checks:

1. Every requirement against the code and the test evidence.
2. New and changed behavior has tests that assert observable outcomes.
3. The docs the caller names, and any the change newly affects, describe the code as it now is.
4. When the caller tracks untested gaps (a plan's `## Not tested`), every entry is a real gap: a
   check an agent can run is run, not listed. Each open entry's `Needs a person:` or `Blocked:`
   reason holds, and each cleared entry's evidence names a real command or method and its result. A
   reason that does not hold is a `fix` finding: the implementer runs the check. A cleared entry
   without real evidence is a `fix` finding too.
5. Every gate failure, classified below.
6. The constraints of every loaded paired skill, where the change falls under them.
7. Functionality gaps: required behavior that is missing, half-wired, or unreachable.
8. Naming and intuitiveness: names say what a thing owns or does, and a reader can predict
   behavior from them.
9. Project-pattern conformance: the change follows the repository's existing conventions for the
   same kind of code, or says why it departs.
10. The convention checks and risk checkpoints below.

Issues the work under review did not cause are not findings, whether they sit outside the scope or in
general lifecycle, tooling, or environment behavior. List each once under `Outside this scope` in the
report, without a severity or class.

## Convention checks

Three checks apply to changed and directly affected code:

- **Flow and cohesion:** the main execution path of changed code can be followed, and
  responsibilities are divided at meaningful boundaries rather than by length.
- **Data and state:** dependencies, side effects, and state transitions in changed code are
  explicit enough to trace and test.
- **Comments and abstractions:** comments the change adds or affects carry information the code
  cannot, and helpers and shared abstractions lower the cost of understanding the code rather than
  raise it.

They use the same classes as every other finding:

| What the check finds | Class |
| --- | --- |
| A hidden dependency, tangled responsibilities, or an unjustified abstraction with a concrete comprehension or reliability cost and a clear remedy | `fix` |
| The same, but the remedy chooses between real designs or reshapes an interface the requirements did not specify | `escalate` |
| A comment that misstates behavior | `fix` |
| A comment the diff adds that only restates the code | `fix`: remove it |
| Harmless redundant narration that was already there, or any other cosmetic preference | Not a finding; at most one follow-up mention |
| A file judged by its length, or a request for more functions or files without an identified benefit | Never reported |

Each finding from these checks names its location, the concrete cost, and a proportionate remedy;
length alone is never a finding.

## Risk checkpoints

Take extra care, and name what to double-check, when the scope touches:

- authentication;
- authorization, ownership, and admin;
- database schema and migrations;
- API behavior and mutations;
- environment variables and deployment config;
- file uploads and storage;
- external integrations.

A pass that touched a checkpoint says which one and what it checked, even when it found nothing.

## Severity and class

Severity says how much a finding matters; class says who resolves it.

| Severity | Meaning | Blocks a clean pass? |
| --- | --- | --- |
| `blocking` | Incorrect, missing, or unsafe required behavior, or a project-invariant violation | Yes |
| `actionable` | A concrete quality issue worth fixing before the work is clean | Yes |
| `note` | Low-risk or optional | No |

| Class | When | What happens |
| --- | --- | --- |
| `fix` | The right fix is clear, stays within the caller's scope and requirements, and changes no public interface or contract the requirements did not already specify. Code, tests, docs, and evidence alike | The caller fixes it |
| `escalate` | The fix chooses between real alternatives, changes requirements or acceptance criteria, changes a public interface or contract the requirements did not specify, or lands outside the scope | Goes to the user as a decision |
| `base` | A gate failure the base branch has too: the same check fails on the base branch, shown by the base branch's CI result for the base commit or by rerunning the check there. An input that merely exists on base is not evidence | Recorded as verification; not a finding, not a blocker |

Classify by consequence, not by the kind of change a finding needs. A real alternative has a
compelling argument for choosing it. When one option clearly wins and the others exist only on paper,
the fix is clear: class it `fix`, not `escalate`. A one-line wording fix and a one-line logic fix are
both `fix` when the right answer is obvious. Size never decides the class.

## Report format

Every finding names its location, the violated rule, the fix, and the risk, one line each:

```text
<severity> <class> — <file:line or requirement> — <rule violated>: <what is wrong>. Fix: <remedy>. Risk: <what breaks if it stays>.
```

Generic cleanup advice is not a finding. After the findings, add the `Outside this scope` list when
there is one, then the risk checkpoints the scope touched.

A pass with no findings says so and names what it checked. A silent pass is indistinguishable from
a skipped one.
