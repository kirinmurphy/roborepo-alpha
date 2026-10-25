# Validation Loop

Implementation finishes with a loop of two roles, so the work reaches review already checked. The
agent that wrote the code shares its own blind spots, so the role that grades the work never writes
it, and it judges from the plan and the diff rather than from the implementer's account.

- **Implementer**: this session. Owns the code, the fixes, the commits, and the plan record.
- **Validator**: reads, runs read-only checks, and reports findings. It never edits a file,
  commits, or decides how a finding is fixed.

This file has two parts. **The loop** is how `/plan-execute` runs the Validator and acts on its
report. **The rubric** is what the Validator checks and how it classifies a finding; `/plan-review`
applies the same rubric in its own pass.

## Contents

- The loop
- The rubric

## The loop

### Running the Validator

Where the execution environment can launch a subagent, run each pass as a fresh subagent in the
target worktree, on the session's own model; never pass `isolation: "worktree"`. Give it only:

- the plan's path in the worktree;
- the base branch, so it reads the full diff with `git diff <base>...HEAD`;
- the repository's completion gate command and the output of its latest run;
- the paired skills this run loaded;
- the rubric below and its report format.

Do not give it a summary of what was built, why, or where to look. Without a subagent interface, run
the pass in this session as a separate read-only step that rereads the plan and the full diff from
disk, and record in the plan that the Validator ran in-session.

### Steps

1. **Validator pass.** The Validator applies the rubric to the current work and reports.
2. **Record.** Add each `fix` and `escalate` finding as an unchecked checkbox under `## Review` →
   `### Findings` in the worktree's copy of the plan, and each `base` result under
   `### Verification`.
3. **Fix.** Fix every `fix` finding, rerun the checks it affects, commit, and check the finding off
   with its commit: `- [x] Missing retry test — fixed (<short commit>)`. An `escalate` finding
   stays unchecked and gets an Open Questions entry under the Decision Policy.
4. **Repeat.** The next pass validates the revised work, not the previous report. A fix can
   introduce a new finding, which the next pass catches.
5. **Stop** when a pass reports no `fix` findings. Open `escalate` findings do not restart the loop;
   they wait for the user's answers.
6. **Cap at five passes.** If the fifth pass still reports `fix` findings, stop, leave them
   unchecked, and report them. Do not submit.

Show each pass's report in the run's output, a clean pass included.

### The record

```md
## Review

### Findings
- [x] Missing retry test for the timeout path — fixed (a1b2c3d)
- [ ] Retry limit: configurable or fixed? — escalated, see Open Questions

### Verification
- Validation: clean on pass 3 at d4e5f6a (fresh-context subagent)
- Base failure: `plan-suite-findings-check.mjs` fails on `main` too (unknown plan namespace)
```

Unchecked findings are open tasks, so the completion preflight refuses to submit while any remain.
`/plan-review` adds to this same record, and only `/plan-review` writes `### Approval`.

## The rubric

### Checklist

Each pass checks:

1. Every acceptance criterion against the code and the test evidence. A checked task is a claim,
   not evidence.
2. New and changed behavior has tests that assert observable outcomes.
3. The docs listed under `## Documentation impact`, and any the diff newly affects, describe the
   code as it now is.
4. Every `## Not tested` entry is a real gap: a check an agent can run is run, not listed.
5. Every gate failure, classified below.
6. The constraints of every loaded paired skill, where the diff falls under them.
7. **Flow and cohesion:** the main execution path of changed code can be followed, and
   responsibilities are divided at meaningful boundaries rather than by length.
8. **Data and state:** dependencies, side effects, and state transitions in changed code are
   explicit enough to trace and test.
9. **Comments and abstractions:** comments the diff adds or affects carry information the code
   cannot, and helpers and shared abstractions lower the cost of understanding the code rather than
   raise it.

Issues outside the diff that the plan did not cause are not findings. Mention them once as possible
follow-ups.

Checks 7 to 9 apply to changed and directly affected code, and use the same classes as every other
finding:

| What the check finds | Class |
| --- | --- |
| A hidden dependency, tangled responsibilities, or an unjustified abstraction with a concrete comprehension or reliability cost and a clear remedy | `fix` |
| The same, but the remedy chooses between real designs or reshapes an interface the plan did not specify | `escalate` |
| A comment that misstates behavior | `fix` |
| A comment the diff adds that only restates the code | `fix`: remove it |
| Harmless redundant narration that was already there, or any other cosmetic preference | Not a finding; at most one follow-up mention |
| A file judged by its length, or a request for more functions or files without an identified benefit | Never reported |

Each `fix` or `escalate` from these checks names its location, the concrete cost, and a
proportionate remedy; length alone is never a finding.

### Classifying a finding

Classify every finding by its consequence, not by the kind of change it needs:

| Class | When | What happens |
| --- | --- | --- |
| `fix` | The right fix is clear, stays within the plan's requirements and acceptance criteria, and changes no public interface or contract the plan did not already specify. Code, tests, docs, and evidence alike | Fixed in the same session |
| `escalate` | The fix chooses between real alternatives, changes requirements or acceptance criteria, changes a public interface or contract the plan did not specify, or lands outside the plan | Goes to the user as a decision |
| `base` | A gate failure the base branch has too: the failing check also fails on the base branch, or its failing input exists there | Recorded as verification; not a finding, not a blocker |

A one-line wording fix and a one-line logic fix are both `fix` when the right answer is obvious.
Size never decides the class.

### Report format

One line per finding:

```text
<class> — <file:line or plan section> — <what is wrong>
```

A pass with no findings says so and names what it checked. A silent pass is indistinguishable from
a skipped one.
