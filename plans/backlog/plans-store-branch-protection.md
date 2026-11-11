---
id: 3xh2sq32
next_action: Run /plan-promote to confirm the GitHub endpoints against the live repo and settle the open questions
blocked_by: []
depends_on: []
related: ["w7vls1yk", "developer-runtime-remote-branch-status"]
reviewed_commit:
worktree:
---

# Protect the plans branch on GitHub from one command

## Summary

Every repo that uses the plans store keeps its plans on a `repo-plans` branch that RoboRepo pushes
to directly. On GitHub, that branch should carry a ruleset that blocks deletion, force pushes, and
merge commits while still allowing direct pushes. Today the user has to remember to add that ruleset
by hand for each repo. This plan adds `roborepo plans protect`, which reports or creates the
ruleset; `/plan-suite-init` offers it after setting up a store; and the Plans page shows a
**Protect** button only while GitHub reports the branch unprotected.

## Context

### Why the branch needs protection

The plans store is the only copy of a repo's plans. Each store command commits locally and pushes
`repo-plans` to `origin` (`modules/plan-suite/plan-store.mjs`). Locally, the store integrates remote
changes only by fast-forward (`merge --ff-only`) or by rebasing pending commits, and it never
force-pushes. So the remote branch's history only ever grows in a straight line, and three rules
can hold it to that without slowing any save:

| Rule (GitHub ruleset type) | Stops |
| --- | --- |
| Restrict deletions (`deletion`) | The branch, and with it every plan, being deleted |
| Block force pushes (`non_fast_forward`) | Plan history being rewritten |
| Require linear history (`required_linear_history`) | A merge commit, such as `main` merged into the branch |

Rules that refuse a direct push would break every save, which would then report
`synchronized: false` until the rule is removed: a required pull request (`pull_request`),
required status checks (`required_status_checks`), and restricted updates (`update`).

### Current state

- `docs/user/guides/plan/lifecycle/plan-suite.md`, section "Protect the plans branch", tells the
  user to add a rule disallowing force pushes and deletion. It does not mention linear history, and
  nothing checks whether the rule exists.
- `/plan-suite-init` (`globals/packages/plan-suite/skills/plan-suite-init/SKILL.md`) runs
  `roborepo plans init`, sets namespaces, and reports. It says nothing about branch rules.
- `roborepo plans` (`scripts/cli/plans-command.mjs`) has no protection command.
- The Plans page lists repo-level warnings in `renderWarnings` (`portal/plans/app.js`), such as a
  repo whose plans are not set up. Nothing there covers branch rules.
- No RoboRepo code runs `gh` today. The GitHub integration series plans one home for it:
  "GitHub Integration Part 01" (`w7vls1yk`) introduces `modules/forge/` with a `github.mjs`, and
  states that nothing outside that module runs `gh`.
- A repo's canonical id names its host: `git:github.com/<owner>/<repo>`.
  `providerUrlForRepositoryId` in `modules/repositories/identity.mjs` already parses it.

## Goals

- One command reports whether `repo-plans` is protected, and creates the protection when it is not.
- Running the command again changes nothing.
- A new store is offered protection at the end of `/plan-suite-init`.
- The Plans page shows a **Protect** button only while GitHub reports protection missing, and the
  button disappears once the rules apply, however they got there.
- A repo on another host gets the manual steps instead of an error.

## Non-goals

- Creating or editing rules on any other branch, or editing an existing ruleset.
- Support for hosts other than GitHub beyond printing manual steps.
- Changing which identity agents use on GitHub; Part 01 (`w7vls1yk`) owns that.
- Running protection automatically inside `roborepo plans init`, which must keep working without
  `gh`.

## Proposed design

### Status comes from GitHub, never from a local flag

The command and the button read the rules that currently apply to the branch, from GitHub's
effective-rules endpoint, `GET /repos/{owner}/{repo}/rules/branches/repo-plans`. It returns every
active rule from every ruleset that targets the branch, and it needs only read access. A rule
removed on GitHub therefore brings the button back, and protection added by hand hides it.

| State | Condition | `plans protect --check` | Plans page |
| --- | --- | --- | --- |
| `protected` | All three rules apply and no push-blocking rule does | Reports it; exit 0 | Nothing |
| `missing` | One or more of the three rules is absent | Lists the absent rules; exit 1 | Warning line with **Protect** |
| `conflicting` | A rule that refuses direct pushes applies (`pull_request`, `required_status_checks`, `update`) | Names the rule and its ruleset; exit 1 | Warning line naming it, no button |
| `unavailable` | `gh` missing, not signed in, or GitHub unreachable | Gives the reason; exit 1 | Warning line with the reason and the CLI command, no button |
| `unsupported` | The remote is not GitHub | Prints the manual steps; exit 1 | Nothing |

### The command

```text
roborepo plans protect [--check] [--json]
```

- `--check` reads the state and changes nothing. Exit 0 for `protected`, 1 otherwise.
- Without `--check`, a `missing` state creates one ruleset named `repo-plans`, targeting only
  `refs/heads/repo-plans`, with exactly the three rules and no bypass list, through
  `POST /repos/{owner}/{repo}/rulesets`. The command then reads the state again and reports it.
- Every other state is reported and nothing is written. If a ruleset named `repo-plans` already
  exists but its rules are incomplete, the command refuses and names it, rather than edit a ruleset
  someone else may have changed.
- Creating a ruleset needs repo admin. Without it GitHub refuses, and the command says to run it
  from an account with admin rights.

