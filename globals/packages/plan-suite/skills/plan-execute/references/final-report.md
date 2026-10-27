# Final Report

Report:

```text
Implementation result
- Plan: "<title>" (<id>), <repository-relative path>
- Mode: start | resume | review findings
- Worktree: <runtime path>
- Worktree name: <Git administrative name recorded in the plan>
- Start transition: <commit on the base branch, "already recorded", or "not applicable">
- Start validator: APPROVED after <n> correction passes, refused with <checks>, or not applicable
- Branch: <branch>
- Base branch: <branch>
- Starting commit: <commit>
- Objectives completed: <count>
- Objectives blocked: <count>
- Findings fixed: <count, or "not applicable">
- Validation: clean on pass <n> | stopped at the cap with <count> open | in-session (no subagent interface)
- Base failures: <checks that fail on the base branch too, or "none">
- Material decisions: <count>
- Open questions: <count>
- Not tested entries: <count>
- Implementation commit: <commit and message, or "no implementation commit needed">
- Completion preflight: passed | failed with <checks> | not run
- Lifecycle: stays active | moved to review (<commit>) | stays review
- Docs updated: <list> | none needed (<reason>)
- Test/development environment: <what was started>
- Shareable link: <URL/link, or why none is available>
- Verification passed: yes/no/partial
- Implementation complete: yes/no
```

Also include:

- files changed;
- the Decision Log: each autonomous decision, alternatives, and reasoning;
- each Validation Loop pass's report, the clean one included;
- tests and checks run;
- manual verification;
- primary behavioral evidence and walkthrough, or why the feature-verification pairing did not apply;
- the `## Not tested` entries, each with what to check and why no test covers it;
- paired skills loaded, and any skipped with the reason;
- Open Questions, asked together as the run's only question batch: each with its options, pros and
  cons, recommendation, and the tasks it blocks;
- deferred scope;
- the plan validator's output for the worktree's copy of the plan;
- current Git status;
- whether anything was committed, pushed, merged, or published;
- the next command the user runs: `/plan-execute` again to resume, or `/plan-review`.

