# Config Control Panel

## Purpose

`roborepo` exposes the harness configuration — what indexers, plugins, skills,
and permission buckets are active — as an inspectable, editable surface.
A user can see the current state and change it from either the web dashboard
(`/agents`) or the interactive terminal flow (`roborepo package manage`), without
hand-editing `~/.claude/settings.json`, `~/.codex/config.toml`, or symlinks.

## Inspecting a repo's agent files

Choose a repo in the **Viewing** menu at the top of `/agents` to see the Claude Code and Codex files
that repo carries. The view is read-only and reads only the repo's primary checkout on this
computer, including uncommitted and Git-ignored files that exist only there.

If the primary checkout cannot be found, or more than one checkout could be it, the page says so
and shows no files: it never reads another clone or worktree in its place.

- **Token Use.** A table, titled with the repo's name, with one row per active harness. **Repo
  Usage** is what this repo adds to every session started at its root: root-level instructions and
  rules in full, plus each root skill's and command's name and description. **Total Usage** adds
  this machine's global startup context (the global page's Usage) and is colored on the same
  low/medium/high scale; Repo Usage is a plain number. An active harness whose repo files RoboRepo
  cannot read yet (Gemini CLI today) is named below the table. **View Global Config**, at the right
  of the title, clears the repo filter, the same as choosing **All repos**.
- **Agent Config.** Below the table, three sections list the repo's own files, in this order.
- **Rules.** `CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules/`, `AGENTS.md`, and `AGENTS.override.md`,
  each named by its path in the repo. **Repo Root** holds what a session started at the root reads;
  **Conditional** holds files in subfolders and rules scoped to paths, which apply only to work
  there. A file several harnesses read, such as `AGENTS.md`, is one row.
- **Config and hooks.** `.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json`,
  `.claude/agents/`, `.claude/commands/`, `.codex/config.toml`, `.codex/hooks.json`, and
  `.codex/agents/`, grouped under each harness's name and named by path, each with a one-line
  summary of what it declares. Permission entries here are declarations, not the effective policy.
- **Skills.** `.claude/skills/<name>/SKILL.md` and `.agents/skills/<name>/SKILL.md`, at the root and
  in subfolders, with each skill's name and description. A skill several harnesses carry is one
  row. Skills in `.codex/skills/`, an older location Codex still reads, are listed and count toward
  Codex's Repo Usage; a skill name in both `.agents/skills/` and `.codex/skills/` counts once.
- **No tags.** Rows carry no tags. The few facts that tell a file apart (a legacy location, an
  override, a symbolic link out of the repo, copies that differ between harnesses) sit in the info
  icon beside the row; Git status is in the popup.
- **Generated files.** Files the repo's `.gitattributes` marks `linguist-generated` (tool output
  rendered from other sources) are left off the page and never counted.
- **Popups.** Select a row to open it as on the global page: the file's location (every location,
  for a row several harnesses share), its Git status, and estimated sizes. Markdown renders as
  formatted text, with images left out so a repo file cannot make the page fetch a URL; imports
  such as `@AGENTS.md` stay as written. A skill opens the same skill view as the global page. JSON
  and TOML show every key with only safe values: booleans, numbers, names, modes, and permission
  rules are shown; environment values, headers, commands, arguments, URLs, very long text, and
  anything that looks like a credential are hidden. A symbolic link that points elsewhere in the repo opens its target;
  one pointing outside the repo is listed but not opened.

The global page's settings and hooks popups use the same readable key list with the same hidden
values.

Large repos are scanned within fixed limits; when a limit is reached the page says the results are
partial. Choose **All repos** to return to the global page and its controls.

## Concept Model

The panel is built from a few nouns. Source of truth differs per noun — some live in
the user's live harness config, some in repo manifests, some in RoboRepo state.

| Noun | What it is | Source of truth |
| --- | --- | --- |
| **Package** | A named feature made of typed resources | `globals/packages/<package>/package.config.json`; live config (enabled state) |
| **Resource** | One typed unit of a package's install or presentation | the package config |
| **Skill** | A shared or native skill, inspected without flattening harness-specific metadata | package-owned `skills/<name>` source or system skill source; `~/.roborepo/skills/<name>` (managed cache); installed harness skill directories (harness install state) |
| **Permission behavior** | A named behavior or arbitrary command set to `allow`, `ask`, `deny`, or `default` | `manifests/inventory/agent-permissions.json` (defaults); `~/.roborepo/command-overrides.json` (personal overrides); live config (active render) |