```mermaid
flowchart TD
  A[plans protect] --> B{remote is GitHub?}
  B -- no --> U[unsupported: print manual steps]
  B -- yes --> C[read effective rules for repo-plans]
  C --> D{state}
  D -- protected --> P[report, exit 0]
  D -- conflicting / unavailable --> R[report reason, exit 1]
  D -- missing --> E{--check?}
  E -- yes --> M[report missing rules, exit 1]
  E -- no --> F[create ruleset repo-plans] --> C
```

### Where the code goes

| Piece | Location | Owns |
| --- | --- | --- |
| GitHub calls | `modules/forge/github.mjs` | Running `gh api`, reading effective branch rules, creating a ruleset. The one place RoboRepo runs `gh`, matching Part 01's design |
| Protection policy | `modules/plan-suite/store-protection.mjs` | The three required rules, the push-blocking rule list, mapping effective rules to a state, and the create-then-recheck flow |
| CLI | `scripts/cli/plans-command.mjs` | Parsing `protect`, printing, exit codes |
| Portal API | `scripts/cli/portal-routes-plans.mjs` | `GET /api/plans/protection?repositoryId=` and `POST /api/plans/protection` |
| Plans page | `portal/plans/app.js`, `portal/plans/templates.js` | The warning line and button |

Whichever of this plan and Part 01 lands first creates `modules/forge/github.mjs`; the second adds to
it. The policy stays in `plan-suite` because only the plans store needs these rules.

### The Plans page

The page asks for protection status separately from the plan snapshot, once per scanned GitHub repo,
when it loads and on **Refresh**, so a slow GitHub call never delays the plan list. The server does
not cache the answer. Clicking **Protect** calls the POST route, which runs the same flow as the
command, then the line rerenders from the returned state. Copy follows the repo naming rule: "Repo",
never "repository".

### `/plan-suite-init`

After the store exists, the skill runs `roborepo plans protect --check --json`. For `missing` it
asks the user whether to protect the branch now and runs `roborepo plans protect` on a yes. Every
other state goes into its report with the command's reason.

## Implementation plan

- [ ] Add `modules/forge/github.mjs` with effective-branch-rules and create-ruleset calls through
      `gh api`, or extend it if Part 01 has already added it.
- [ ] Add `modules/plan-suite/store-protection.mjs` with the state mapping and the
      create-then-recheck flow.
- [ ] Add `roborepo plans protect [--check] [--json]` to `scripts/cli/plans-command.mjs` and its
      usage text.
- [ ] Add the two portal routes and the Plans page warning line with its **Protect** button.
- [ ] Add the check-and-offer step to `/plan-suite-init`.
- [ ] Add `scripts/test/plans-protect-check.mjs` to the CI group in `scripts/test/check-groups.json`.
- [ ] Add a portal UI spec for the button.
- [ ] Update the docs listed under Documentation impact.

## Validation

Automated, with a fake `gh` executable placed first on `PATH`. It answers from a JSON state file and
records each request:

- `scripts/test/plans-protect-check.mjs`:
  - each of the five states maps to the documented output and exit code, for `--check` and
    `--json`;
  - `protect` on `missing` sends one create request with the exact ruleset body: the name, the
    target `refs/heads/repo-plans`, the three rules, and no bypass actors;
  - a second `protect` sends no create request;
  - an admin refusal from the fake `gh` is reported with the admin message, and nothing else is
    written;
  - a non-GitHub `origin` prints the manual steps and never calls `gh`.
- A portal UI spec, with the fake `gh` on the test server's `PATH`:
  - the warning line and **Protect** button appear for `missing`;
  - clicking the button removes them;
  - neither appears for `protected`.
- `node scripts/test/docs-reference-check.mjs` passes.

Manual, on a scratch GitHub repo where the user is admin:

| Check | Expected |
| --- | --- |
| `roborepo plans protect --check` before protecting | `missing`, listing all three rules |
| `roborepo plans protect`, then view the repo's rulesets on GitHub | One ruleset, `repo-plans`, with the three rules |
| `roborepo plans save` on a plan afterward | `synchronized: true` |
| `git push --force` to `repo-plans`, and `git push origin --delete repo-plans` | GitHub rejects both |
| Delete the ruleset on GitHub, then press **Refresh** on the Plans page | The **Protect** button returns |

## Risks

| Risk | Mitigation |
| --- | --- |
| The command runs `gh` with whatever token `gh` holds, so an agent that runs it acts as the user | It only reads branch rules or creates this one fixed protective ruleset; it never edits or deletes a ruleset |
| Under the agent identity from Part 01 (`w7vls1yk`), the bot has no admin rights | Creation is refused with the admin message; the check still works, since it needs only read access |
| The effective-rules endpoint omits legacy branch protection | A legacy rule alone reads as `missing`; the created ruleset then duplicates it, which is harmless |
| A wildcard ruleset elsewhere adds a push-blocking rule to `repo-plans` | Reported as `conflicting`, naming the ruleset, before saves start failing |

## Open questions

- Should the Plans page also show the warning for a repo the user is not admin of, or hide it when
  GitHub reports the user cannot administer the repo? The design above shows it, with the admin
  message on click.
- Should `plans protect` also run from `roborepo doctor` for each repo with a store? Part 01 adds a
  doctor check for GitHub setup; one doctor line here would surface an unprotected branch without
  opening the Plans page.

## Documentation impact

| Doc | Update |
| --- | --- |
| `docs/user/reference/roborepo-cli.md` | Add `plans protect`, its states, and exit codes |
| `docs/user/guides/plan/lifecycle/plan-suite.md` | Replace the manual "Protect the plans branch" steps with the command; add linear history; keep the manual steps for other hosts |
| `docs/user/reference/plans-portal.md` | Add the protection warning line and button, and the two routes |
| `globals/packages/plan-suite/skills/plan-suite-init/SKILL.md` | Add the check-and-offer step and its report lines |
