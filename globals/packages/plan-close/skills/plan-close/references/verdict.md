# Verdict

The verdict is the decision every other step of `/plan-close` serves. Decide it from evidence:
the test result, the plan's claims checked against the code, and the repository's plan validator.

| Verdict | When | Action |
| --- | --- | --- |
| Complete | Every success criterion is met, every required task is done in the code, and tests pass | Continue to the Not tested, approval, and landed checks; close only if all pass |
| Incomplete | Required work remains, or a checked item is not implemented, after agent-resolvable repairs | Refuse. Untick false claims, list the remaining tasks, set `next_action`, leave the plan in `review/` |
| Blocked | Remaining work waits on a user decision, manual confirmation, or external dependency | Refuse. Record the blocker in `blocked_by` or the plan's Open Questions, leave the plan in `review/` |
| Superseded | Another plan now owns the work | Stop. Name the plan that supersedes it and direct the user to `/plan-archive` |
| Abandoned | The work will not be done | Stop. Name the reason and direct the user to `/plan-archive` |

Rules:

1. Read the complete plan before deciding.
2. Identify the success criteria; a plan without any cannot be complete, so treat it as incomplete
   and say the criteria are missing.
3. Checkboxes are claims, not evidence. Fix in-scope gaps the agent can resolve, including missing
   tests, then rerun verification. A checked task with no implementation makes the plan incomplete
   only if the gap remains; an unchecked task that quietly landed is reported and ticked.
4. A deferred item counts as resolved only when the plan states the deferral and its reason.
5. Archived means not completed. Never send finished work to `/plan-archive` to avoid the
   completion checks.
6. Report the evidence for the verdict and the lifecycle transition, if any.