### Resource Types

A package is `{ schemaVersion, id, label, resources: [...], requires?: [...] }`. Enabling a package
applies each installable resource; the enable/disable switch dispatches on `resource.type`.

| type | Wires | Notes |
| --- | --- | --- |
| `mcp` | An MCP server registration | via `roborepo mcp add` |
| `rules` | A rules block in the harness rules file(s) | `harness: claude` → `CLAUDE.md`, `codex` → `AGENTS.md`, no `harness` → each present harness; merged/removed by unique first line |
| `hooks` | Hook entries in the selected harness's hook config | merged by command |
| `permissions` | `permissions.allow` entries | exact-match add/remove |
| `plugin` | `extraKnownMarketplaces` + `enabledPlugins[id]` | harness downloads the plugin on its next launch |
| `service` | A registered async handler's bespoke install | e.g. telemetry's spool + capture hooks |
| `skill` | A shared-skill link into harness skill dirs | reuses the skill linker |

### Package composition

A package may list `requires: [pkgId, ...]` and `recommends: [pkgId, ...]`:

- Enabling it turns on each package it includes (dependencies first) and then its own resources.
  Only the package you turned on is recorded; an included package stays on while any package you
  turned on still includes it, and turns off with the last one.
- Turning off a package that only stays on because packages you turned on include it opens a
  dialog listing those packages. **Leave them enabled** changes nothing; **Disable All Packages**
  turns them off too, as `roborepo package disable <id> --cascade` does.
- A **composite** package lists only `requires`, so it bundles other packages under one toggle.
- A composite reports itself enabled only when every included package, and any resources of its
  own, are enabled.
- A recommended package is never turned on for you. When an enable leaves recommendations off, the
  panel lists them as ordinary rows: each switch turns its package on or off at once, and the
  label opens its detail. **No Thanks** closes the panel with nothing changed; once you turn one
  on, the button reads **Done**. Turning a package on there opens no further list of its own
  recommendations. The terminal setup
  wizard asks nothing: after it applies your choices it prints one line,
  `recommended (not enabled): code-style, test-harness — enable with: roborepo package enable <id>`
  after you select Technical Writing, naming what the packages you selected recommend that is still off.
- Nesting is flattened. A package's included packages are everything it requires, directly or
  through another included package. The Config page and terminal call these **included**; the
  manifest field is `requires`. Its recommendations are its own plus those of every package it
  requires, less anything it requires; that one list is what its Dependencies show and
  what enabling it offers. A recommended package's own requirements come with it when you turn it
  on, and its own recommendations are not offered on the parent's behalf.

- A **dependency-only** package has no toggle of its own (`selectable: false`) and no row either
  (`presentation.visibility: "dependency"`); it turns on and off with the packages that require it.
  A **hidden** package (`presentation.visibility: "hidden"`) appears nowhere on the page. A
  non-selectable package must be one of these two: the catalog rejects one that would keep a row
  without a toggle.

For example, `plan-suite` (Development Planning Lifecycle) includes `technical-writing`,
`test-harness`, `implementation-review`, `code-style`, and `feature-verification`, and has nothing
left to recommend. `technical-writing` includes nothing and recommends `code-style` and
`test-harness`. `react` includes `javascript-typescript`, which includes `code-style`. Turning on
`plan-suite` turns on its five included packages; turning off `plan-suite` leaves `code-style` on
while `javascript-typescript` is still on.

A selectable included package with `catalog` visibility keeps its own row. Dependency-only
packages appear under **Includes** in their parents' source popups instead. Clicking a package's
name opens its source popup, which lists its visible included packages; each name there opens
that package's source, and **Back** returns to the package that includes it. A package with no
source of its own opens a contents view that lists only its included packages; if all of them are hidden, its
name opens nothing.

A row with included or recommended packages shows a **Dependencies** button. It opens
**Included Packages** and **Recommended Packages** lists, each package marked on or off; clicking one opens
that package's detail. While the package is off and some of its recommendations are too, a note
says you will be offered them when you enable it. `roborepo config status` prints the same lists
as `includes:` and `recommends:` lines under the row, marking recommendations still off.
**Select All** and the Plans banner act on packages you can switch directly, and the group switch
is hidden when none are left.

