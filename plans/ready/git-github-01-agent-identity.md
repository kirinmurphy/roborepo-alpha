---
id: w7vls1yk
next_action: After `roborepo protect` (3xh2sq32) lands, the owner creates the bot account and classic token (Phase 2); then run the checks that need them, including the Codex sandbox checks
blocked_by: []
depends_on: ["3xh2sq32"]
related: ["f0jwe76j", "permva27", "developer-runtime-remote-branch-status", "4zyo2woj", "8bjltk2n", "vzgsx5vz", "i5mnkm7z", "pvgx8oh7", "git-exec-consolidation"]
reviewed_commit: 62e86111d947f66b6ce61f991cf152d90c13b8a1
worktree:
---

# GitHub Integration Part 01: Agents Act on GitHub Under Their Own Identity

## Summary

Agent shells (Claude, Codex, and Gemini once it can take env) should talk to GitHub as a separate
bot account, not as the user. The bot is a plain collaborator, so it is not on the ruleset bypass
list and has no admin rights. That means GitHub rejects an agent push to `main` and an agent merge
without a human approval, no matter what the local hooks miss. With GitHub enforcing that, `gh api`
can come off the agent deny list, and agents can read review threads and their resolved state,
reply to them, resolve them, and comment on pull requests without a prompt.

The user's own terminal stays on the user's identity, and the user's admin bypass keeps working for
the user's own direct pushes.

The identity also has to work inside Codex's sandbox, where agents cannot reach GitHub today. With
the identity on, Claude and Codex both push feature branches, open pull requests, and save plans
without a prompt, and Codex does so without leaving its sandbox. Until then, plan delivery
(`i5mnkm7z`) under Codex stops at the push and reports the command for the user to run.

Turning the identity on is a guided setup. Right after a user sets up the plan suite in a repo,
RoboRepo offers it. The setup walks the user through the steps only a person can do, checks the
result, and turns the identity on at the end. A user who declines keeps today's behavior.

**Recommendation:** a bot user with a classic personal access token, stored by `gh` in the OS
keychain. Agent shells reach it through a non-secret `GH_CONFIG_DIR` setting. An optional package
is the on/off switch. A fine-grained token is not an option for this repo (see Context).

## Goals

- Claude and Codex push feature branches and open pull requests as the bot without a prompt. Codex
  does this from inside its sandbox, with no escalation.
- An agent push to `main` is rejected by GitHub, not only by local hooks.
- An agent cannot merge its own pull request into `main` without a human's approval.
- An agent cannot change rulesets, branch protection, or repo settings, whatever token it holds.
- `gh api` is allowed for agents running as the bot, so they can read review threads and their
  `isResolved` state, reply to threads, and resolve them.
- Agents running as the bot comment on and review pull requests and create issues without a prompt.
- A plan save or lifecycle move from Codex reaches `origin/repo-plans` from inside the sandbox.
- The user's terminal, `gh`, and SSH pushes keep the user's identity and admin bypass.
- No token value appears in a tracked file, a generated file, a rendered config, or an agent
  transcript.
- A user turns the identity on through one guided setup, offered when they set up the plan suite,
  without reading separate docs first.
- GitHub-specific pieces sit in one place that is tagged as belonging to the GitHub host.

## Non-goals

