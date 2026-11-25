# Friction Reduction Ledger

## Purpose

This is the working record of one long-running effort: making the plan workflow smooth enough that
many plans run in parallel with few steps that need a person. The end state is an orchestrator agent
that picks the work and triggers every automated step, with the owner involved only where a
judgement call is needed. Security, performance, and validation stay in place throughout.

The page has two parts: a ranked list of the work still open, with the reason for each position, and
a dated record of what is finished.

Last reviewed: November 24, 2026, from the plan store and GitHub.

## How this page is kept

- The plan store (the `repo-plans` branch) is the source of truth for a plan's stage. This page is a
  reviewed summary of it and goes stale between reviews.
- On each review the store and GitHub are re-read, finished items move to
  [Completed](#completed), and the "Last reviewed" date changes.
- A plan joins the ranked list once it exists in the store. Ideas without a plan wait under
  [Under discussion](#under-discussion).
- Two plans build at the same time only when they edit different files. "Build after" in the list
  names a file collision, not a logical dependency, unless the row says otherwise.
- The store keeps its own order inside each group of plans (`roborepo plans order`). Where that
  order differs from this list, the row says so.

## Waiting on the owner

| Item | What is needed |
| --- | --- |
| 3. Bot account | Run the guided setup in your own terminal, then review and approve pull request 82 |
| 5. Small changes | Answer one open question: after the agent proposes "plan" or "no plan", does it proceed or wait for a yes |
| 7. Approval after clean merges | Two decisions, on merge readiness and on conflicted merges; the plan recommends an answer for each |

## Priority list

Ranked by how much each item removes a step that needs a person, then by what it unblocks.

| # | Plan | What the owner gets | Stage | Next step |
| --- | --- | --- | --- | --- |
| 1 | Deliver finished plans as a watched pull request (`i5mnkm7z`) | A built plan opens its pull request and keeps it passing unattended | Backlog | Prepare with `/plan-promote`; can start now |
| 2 | Session Titles Show the Workflow Stage (`gcfw77cq`) | Titles such as `/plan-execute: …`, so parallel sessions are easy to tell apart | Backlog | Two Claude hook trials, then prepare; can start now |
| 3 | GitHub agent identity (`w7vls1yk`) | GitHub itself refuses an agent's merge or push to `main` | In review, pull request 82 | Owner setup and approval |
| 4 | A current server is running whenever a plan is ready to review (`kqgr1d65`) | Every pull request for served changes comes with a running, current server and its address, without asking | Backlog | Prepare any time; build after items 1 and 3 and pull request 84 |
| 5 | Small changes are delivered from a worktree (`0ubk9sug`) | Work without a plan never moves the main checkout off `main`; a hook enforces it | Backlog | One open question, then prepare; build after item 3 |
| 6 | A plan's filename can be changed with one command (`iz3vuxyi`) | A plan's group or name is fixed without archiving and recreating it under a new id | Backlog | Prepare any time; build after item 3 |
| 7 | Approval survives clean merges of the base branch (`d9ywaa8d`) | No re-approving a plan because `main` moved and merged cleanly | Backlog | Refresh the plan and decide its questions; build after item 1 |
| 8 | Guided context compaction (`txhlglk`) | Long build sessions keep their thread when context is summarized | Backlog | Prepare any time; build after items 1 and 4 |
| 9 | Blockers and dependencies (`plan-lifecycle-suite-blockers-dependencies`) | Plans record what they wait on, so an orchestrator can pick unblocked work | Backlog | Split off the portal half and refresh |
| 10 | Agent behavior evals (`0jped168`) | Proof that a rule or skill change alters what agents do | Backlog | Prepare any time |
| 11 | PR autofix on any harness (`f0jwe76j`) | CI failures and review comments handled unattended, including replies on review threads | Backlog | Waits on item 3 merging |
| 12 | Session launching, milestone 1 (`plan-session-launching-milestone-1`) | Plans start their own sessions | Backlog | Needs a rewrite |

### Why each item sits where it does

1. **Watched pull request delivery.** The largest step toward unattended builds. Autofix (item 11)
   and approval freshness (item 7) both build on it. Everything that held it has merged. Its own
   `next_action` line is stale: it still names a plan closed on November 13.
2. **Session titles.** Removes confusion met every day while running sessions in parallel. It
   depends on nothing and names different files from item 1, so the two can build side by side.
3. **Agent identity.** Already built and passing its checks. Items 4, 5, 6, and 11 wait on it
   merging.
4. **Current server at review.** Removes a request made on nearly every plan: restart the server
   for this worktree. It edits the `/plan-execute` and `/plan-review` instructions and the final
   report that item 1 rewrites, portal start-up code and the permission manifest that item 3
   changes, and a state-path module that pull request 84 (multi-source packages, not on this list)
   changes, so it builds after all three. Its server step runs after the pull request step that
   item 1 defines. The store ranks it first in the `plans` group, above item 1; that order is fine
   for preparing, not for building.
5. **Small changes from a worktree.** A main checkout that stays on `main` is a precondition for
   parallel work. It edits the same push-guard hook as item 3, so it builds after.
6. **Plan rename command.** Small, with no open questions: a quick win. It shares plan-store code
   and the permission manifest with item 3, so it builds after. The store ranks it above item 1 in
   the `plans` group; here it sits below work that removes more steps.
7. **Approval survives clean merges.** Removes a repeated approval, but shares approval-checking
   code with item 1, and the plan text still describes plans living in the code checkout, which
   they left when the plan store moved to its own branch.
8. **Context compaction.** Small, but it rewrites the same `/plan-execute` instructions as items 1
   and 4.
9. **Blockers and dependencies.** The orchestrator needs this data. The plan must first be split
   from its portal half and brought up to date.
10. **Behavior evals.** Protects quality as automation grows. Mostly new files, so it rarely
    collides with other builds.
11. **PR autofix.** High value, but it cannot work until the bot account is live.
12. **Session launching.** The last piece of the orchestrator path, and its plan needs a rewrite.

## Under discussion

These have no ranked plan yet.

| Topic | State |
| --- | --- |
| Request a review the moment a pull request opens, through a provider layer (CodeRabbit first, with a retry when rate limited) | Design discussion started November 24, 2026. Expected to touch items 1 and 11 and the backlog plan "Wrap-Up Codex Invocation and CodeRabbit Integration" (`wrap-up-coderabbit-integration-plan`) |
| One computed "what is waiting on the owner" view across plans, as a command or a portal view | Suggested, not requested. The [Waiting on the owner](#waiting-on-the-owner) table is the hand-kept stand-in |
| Stage Titles for Codex and Gemini Sessions (`96r9wbj0`) | In the backlog, left unranked at the owner's request; follows item 2 |

## Completed

| Done | What | What the owner got | Pull request |
| --- | --- | --- | --- |
| Nov 13 | Clear agent friction (`vzgsx5vz`) | Fewer blocked commands | 63 |
| Nov 15 | Plan reports a reader can understand after time away (`9671042v`) | Reports lead with the outcome and stand alone | not re-checked |
| Nov 17 | Protect plans and main branches from one command (`3xh2sq32`) | One command guards `main` and the plan store on GitHub | 72 |
| Nov 18 | Agents run every check they can first (`5xw1mmqy`) | The owner reviews only what an agent cannot check | 74 |
| Nov 20 | Merge `main` into a plan's branch before handoff (no plan) | Pull requests arrive without conflicts | 75 |
| Nov 22 | Native sandbox for Claude shell commands (`9njvfh5z`) | Far fewer permission prompts | 66 |
| Nov 22 | Doctor warns when installed config is behind (no plan) | The owner is told when to run `roborepo update` | 77 |
| Nov 22 | Base-failure rule tightened (no plan) | A failing check counts as already broken only when it fails on `main` too | 79 |
| Nov 23 | Two places for temporary files (`gy8ncs9u`) | Agent and test leftovers get one home and automatic cleanup | 78, 80 |
| Nov 23 | Skills declare which skills they need (`ejsc769o`) | Shared instructions live in one skill; this cleared the hold on item 1 | 76 |
| Nov 23 | A merged branch stays closable (no plan) | A plan can be closed after `main` is merged back into its branch | 83 |

Rows dated November 22 and 23 were read from GitHub and the plan store on November 24. Earlier rows
come from hand-over notes; the November 15 row's date and pull request were not re-checked.