A package may also hold several skills. They turn on and off together with the package's one
toggle; there is no switch for a single skill inside it. Its card shows the package name, never one
of its commands, with no skill-count badge. Clicking the name opens a
contents view in the source dialog: the package's startup and when-loaded totals, a summary line
such as `7 skills · 1 rules fragment`, and one row per skill (its command, or its skill ID when it
has none, a one-line description, and its own cost), followed by a row for the package's rules or
hooks. Selecting a row opens the same source view a single-skill card opens; **Back** returns to
the list in the same dialog. A package with one skill or none opens its source directly, as before.

> Composition (`requires`, runtime feature enablement) is distinct from an install
> **bundle** (`manifests/platform/presets.json`), which groups file-copy/link rows at
> install time. Both exist; they operate at different layers.

### The sections

The panel renders these sections:

- **Global Rules** — start with the selector only; after a file is chosen, show the live
  `CLAUDE.md` / `AGENTS.md` content, the file path, and the default-rule drill-downs.
- **Hooks** — quick links to the live `~/.claude/settings.json`, `~/.codex/config.toml`,
  and `~/.codex/hooks.json` files.
- **Code Conventions** — auto-loaded skills (no command). Same skill-link toggle.
- **Chat-Time Output** — response output (how the agent words every response: a one-line result
  first, short and scannable by default, visuals over prose, no unexplained internal names, and
  plain evidence lines, with detail on request) plus the inline chat-note behaviors (impact awareness, skill
  visibility), each a `rules` package merged into every managed harness. Each is
  independent: a note behavior states its own placement and does not turn on response output. Each
  is off until you enable it; toggling adds or removes the behavior's rules block.
  Feature Verification also lives here: its skill has agents verify finished work themselves and
  show the evidence in the conversation (screenshots inline and the steps they took), and it unlocks `roborepo browser` for screenshots and recordings of local
  web apps. Playwright is installed only on first browser use, with your approval.
- **Development Workflows** — **Development Planning Lifecycle** has one toggle that enables all
  seven plan commands, including `/plan-suite-init` for repository setup.
- **Skills - Code Quality** — skills that check and improve code against project patterns.
- **Writing Assistants** — long-form writing workflows and structured documentation.
- **Integrations** — optional connections between RoboRepo and supported tools.
- **Monitoring** — the last package section: packages that observe agent activity and usage,
  **Usage Statusline** and **Capture Dense Bash**. Manage Telemetry from **Settings** or
  **Tokens**.
- **Permissions** — flat behavior and command buckets. Named behaviors and arbitrary commands can
  be set to `allow`, `ask`, `deny`, or reset to the manifest default. They render as one merged
  list split by authorship rather than by kind: entries the user customized appear first, each
  with a delete control, above the shipped defaults collapsed behind a count. Delete reverts to
  the manifest default, or removes the entry outright when it was user-added and has no default.

## Happy Path

1. Run `roborepo web` and open `/agents` (or run `roborepo package manage`
   in a terminal).