- A full forge adapter (`roborepo pr …` commands, GitLab or Bitbucket providers). See
  [Future work](#future-work).
- Moving the repo into a GitHub organization.
- Stopping an agent that deliberately goes around the setup, for example by using the user's SSH
  key directly. See Risks.
- Creating the bot account or token for the user. GitHub requires a person for both; the guided
  setup tells the user what to do, waits, and checks the result.
- A portal version of the guided setup. See Future work.
- No-prompt Codex pushes with the identity off. Only the bot's collaborator role lets GitHub reject
  a push to `main`, so an install without the bot keeps Codex's network closed.

## Context

### Why the local guards are the only guard today

The repo is `kirinmurphy/roborepo-alpha`, a public repo owned by a personal account. It has two
rulesets on the default branch. Checked with `gh ruleset view` on 2026-10-30:

| Ruleset | Rules | Bypass |
| --- | --- | --- |
| `protect-main` | `deletion`, `non_fast_forward` | None. "This ruleset cannot be bypassed" |
| `no-push-to-main` | `pull_request` with `required_approving_review_count: 0`, `require_last_push_approval: false` | Repository admin role, mode `always` |

Since that check, the owner raised `no-push-to-main` to 1 required approval so an agent cannot
merge its own pull request, and bypasses it until the bot exists. "Protect a repo's plans and main
branches on GitHub from one command" (`3xh2sq32`) adds RoboRepo-managed rulesets that keep the
1 approval and admin bypass, add the three required CI checks, and protect `repo-plans`. The owner
then deletes the hand-made rulesets the managed ones cover. This plan depends on that one: the bot
gets push rights only after `repo-plans` is protected from deletion and force pushes. Reread the
rulesets before changing them.

The user is the admin and keeps the bypass for their own direct pushes. Agents run with the user's
credentials: `gh auth status` shows the user's OAuth token, with `repo` and `workflow` scopes, in
the keyring. The `origin` remote uses SSH with the user's key. To GitHub, an agent is the admin. So
these local guards are all that stops an agent push to `main`:

| Guard | Where | Source |
| --- | --- | --- |
| Push hook (PreToolUse) | Claude and Codex | `globals/system/hooks/claude/protected-branch-push.mjs`, `globals/harnesses/codex/hooks/protected-branch-push.mjs` |
| `pre-push` backstop | Agent shells, through `core.hooksPath` | `globals/system/git-hooks/` |
| `gh` deny list | Manifest rules plus the hook's `GH_DENIED` | `manifests/inventory/agent-permissions.json` (`change-github-directly`) |

`gh api` is denied because it can do anything the token can, including moving `main`, and the
hook cannot tell a read from a write. The cost: agents cannot read inline review threads or their
resolution state. `gh pr view --comments` shows comment text but not thread state. Posting
commands (`post-to-github`: `gh pr comment`, `pr review`, `issue create`, and others) are at `ask`
because they speak as the user.

### How agent-only settings reach agent shells today

`core.hooksPath` reaches only agent shells through `GIT_CONFIG_*` variables in config that only
the harness reads:

| Harness | Where | Rendered source (tracked) |
| --- | --- | --- |
| Claude | `env` in `~/.claude/settings.json` | `generated/claude/settings.json` |
| Codex | `[shell_environment_policy.set]` in `~/.codex/config.toml` | `generated/codex/config.toml` |
| Gemini | None today | — |

Both rendered files are tracked in the repo and copied into place by the install step. Anything
placed in them is effectively public. The token itself can never go there.

Optional packages can also change harness config. A package's `config-patch` resource lists `set`
or `union` patches on key paths in a harness's root config, applied at install and reverted when
the package is turned off (`globals/packages/usage-statusline/package.config.json` sets a Claude
`env` key this way). `${package-runtime:<name>}` expands to an installed asset's absolute path.
Validation lets only one package own each `set` path.

### Why Codex cannot reach GitHub from its sandbox today

Codex runs shell commands in the `managed-workspace` sandbox profile. `generated/codex/config.toml`
renders that profile with `network.enabled = false` and a `~/.ssh/**` deny, both from the credential
protection plan ([[4zyo2woj]]), which recorded the choice to keep host networking restricted. The
roborepo push hooks allow a feature-branch push, and the sandbox then stops it.

Each row below is a `codex exec` run on 2026-11-05 with `codex-cli` 0.166.0, using
`git push --dry-run origin HEAD:refs/heads/<throwaway>`. The overrides applied to that run only:

| Override | Result | What stopped it |
| --- | --- | --- |
| None | `Could not resolve hostname github.com` | Network disabled |
| `network.enabled=true` | `Network access to "github.com" was blocked: domain is not on the allowlist` | The domain allowlist, which holds only `localhost` and `127.0.0.1` |
| Also `network.domains={"github.com"="allow"}` | `hostkeys_find_by_key_hostfile: ... known_hosts: Operation not permitted` | The `~/.ssh/**` deny, reached because `origin` uses SSH |

During the second run, the hook also refused `git push --dry-run origin HEAD:main`, so the local
guard on `main` works under `codex exec`.

The third run stopped at SSH, so anything past that point is untested. `features.network_proxy` and
the domain allowlist exist in the live `~/.codex/config.toml` but are not in the generated file.

Two hooks answer differently for a feature-branch push: `permission-check.mjs` says `ask` and
`protected-branch-push.mjs` says `allow`. Part 02 ([[f0jwe76j]]) records that Codex has no
per-command ask tier, so a command the sandbox allows just runs. That matches the runs above, which
all started with no prompt under `codex exec`. An interactive session is unchecked.

### RoboRepo code that talks to GitHub today

| Caller | What it runs | Identity settings it sees |
| --- | --- | --- |
| Plan store, `modules/plan-suite/plan-store.mjs` | `git fetch` (in `fetchInto` and `fetchRemote`) and `git push` of `repo-plans` | None: `gitEnvironment` in `modules/repositories/git-exec.mjs` strips `GIT_CONFIG_COUNT` |
| Delivery commands, `modules/delivery/operations.mjs` | `gh` for PR body, ready, and CI rerun; `git fetch` for `roborepo delivery fetch` | `gh` inherits the full environment, so it would act as the bot. The fetch goes through the same stripping wrapper |

Agents may run `roborepo delivery …` and `roborepo plans …` (both in `allow`). So with the identity
on, both callers run inside agent shells and need it.

### GitHub facts this design rests on

| Fact | Status | Source |
| --- | --- | --- |
| Ruleset bypass lists name roles, teams, and GitHub Apps; actors not on the list are bound by the rules | Verified | [Creating rulesets for a repository](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository) |
| A collaborator on a personal-account repo can push and merge PRs, but cannot change settings; only the owner can | Verified. The page does not mention rulesets by name | [Permission levels for a personal account repository](https://docs.github.com/en/account-and-profile/reference/permission-levels-for-a-personal-account-repository) |
| Personal-account repos have one collaborator role (write). There is no read-only or triage role | Verified | Same page |
| Creating or updating rulesets and branch protection needs the **Administration** permission | Verified | [Permissions for fine-grained tokens](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens) |
| Listing review comments needs **Pull requests** read; replying needs **Pull requests** write | Verified | Same page |
| **Fine-grained tokens cannot contribute to repos where the user is an outside or repository collaborator** | Verified as a listed limitation | [Managing your personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) |
| Classic tokens work for a collaborator on a personal-account repo | **Unverified.** The page says so only for organization repos. Phase 2 checks it | Same page |
| GitHub App installation tokens last one hour, are minted from a JWT signed by the App's private key, and can be narrowed to repos and permissions | Verified | [Generating an installation access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app) |
| "Require approval of the most recent reviewable push" requires approval from someone other than the last pusher | Verified | [Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets) |
| GraphQL `PullRequestReviewThread.isResolved`, `viewerCanResolve`, and `addPullRequestReviewThreadReply` exist | Verified | [GraphQL pulls reference](https://docs.github.com/en/graphql/reference/pulls) |
| Which permission `resolveReviewThread` needs | **Not stated.** The mutation reference lists its inputs (`threadId`) but no permission. Phase 2 tests it with the bot | [GraphQL pulls reference](https://docs.github.com/en/graphql/reference/pulls) |

The fine-grained limitation changes the original idea. A bot user added as a collaborator to a
personal-account repo cannot use a fine-grained token there. What limits the bot is its
**collaborator role**, not its token scopes. The role cannot change settings or rulesets, and the
role is not on the bypass list.

## Proposed design

### Identity: bot user vs. GitHub App

| Dimension | Bot user + classic token (recommended) | GitHub App |
| --- | --- | --- |
| Setup | Second account, invite as collaborator, create a token | Create an App, install it on the repo, store its private key |
| What limits it | Collaborator role: no settings, no rulesets, not on bypass | App permissions: grant Contents, Pull requests, Issues write; omit Administration |
| Token scope | Classic `repo`, covering every repo the bot is invited to. Omit `workflow` so pushes cannot change `.github/workflows/` | Narrowed per repo and per permission |
| Token lifetime | Long-lived. Set an expiry and rotate | One hour |
| Getting a token into `gh` and `git` | `gh auth login --with-token` once; `gh` keeps it in the keychain | Needs a helper that signs a JWT and mints a token at least hourly. `gh` has no built-in App login |
| Attribution | Commits and comments show the bot login | Commits and comments show `<app>[bot]` |
| Moving parts in roborepo | Env entries only | Env entries plus a minting helper and refresh |

**Use the bot user.** It needs no code to mint or refresh tokens, and its power is limited by
GitHub's role model, not by scopes roborepo has to get right. The classic token is broader than
ideal, but it reaches only repos the bot is invited to, and on each of them the bot is a
collaborator. Revisit the App if the repo moves to an organization, which also makes fine-grained
tokens possible, or if a long-lived token becomes unacceptable.

### What GitHub enforces with the identity on

| Agent action | Identity off (today) | Identity on |
| --- | --- | --- |
| Push to `main` | Local hooks only; GitHub sees the admin | Local hooks, and GitHub rejects it |
| Merge its own PR | Local deny on `gh pr merge` only | GitHub requires another person's approval of the last push |
| Delete or force-push `repo-plans` | Local hooks only | GitHub rejects it (`roborepo protect`) |
| Change rulesets or repo settings | Possible through `gh api` if the hooks miss it | The collaborator role cannot |
| Codex push, PR, or plan save | Fails at the sandbox; the user runs it | Works with no prompt |
| Read, reply to, and resolve review threads | Not possible | Allowed |
| Comment on or review a PR, create an issue | Asks the user | Allowed |

The managed `roborepo-main-merge` ruleset from `3xh2sq32`, applied by `roborepo protect`, carries
the merge rule:

| Setting | 2026-10-30 (`no-push-to-main`) | Required (`roborepo-main-merge`) |
| --- | --- | --- |
| `required_approving_review_count` | 0 (since raised to 1 by the owner) | 1 |
| `require_last_push_approval` | false | true |
| Bypass | Repository admin, `always` | Unchanged |

The bot can then merge only after someone other than the last pusher approves. The user still
pushes and merges directly through the bypass. `gh pr merge` stays on the local deny list as well.

### Turning the identity on

The switch is an optional package, `github-agent-identity`, off by default. Turning it off reverts
everything it added. A user does not enable it by hand: the guided setup enables it as its last step.

The happy path:

1. `/plan-suite-init` finishes and offers to let agents work on GitHub as a bot.
2. The user runs `roborepo github setup` in their own terminal.
3. The user creates the bot account on GitHub.
4. The user invites it as a collaborator on the repo and accepts the invite as the bot.
5. The user creates a classic token with `repo` scope and an expiry.
6. The user pastes the token at the setup's hidden prompt; the setup hands it straight to `gh` under
   the agent config dir.
7. The setup checks the bot login, write-not-admin permission, token scopes, and the merge and
   `repo-plans` rules.
8. The setup enables `github-agent-identity`, which re-renders Claude and Codex config.

If a check in step 7 fails, the setup reports what failed and how to fix it, and the package stays
off. A user who declines the offer keeps today's behavior: agents act as the user, `gh api` stays
denied, and Codex hands pushes back to the user.

| Piece | Behavior |
| --- | --- |
| Offer | `/plan-suite-init` ends by running the doctor's identity check. When the identity is not set up, it offers the setup and gives the one command to run. Packages have no post-enable hook, so the offer lives in the step a user runs right after turning on the plan suite |
| `roborepo github setup` | A new CLI command under a new `github` namespace. Interactive: it opens each GitHub page, waits for the user, and checks the result before moving on. It reruns safely and skips steps already done |
| Token entry | Read with hidden input and piped to `gh auth login --with-token` under the agent `GH_CONFIG_DIR`. Never echoed, written to a file, or passed as an argument |
| Agents and the setup | Agents are denied `roborepo github setup`, so a token never passes through an agent transcript. The offer tells the user to run it in their own terminal |
| Checks | The same checks as the doctor (see "Doctor check"), through `modules/forge/` |
| Ruleset step | If `roborepo protect` has not been run for this repo, the setup runs it after the user confirms |
| Finish | Enables the package through the existing package enable path, which re-renders Claude and Codex config |

What the package changes, and who renders it:

| Entry | Rendered by | Why there |
| --- | --- | --- |
| `GH_CONFIG_DIR` (Claude `env`, Codex `shell_environment_policy.set`) | Package `config-patch` (`set`) | A single key the package owns |
| Codex `network.domains` GitHub entries, `features.network_proxy` | Package `config-patch` | Keys the package can own; existing domains are kept |
| Extra `GIT_CONFIG_*` pairs and `GIT_CONFIG_COUNT` | Core renderer, when the package is enabled | `GIT_CONFIG_COUNT` is shared with core's `core.hooksPath` entry, so one patch cannot own it |
| Codex `network.enabled` | Core renderer (`codexNetworkAccess`), when the package is enabled | Already rendered from `go-online` |
| `gh api` and `post-to-github` moving to allow | Core permission rendering, when the package is enabled | Changes core behaviors in `agent-permissions.json` |

Phase 3 confirms this split against config-patch's one-owner rule before building it. If a
package-owned key turns out to need core rendering, it moves to the core column; the switch stays
the package.

### Delivering the identity to agent shells only

```mermaid
flowchart LR
    U[User terminal] -- uses --> UC[~/.config/gh: user token]
    U -- pushes with --> SSH[User SSH key]
    A[Agent shell] -- env sets --> G[GH_CONFIG_DIR: agent gh dir]
    G -- reads token from --> K[OS keychain: bot entry]
    A -- fetches and pushes over HTTPS via --> H[git credential helper: gh auth git-credential]
    H -- asks --> G
```

The secret never leaves the keychain. Rendered config carries only non-secret values:

| Setting | Delivered as | Value | Purpose |
| --- | --- | --- | --- |
| `GH_CONFIG_DIR` | Environment variable | `<home>/.roborepo/github-agent/gh`, absolute | `gh` reads the bot's `hosts.yml` from here, and the token from the keychain |
| `core.hooksPath` | `GIT_CONFIG_*` pair | Unchanged | The existing `pre-push` backstop |
| `credential.helper` | `GIT_CONFIG_*` pair | `""` | Clears inherited helpers, such as `osxkeychain`, which may hold the user's credential |
| `credential.https://github.com.helper` | `GIT_CONFIG_*` pair | `!gh auth git-credential` | Git asks `gh`, which answers as the bot |
| `url.https://github.com/.insteadOf` | Two `GIT_CONFIG_*` pairs | `git@github.com:` and `ssh://git@github.com/` | Fetches and pushes to an SSH remote both go over HTTPS as the bot |

`GIT_CONFIG_COUNT` grows from 1 to 5. If the Phase 2 check shows HTTPS fetch fails as the bot, use
`pushInsteadOf` instead, and record that Codex fetches and plan saves still cannot reach GitHub.

Local checks of the assumptions this rests on, run on 2026-10-30 with `gh` 2.103.1:

| Assumption | Result | How it was checked |
| --- | --- | --- |
| An empty `credential.helper` at environment scope stops `osxkeychain` from answering | **Holds.** Only the `github.com` helper ran | `git credential fill` under `GIT_TRACE=1` with the `GIT_CONFIG_*` pairs above; `osxkeychain` comes from Xcode's system `gitconfig` and did not run |
| `gh` expands `~` in `GH_CONFIG_DIR` | **It does not.** `GH_CONFIG_DIR='~/x'` created a literal `./~/x` | `gh config set` in a scratch directory. The value must be an absolute path in the copied-in config, never `~` and never in the tracked `generated/` file |
| Logging the bot in under a second config dir leaves the user's identity alone | **Holds for current `gh`, with one side effect** | `gh` source (`internal/config/config.go`): tokens are stored per login under service `gh:github.com`, and `ActiveToken` reads the active login's own entry first. Login also rewrites a shared blank-login "active" entry, which `gh` reads only as a fallback. The user's per-login entry exists, so the user's `gh` keeps the user's token. A tool that reads only the blank entry would get the bot's token |
| Gemini CLI can take environment variables | **Not reliable enough.** Gemini loads only the first `.env` it finds, searching from the working directory upward before `~/.gemini/.env`, so any repo with its own `.env` hides roborepo's file. Whether those values reach the shell tool is undocumented | Gemini CLI configuration docs. Gemini is not installed on this machine, so nothing was run |

Gemini therefore keeps the user's identity, and `gh api` stays denied for it, until Gemini offers
a settings-level env mechanism that roborepo can render.

### Letting the identity through Codex's sandbox

The HTTPS rewrite avoids the `~/.ssh/**` deny, because Git asks `gh` for the bot's token instead of
using SSH. It still needs the network, so with the identity on, the Codex profile opens only the
GitHub hosts:

| Codex setting (`network.*` is under `permissions.managed-workspace`) | Identity off | Identity on | Why |
| --- | --- | --- | --- |
| `network.enabled` | From `go-online`, `false` by default | `true` | Commands can reach the network proxy |
| `network.domains` | Unchanged | Adds `github.com` and `api.github.com` as `allow` | Git goes to the first and `gh` calls to the second. `api.github.com` is inferred from `gh`'s behavior and is checked in Phase 2 |
| `network.allow_local_binding` | Unset | Stays unset or `false` | With `true`, the credential protection plan measured wildcard listeners being allowed, which breaks the listener boundary the user chose |
| `features.network_proxy` | Unchanged | `true` | Routes commands through the allowlist |

These values go only into the copied-in config, never into the tracked `generated/` file, so the
default install is unchanged. `go-online` keeps its meaning: it still decides network access when
the identity is off, and its description gains a note about this exception. `~/.ssh/**` stays
denied.

The cost of this exception is that every sandboxed Codex command, not only a push, can reach those
two hosts without a token. Commands that do use the bot's token stay limited by its collaborator
role and the remaining deny list.

### RoboRepo's own Git calls

The plan store and `roborepo delivery fetch` run Git through `runGitProcess`, which strips
`GIT_CONFIG_COUNT`. Under the identity their fetches and pushes would go to SSH: blocked in Codex's
sandbox, and under Claude done with the user's key instead of as the bot.

| Change | Detail |
| --- | --- |
| Keep the identity pairs on request | Add an explicit option to `runGitProcess` that keeps the `GIT_CONFIG_COUNT` pairs. The default still strips them, so polling and read-only callers are unchanged |
| Plan store | Use the option for the store's `fetch` (in `fetchInto` and `fetchRemote`) and its `push` |
| Delivery fetch | Use the option for `fetchTrackingRefs` in `modules/delivery/operations.mjs` |

Both callers already run with `-c core.hooksPath=/dev/null` from the wrapper's hardening, and a
`-c` value wins over the hook path in the identity's `GIT_CONFIG_*` pairs, so keeping those pairs
does not turn hooks back on. That is safe for the store because it pushes one explicit refspec for
`repo-plans` and never `main`. The delivery fetch only writes refs under `refs/remotes/<remote>/`.

A Codex save with the identity off commits locally and reports "not synchronized". After the
identity is turned on, the next save pushes the pending commits too.

Portal saves are unchanged: a portal started from the user's terminal has none of the agent
settings, so its pushes keep the user's identity.

### Permissions with the identity on

| Piece | Change |
| --- | --- |
| `manifests/inventory/agent-permissions.json` | Move `gh api` from `change-github-directly` into a new behavior, `read-and-reply-on-github`, in the `allow` bucket, rendered only with the identity on. Render `post-to-github` as `allow` with the identity on and `ask` without it. Update both descriptions. `gh pr merge`, `gh auth token`, and the repo, secret, variable, release, and workflow commands stay denied |
| `roborepo github setup` | Denied to agents, so the token is only ever typed in the user's terminal |
| `GH_DENIED` in both push hooks | Drop `['api']` only when `GH_CONFIG_DIR` equals the agent identity dir. An install without the identity, or a shell that has unset it, still gets the deny |
| `scripts/test/protected-branch-push-check.mjs` | The `gh --repo=owner/repo api -X PATCH …` case stays `deny` without the identity, and becomes `allow` with it |
| Codex rules | Re-rendered from the manifest; no hand edits |

`gh auth token` stays denied: it would print the bot's token into the transcript.

### GitHub-specific pieces in one place

`modules/repositories/config.mjs` already treats hosts generically. Keep a seam, not an adapter:

- **Tag GitHub pieces by host.** Each `gh` behavior in `agent-permissions.json` gets
  `"host": "github"`. In both hooks, the deny list becomes one `github` entry in a host table
  (`{ github: { cli: "gh", denied: [...] } }`), so a second host is a new entry, not a rewrite.
- **One module for host calls.** Roborepo code that runs `gh` goes in `modules/forge/`, with an
  entry point that takes a host name and a `github.mjs` beside it. The `gh` runner in
  `modules/delivery/operations.mjs` moves there, and delivery calls it through the entry point.
  After that, nothing outside `modules/forge/` runs `gh`. The doctor check and the guided setup also
  call it, and Runtime's PR and CI lookup (Part 03) comes later.
- **Pattern for a future adapter.** The harness provider registry in `scripts/harnesses/`
  (`registry.mjs` and `contract.mjs`, with one folder per provider) is the model to copy when a
  real second host arrives.

### Doctor check

`roborepo doctor` reports, with the agent `GH_CONFIG_DIR`:

- whether the identity is set up at all; when it is not, the line names `roborepo github setup`;
- the bot is logged in, its token is not expired, and its login differs from the user's;
- the bot's permission on the current repo is write, not admin;
- the default branch's effective rules require an approval of the last push (`roborepo-main-merge`);
- `repo-plans` is protected from deletion and force pushes;
- the token's scopes do not include `workflow`, `admin:org`, or `delete_repo`.

## Implementation plan

### Phase 1: Check the open facts locally

- [x] Whether `gh` expands `~` in `GH_CONFIG_DIR`. It does not (see the results table).
- [x] An empty `credential.helper` through `GIT_CONFIG_*` stops `osxkeychain` from answering.
- [x] How `gh` keys keychain entries per login (read from source).
- [x] Whether Gemini CLI reads environment variables from a file roborepo can render. Not reliably.

### Phase 2: Account and GitHub settings (by the owner, after `roborepo protect` lands)

These checks need the bot account, which only a person can create. They decide details the later
phases build, so run them before Phase 3.

- [ ] Run `roborepo protect` (`3xh2sq32`) so `roborepo-main-merge` requires one approval of the
      most recent push, with the admin bypass kept, and `repo-plans` is protected.
- [ ] Create the bot account and invite it as a collaborator on `kirinmurphy/roborepo-alpha`.
- [ ] Create a classic token with `repo` only and an expiry, then log it in under the agent
      `GH_CONFIG_DIR`.
- [ ] `gh auth status` in the user's terminal still shows the user after the bot login.
- [ ] A classic token for a collaborator on a personal-account repo can push a branch and call
      `gh api` for that repo.
- [ ] The bot can reply to and resolve a review thread. GitHub's docs do not state which
      permission `resolveReviewThread` needs.
- [ ] The bot can push `repo-plans` directly under the managed ruleset, and cannot delete or
      force-push it.
- [ ] With `url.https://github.com/.insteadOf`, `git fetch` from an SSH remote succeeds as the bot.
      If it fails, use `pushInsteadOf` (see "Delivering the identity to agent shells only").
- [ ] From `codex exec`, with the agent environment and the network settings passed as run-only
      `-c` overrides, confirm these work inside the sandbox. If the keychain is unreachable, stop
      and bring the options back; do not fall back to a token in a file:
  - `gh auth git-credential` reads the bot's token from the keychain.
  - `gh` reads its config from `~/.roborepo/github-agent/gh`.
  - `git fetch` and `git push` to a feature branch succeed as the bot.
  - `gh pr create` succeeds, and `api.github.com` is the only other host it needs.
  - The `pre-push` default-branch lookup (`git ls-remote`) works when `refs/remotes/<remote>/HEAD`
    is unrecorded. It receives the rewritten URL, so it should use HTTPS, but this is untested.

### Phase 3: Package and agent-only delivery

- [ ] Confirm the rendering split in "Turning the identity on" against config-patch's one-owner
      rule and `${package-runtime:…}` expansion. Move any entry a patch cannot own to the core
      column.
- [ ] Add the `github-agent-identity` package under `globals/packages/`, off by default, with its
      config patches.
- [ ] Add the identity `GIT_CONFIG_*` pairs to the rendering step that writes `core.hooksPath` for
      Claude and Codex, rendered only when the package is enabled.
- [ ] Write an absolute `GH_CONFIG_DIR` into the copied-in config, since `gh` does not expand `~`.
- [ ] Render the Codex network settings from "Letting the identity through Codex's sandbox" into the
      copied-in config when the package is enabled, keeping existing `domains` entries. Extend
      `codexNetworkAccess` in `scripts/harnesses/permissions-render.mjs` for the `enabled` value.
- [ ] Update the `go-online` description in `agent-permissions.json` to name the exception.
- [ ] Record Gemini as not covered in the docs, with the `.env` lookup order as the reason.
- [ ] Update the isolated browser testing plan ([[8bjltk2n]]), whose goal of strict host networking
      needs to name the GitHub hosts as the exception.
- [ ] Add the keep-identity option to `runGitProcess` in `modules/repositories/git-exec.mjs`, and
      use it for the plan store's fetch and push and for the delivery fetch.

### Phase 4: Permissions

- [ ] Add `"host": "github"` to every `gh` behavior in `agent-permissions.json`.
- [ ] Add the `read-and-reply-on-github` behavior with `gh api`, rendered only with the identity on.
- [ ] Render `post-to-github` as `allow` with the identity on and `ask` without it.
- [ ] Deny `roborepo github setup` to agents.
- [ ] Turn `GH_DENIED` into a `github` host entry in both hooks, and lift `api` only under the agent
      `GH_CONFIG_DIR`.
- [ ] Extend `scripts/test/protected-branch-push-check.mjs` with the with-identity and
      without-identity cases.

### Phase 5: Host module and doctor

- [ ] Add `modules/forge/` with a host-name entry point and `github.mjs`.
- [ ] Move the `gh` runner from `modules/delivery/operations.mjs` into `modules/forge/github.mjs`;
      delivery calls it through the entry point, and `scripts/test/delivery-operations-check.mjs`
      still passes.
- [ ] Add the doctor check, tested with a fake `gh` executable for: identity not set up, bot is
      admin, bot is the user, expired token, ruleset without last-push approval, unprotected
      `repo-plans`, and a healthy setup.

### Phase 6: Guided setup

- [ ] Add `roborepo github setup` under a new `github` namespace in
      `manifests/platform/cli/command-definitions/`, built on `modules/forge/`. It walks the steps in
      "Turning the identity on", skips steps already done, and on a failed check reports the cause
      and leaves the package off.
- [ ] Read the token with hidden input and pipe it to `gh auth login --with-token` under the agent
      `GH_CONFIG_DIR`; never echo it, write it to disk, or pass it as an argument.
- [ ] Run `roborepo protect` from the setup, after confirmation, when it has not been run for the
      repo.
- [ ] Enable `github-agent-identity` through the existing package enable path as the last step.
- [ ] Add the offer to `/plan-suite-init`
      (`globals/packages/plan-suite/skills/plan-suite-init/SKILL.md`): after the store is ready, run
      the doctor's identity check, and when the identity is not set up, offer `roborepo github setup`
      for the user to run in their own terminal.

## Validation

Automated:

- `node scripts/test/protected-branch-push-check.mjs` passes, covering `gh api` with and without the
  identity, and `roborepo github setup` denied to agents.
- The doctor check's fake-`gh` test passes for each failure case and the healthy case.
- A setup test with a fake `gh` and scripted input shows: a rerun skips finished steps; a failed
  check leaves the package off; a passing run enables it; the token never appears in output, argv,
  or files under the test home.
- A rendering test, added beside `scripts/test/codex-permissions-foreign-lines-check.mjs`, shows the
  rendered Codex config for both states. Identity off: `enabled = false`, no GitHub domains.
  Identity on: `enabled = true`, both GitHub domains, existing domains kept, `~/.ssh/**` still
  denied, and `allow_local_binding` not `true`.
- A package test shows enabling `github-agent-identity` adds its entries, including
  `GIT_CONFIG_COUNT = 5` and an absolute `GH_CONFIG_DIR`, and disabling it restores the prior config.
- A `git-exec.mjs` test shows the new option keeps the `GIT_CONFIG_COUNT` pairs and the default
  still strips them.
- `node scripts/test/delivery-operations-check.mjs` passes after the `gh` runner moves.
- `npm run check` passes before the PR.

Manual, on the real repo, after Phase 6:

| Check | Expected |
| --- | --- |
| A fresh repo: run `/plan-suite-init` | It ends by offering `roborepo github setup` |
| Run `roborepo github setup` from the user's terminal, end to end | Each step waits and checks; the package is enabled at the end; `roborepo doctor` reports the identity healthy |
| The user, in a terminal with the agent environment exported (`GH_CONFIG_DIR` and the `GIT_CONFIG_*` pairs), runs `git push --no-verify origin HEAD:main`, so that only GitHub decides | GitHub rejects it with a ruleset error naming `roborepo-main-merge` |
| From an agent shell: push a feature branch and open a PR | Push succeeds; the PR and commits show the bot login |
| In an interactive Codex session and in `codex exec`: push a feature branch and open a PR | Both succeed as the bot, with no prompt and no sandbox escalation |
| In an interactive Codex session and in `codex exec`: `roborepo plans save` on a plan | Reports "synchronized"; the commit is on `origin/repo-plans`, pushed with the bot's token, with no prompt and no sandbox escalation |
| Save from Codex with the identity off, turn it on, then save again | The first save reports "not synchronized"; the second pushes both commits |
| In a Codex session: `roborepo delivery fetch origin` | Succeeds over HTTPS as the bot |
| In a Codex session: `git push origin HEAD:main`, and `git push --no-verify origin HEAD:main` | The hook denies both before they reach GitHub |
| In a Codex session: reach a host not on the allowlist, read `~/.ssh/known_hosts`, and bind a wildcard listener | All three are refused |
| In a Codex session with the identity off: `git push --dry-run` to a feature branch | Fails on the network, as it does today |
| From an agent shell: `gh api graphql` query for the PR's `reviewThreads { isResolved }`, a reply, and a resolve | All three succeed as the bot |
| From an agent shell: `gh pr comment` on the bot's PR | Runs without a prompt; the comment shows the bot |
| From an agent shell: merge the bot's PR through `gh api`, with no approval | GitHub refuses |
| From an agent shell: delete or force-push `repo-plans` through `gh api` or `git push --force` | GitHub refuses |
| From the user's terminal: `gh auth status` | Shows the user, not the bot |
| From the user's terminal: push a commit to `main` | Succeeds through the admin bypass |

## Documentation impact

| Doc | Update |
| --- | --- |
| `docs/user/reference/claude-hooks.md`, "Opening Pull Requests With gh" | `gh api` moves to allow and posting to allow under the agent identity. Replace "to GitHub an agent is you" with the bot setup, and say what stays denied |
| `docs/user/reference/claude-hooks.md`, "Protected Branches" | "Agents can push to feature branches without a prompt" is untrue inside Codex's sandbox until the identity is on. Name the identity as what Codex needs for it |
| `docs/user/reference/codex-hooks.md` | Same identity and `gh` changes for Codex. Under "Permissions On Codex", say the sandbox blocks GitHub until the identity is on, and which hosts it then opens |
| `docs/user/guides/setup-and-daily-use.md` | The guided setup: when it is offered, what the user does on GitHub, what `roborepo github setup` checks, and what stays the same if they decline |
| `docs/user/reference/roborepo-cli.md` | `roborepo github setup` and the new doctor check |
| `docs/user/guides/plan/lifecycle/plan-suite.md` | The setup offer at the end of `/plan-suite-init`. Codex saves push directly with the identity on, and report "not synchronized" without it |
| `docs/internal/docs-map.md` | Add `modules/forge/` and the `github-agent-identity` package |

## Risks

- **The user's credentials stay reachable from agent shells.** The SSH key, the default `gh`
  config, and the keychain are all still there. An agent that unsets `GH_CONFIG_DIR` or runs `ssh`
  directly acts as the admin again, which can push to `main` through the bypass. The local hooks
  still deny the paths they can see. GitHub enforcement covers the default path, not a deliberate
  workaround. Hiding the SSH agent is the next hardening step (see Future work).
- **Classic token breadth.** `repo` reaches every repo the bot is invited to. Invite it only where
  agents work, and set an expiry.
- **Resolving threads can satisfy merge rules.** If "Require conversation resolution" is turned on
  later, an agent resolving threads could unblock a merge. The required approval still holds.
- **Bot attribution changes PR history.** Agent commits and comments show the bot login, which is
  the point, but reviewers need to know who the bot is.
- **Codex's sandbox may not reach the keychain.** If `gh` cannot read the token there, the design
  needs a different way to hand it over. Phase 2 finds this out before any rendering work starts.
- **Allowed GitHub hosts widen what sandboxed commands can do.** Any sandboxed command can send data
  to those hosts, for example through `gh api` as the bot. Mitigation: the exception names only two
  hosts, is off without the identity, and the bot's role limits what its token can change. It does
  not stop data leaving through GitHub.
- **An expired bot token looks like a network problem.** An expired token turns Codex saves into
  "not synchronized" rather than an error, and the commits wait locally. Mitigation: the doctor
  check fails on an expired token and names `roborepo github setup` to replace it.
- **The token passes through a terminal.** The setup reads it with hidden input and agents are
  denied the command, but a user who pastes the token into an agent chat leaks it to the transcript.
  The setup's instructions say to paste it only at its own prompt.

## Open questions

None. The decisions are in the Decision Log; the GitHub behaviors still unverified are checks in
Phase 2.

## Decision Log

- November 5, 2026: the user chose no-prompt feature-branch pushes for both Claude and Codex, and
  approved adding these requirements here after being told they open the GitHub hosts as a narrow
  exception to the strict host networking in the credential protection plan. `~/.ssh` stays denied.
  The work lives in this plan because it needs the bot's token: without the bot, GitHub would not
  reject a push to `main`.
- November 6, 2026: the user asked this plan to carry the work that lets Codex plan saves push
  directly, once the bot identity and the plans branch (`pvgx8oh7`) both exist.
- November 14, 2026: the plans branch (`pvgx8oh7`) and the delivery commands from `vzgsx5vz` have
  landed. Plan saves and the delivery fetch are now unconditional work here, and the delivery `gh`
  runner moves into `modules/forge/`, superseding "nothing in RoboRepo runs `gh`". No lifecycle
  change is needed for either plan.
- November 14, 2026: the user chose to build `roborepo protect` (`3xh2sq32`) first rather than set
  rulesets by hand, so this plan depends on it. The bot gets push rights only after `repo-plans` is
  protected.
- November 14, 2026: the user wants a seamless way to turn the identity on. Chosen: a guided setup
  in this plan, `roborepo github setup`, offered at the end of `/plan-suite-init`, with an optional
  package as the underlying switch so turning it off reverts cleanly. Declining keeps today's
  behavior.
- November 14, 2026: with the identity on, `post-to-github` commands move from ask to allow.
- November 14, 2026: the user's priority is no agent push to `main` and no merge without a human.
  The user's SSH agent stays visible to agent shells for now; hiding it is future hardening.
  Agent fetches move to HTTPS as the bot (`insteadOf`), gated on the Phase 2 fetch check.

## Future work

- Hide the user's SSH agent from agent shells. Codex's `shell_environment_policy` can exclude
  `SSH_AUTH_SOCK`; Claude's `env` can only set it to empty. With fetches on HTTPS, this closes the
  remaining path by which an agent can act as the admin.
- A portal version of the guided setup.
- A full forge adapter: `roborepo pr …` commands, with GitHub as one provider and GitLab or
  Bitbucket as others, modeled on `scripts/harnesses/`. Build it only when a second host is
  actually used.
- A GitHub App identity, if the repo moves to an organization or long-lived tokens are ruled out.
