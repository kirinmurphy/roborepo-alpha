## Code Outlives Plans

Code must make sense without any plan document. In comments, test names, and error messages, never
cite a plan file, plan id, phase, milestone, or plan decision — no "see docs/plans/…", "Phase 4",
or "per the plan". Plans are renamed, rescoped, and closed; the citation goes stale while the code
stays.

When a comment needs a reason, write the reason itself. Track progress in the plan, not in code.

A path the code actually reads, writes, or serves is behavior, not a citation, and stays.