2. The panel shows the current state of each section.
3. Toggle a package or skill. The change is written to your live harness config and the panel
   refreshes. Token tracking is controlled from Settings and the Tokens page. If the change left a
   RoboRepo Codex hook awaiting review, one card offers to open Codex's review; a bulk change gets
   one card for the whole batch. A CLI-only installation gets no card, because Codex asks at
   startup. See [Codex Hooks](codex-hooks.md#trusting-roborepos-hooks).
4. To change permissions, set a named behavior or arbitrary command to `deny`, `ask`, `allow`, or
   `default`.
5. Changes take effect the next time the agent harness starts a session.

## Where Changes Go

Every change writes your **live** harness config (`~/.claude`, `~/.codex`, `~/.gemini`), never the
repo template under `globals/`. Changes take effect the next time the harness starts a session.

Package rows can show `enabled`, `configured`, `disabled`, `partial`, `external`, or `blocked`.
`configured` means fully installed with a runtime service deliberately turned off (for example,
telemetry capture disabled); `partial` means the install is genuinely incomplete.

`external` shows on the card as **Installed outside RoboRepo**. The package is off, but some of its
pieces already exist on this machine and RoboRepo did not put them there: a skill folder copied in
by hand, or an MCP server or status line that another tool configured. The card names what it
found (hover the badge for the same list). Turning the package on replaces those pieces with
RoboRepo's version, and RoboRepo manages them from then on. Leaving it off changes nothing.

## Context Cost Estimates

The panel estimates how many tokens your configuration adds to each harness, so you can see what a
package costs before and after enabling it. Two kinds of cost are tracked and never mixed:

| Cost | What it counts | How it is shown |
| --- | --- | --- |
| Startup | Text loaded automatically at chat start: the rendered rules and each installed skill's name and description | A per-harness total in the agent files grid |
| On-demand | Text loaded only when used: a full skill body or slash command | Per item, rated low (< 1k), medium (1k–3k), or high (> 3k); only medium and high get a chip |

- On-demand costs are never summed, because skill bodies do not load together.
- Settings files, hook scripts, and MCP schemas are not prompt text, so they get no token number.
- Disabled packages show their potential cost but add nothing to the totals.
- Anything rated medium or high is listed, highest first, in a warning panel above the grid.
- All counts are estimates at about 4 characters per token.

## Permissions

Permissions are global machine state; there is no per-project permission layer.

Personal changes are stored in `~/.roborepo/command-overrides.json` and layered on top of
`manifests/inventory/agent-permissions.json` before rendering live Claude/Codex config. Resetting a
row to `default` removes the personal override and returns to the repo manifest default for that
behavior or command.

### Guarded delivery, plan, and scratch steps

These default-allow behaviors cover the named workflow operations.

| Behavior | Covered commands |
| --- | --- |
| `guarded-delivery` | `delivery fetch`, `delivery pr-body`, `delivery pr-ready`, `delivery retry-ci` |
| `plan-lifecycle` | `plans sync-base`, `plans stop-servers` |
| `plan-store-commands` | Named plan-store reads, writes, lifecycle transitions, and checks |
| `scratch-folders` | `scratch <name>` |

`roborepo scratch` checks the folder name, writes only under `~/.roborepo/scratch/`, and prunes
scratch folders past the store's bounds without a prompt. The guarded delivery commands validate their repository, branch, and head targets before acting.
The lifecycle commands retain their transition, synchronization, and process guards. The plan-store
allow covers shell invocation. The archive and close skills still require their workflow approvals. Raw fetch and GitHub commands follow their
existing policies: the prompts for `gh pr edit` and `gh pr ready`, and the denials for `gh pr merge`,
direct `gh api`, and force-push. With the GitHub agent identity on, `gh pr edit`, `gh pr ready`, and
`gh api` are allowed instead; `gh pr merge` and force-push stay denied.

| Provider | Projection and scope |
| --- | --- |
| Claude | Named command prefixes become `Bash(...:*)` allows, subject to native precedence and other configured rules |
| Codex | Prefix rules allow the named commands, while filesystem, network, and approval controls still apply |
| Gemini | Shell-command prefix policies express the same buckets through its Policy Engine |

Rendering shows the intended policy. Live enforcement depends on the provider and session
configuration. The defaults grant command permission within those controls. GitHub credentials
and network access are configured separately. See [guarded feature delivery](roborepo-cli.md#guarded-feature-delivery)
for the exact command forms and target restrictions.

### Gates and scopes

File access is two behaviors, not one, and they answer different questions:

| Behavior | Question |
| --- | --- |
| `read-files` / `write-files` | **Whether** the tool may be used at all — a master switch across every path |
| `read-scope` / `write-scope` | **Where** it may be used without prompting — a path allowlist |

Both must pass. Setting `write-files` to `deny` shuts writing off everywhere regardless of scope;
leaving it `allow` lets `write-scope` decide which paths are silent and which prompt.

The gate exists separately because some harnesses cannot express path scoping at all (Gemini's
Policy Engine), and falls back to the whole-tool decision there. `write-files` deliberately emits no
unscoped rule of its own: a bare `Write`/`Edit` entry out-ranks every path-scoped rule and would
silently defeat the scoping.

### Plans store edits

`edit-plans-store` denies Claude's Write and Edit tools under any `repo_plans` folder, the plans store
worktree. Plans change only through `roborepo plans` commands, which validate, commit, and push, and
Claude's writes inside the repo's worktree family otherwise need no prompt. Reading stays allowed.
Codex and Gemini render nothing for it: Codex's sandbox must let the CLI write there, and Gemini
policies cannot match paths.

### Credential denylist

`read-secrets` denies reads of credential material — `~/.ssh`, `~/.aws`, `~/.gnupg`, cloud config,
keychains, and `.env`/`*.pem`/private-key files anywhere on disk. It is the one layer the repository
boundary cannot provide: a `.env` inside your checkout is *in*-bounds for the boundary, so only a
deny rule stops it.

Two properties make this the security floor rather than one more preference:

- **Deny out-ranks everything.** Claude evaluates deny before ask before allow, so these beat both
  the scope allowlists and any `allow` a hook returns.
- **Deny is not a prompt.** There is no in-session override. If a denied path needs reading, carve
  it out of the behavior rather than working around it.

When `read-secrets` resolves to `deny` and `~/.codex/config.toml` already exists, RoboRepo renders
native filesystem denies in both Codex's writable `managed-workspace` profile and its
`managed-read-only` profile. If that file is absent, RoboRepo skips Codex and renders no managed
profile. Initialize Codex, apply RoboRepo's permission settings, then start a fresh session and
verify the selected profile before relying on this boundary. These denies prevent matching
**reads and writes**, including credential-file edits. The enumerated environment-file patterns
leave `.env.example` and `.env.sample` readable. Setting the behavior to `allow` removes these
denies; `ask` also removes them and reports that path-specific prompting is unsupported.

Native enforcement was verified on macOS with Codex CLI `0.163.0-alpha.11.2`, using synthetic
files and freshly launched sandboxed commands. This covers commands and their descendants;
desktop session tools, structured file tools, browser, MCP, and escalated processes remain
unverified. Linux and Windows enforcement is unverified. Gemini cannot enforce this path boundary;
Claude retains its tool permission rules. A rendered profile alone does not certify protection.

Three public certificate-authority bundles are exempt inside Claude's shell sandbox (see below):
`/private/etc/ssl/cert.pem`, `/opt/homebrew/etc/ca-certificates/cert.pem`, and
`/opt/homebrew/etc/openssl@4/cert.pem`. The `*.pem` pattern would otherwise hide them, and TLS
clients such as `curl` and `npm` read them to verify servers. They hold no secrets. Claude's Read
tool still cannot open them.

A denylist only catches what it names. It cannot cover unknown-sensitive files — a tax PDF, a
client repo under NDA — which is why it complements the scope perimeter instead of replacing it.

### Shell sandbox (Claude)

`sandbox-shell` runs each Claude shell command inside the operating system's sandbox (Seatbelt on
macOS). Commands that stay inside the bounds below run without a permission prompt, whatever their
shape: pipes, loops, and inline scripts all count. A command an `ask` or `deny` rule names still
prompts or is refused when run through `claude -p`; the desktop app was seen to run sandboxed
commands without consulting ask rules, which is why branch switches run outside the sandbox (below).

Three command behaviors changed alongside the sandbox. `delete-files` and `switch-branches` depend
on it; `merge-pull-requests` does not, since `gh` runs outside it either way:

| Behavior | Change | Why |
| --- | --- | --- |
| `delete-files` (`rm`, `git rm`) | Default `ask` → `allow` | The sandbox limits deletes to the checkout and temp folders, and the protected-branch hook asks before any delete in a checkout on `main` ([Deletes on a protected branch](claude-hooks.md#deletes-on-a-protected-branch)). Set it to `ask` if you run agents in Gemini, which has neither |
| `merge-pull-requests` (`gh pr merge`) | New, default `deny` (was part of `change-github-directly`) | Agents never merge a pull request; you merge on GitHub. With the protected-branch hook's merge guard, agents also never merge into `main` locally ([Merges into a protected branch](claude-hooks.md#merges-into-a-protected-branch)) |
| `switch-branches` (`git checkout`, `git switch`) | Default stays `ask`; the commands now run outside the sandbox | So the prompt also appears in the desktop app. `git switch main` stays denied (`occupy-main`) |

| Inside the sandbox | Bound |
| --- | --- |
| Writes | The session's checkout, the temp folders in `write-scope`, the npm cache (`~/.npm`), and the agent scratch folder (`~/.roborepo/scratch`). In a linked worktree, Claude also allows the shared `.git` directory so `git commit` works |
| Reads | Everything except `read-secrets`, minus the certificate bundles above |
| Network | Hosts in `reach-allowed-hosts` connect; the address in `reach-claude-log-upload` is refused; any other host prompts |

| `sandbox-shell` | Result |
| --- | --- |
| `allow` (default) | Sandboxed commands run without prompting |
| `ask` | The sandbox stays on, and commands prompt by the command rules |
| `deny` | The sandbox is off; commands follow the command rules alone |

`reach-allowed-hosts` lists `registry.npmjs.org`, `github.com`, and `*.githubusercontent.com`.
`allow` lets them through, `ask` makes them prompt like any other host, and `deny` refuses them.
It is separate from `go-online`, which stays Codex's on/off network switch.

`reach-claude-log-upload` names `http-intake.logs.us5.datadoghq.com`, the Datadog address the
`claude` program sends its own error logs to. It matters only when an agent runs `claude` from its
shell: that copy is sandboxed, and without this row it would prompt for the address on every run.
The Claude Code app's own uploads run outside the sandbox and are unaffected. `deny` (default)
refuses the address without a prompt, `ask` prompts, and `allow` lets it through. Avoid `allow`:
anyone with a Datadog account can receive data posted to that address, so allowing it gives every
sandboxed command a way to send files out.

**What runs outside the sandbox.** `docker`, `gh`, `git push`, `git pull`, `git fetch`,
`roborepo`, and `./bin/roborepo` cannot work inside it, or would prompt on every call: Docker needs
its daemon socket, `gh` calls `api.github.com`, which the host list leaves out, SSH cannot pass the
sandbox proxy, and `roborepo plans` commands write the plans store, which `edit-plans-store` denies
to every sandboxed write. `git checkout` and `git switch` run outside it so their `ask` rule
applies in the desktop app. A call made only of those commands runs unsandboxed, under the ordinary
allow, ask, and deny rules. A pipe, or most other commands added to the call, keeps it sandboxed; a
leading `cd` was seen not to, so do not rely on it either way. A chained branch switch
(`make x && git switch y`) therefore stays sandboxed and may run without its prompt in the desktop app.
`roborepo plans show <id> --json | grep synchronized` cannot lock the plans store and reports
`"synchronized": false`. Run plans commands on their own.

Codex always sandboxes its commands, so `sandbox-shell`, `reach-allowed-hosts`, and
`reach-claude-log-upload` are Claude-only. Enforcement was verified on
macOS with Claude Code 2.1.309 through `claude -p`; Linux and Windows are unverified. A local
`.claude/settings.local.json` can add entries, since Claude merges sandbox lists across settings
files; RoboRepo replaces the `sandbox` key in `~/.claude/settings.json` on every render.

### Changing path scopes

Two different questions decide whether a file access prompts, and they are answered at different
times:

| Question | Resolved | Mechanism |
| --- | --- | --- |
| Which fixed directories are quiet? | Render time | Path allowlist in the manifest |
| Is this path in the current repository? | **Tool-call time** | `repo-scope` behavior, per provider |

For Claude, the repository zone is **wider for reads than for writes**, deliberately:

| | Reads | Writes |
| --- | --- | --- |
| The checkout in use | quiet | quiet |
| Its primary checkout and sibling worktrees | quiet | **prompt** |
| Anywhere else | prompt | prompt |

Reading `main` from a worktree to compare against it is routine and harmless, so reads span the
whole repository family. Writing across checkouts is rare and is how one session overwrites another's
in-flight work, so writes stay inside the checkout in use and prompt anywhere else.

Codex enforces only the write half of this table. Every Codex profile that can write also gets
the agent scratch folder, `~/.roborepo/scratch`. If a repository's `plans/plans-config.json` sets
`"worktreeRoot": "~/.worktrees"`, Codex also gets write access to that repository's worktree folder,
`~/.worktrees/<worktreeRepoName>` — not to all of `~/.worktrees` — and to the exact paths in the
repository's Git directory that a plans commit writes: its objects, the plans worktree's
administrative folder, and the plans branch's refs. It does not get `hooks/`, `config`, or other
branches. A repository using Git's reftable ref format isn't covered by those paths, so Codex can't
save plans there. These are filled in when `roborepo config apply` or `roborepo update` runs from inside the repository, or when you change
a permission.

Changes to the fixed path allowlist take effect after the next render (`roborepo update`, or a
permission change in the panel); the repository boundary is checked on every tool call, so it needs
no render.

## Required Rules

- Permission rows must use only `deny`, `ask`, `allow`, or `default`. There is no looser-profile
  confirmation because each behavior is independently reversible.
- Mutations write live config only; the repo template under `globals/` is never touched
  by the panel.
- Disabling a composite package leaves its shared included packages in place — disabling
  them could break other enabled packages.

## Edge Cases

- **Plugin enable cannot fetch.** Enabling a `plugin` package writes the marketplace
  entry and the `enabledPlugins` bool, but the harness performs the actual download on
  its next launch. A freshly enabled plugin shows as enabled before it is installed.
- **Native skill collision.** If a real (native-installed) skill directory already
  occupies a skill name, the skill toggle skips it rather than overwriting. The inspect popup
  reports the collision and preserves native-only metadata such as `agents/openai.yaml`.
- **Missing harness home.** Permission writes only target harness homes that already exist. If no
  harness config is present, the mutation reports that nothing was written.
