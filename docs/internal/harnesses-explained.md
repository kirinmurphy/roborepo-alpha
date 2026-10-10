# How the Harnesses Work, and Why Parity Takes the Shape It Does

This is the teaching doc. It assumes you know neither Claude Code nor Codex deeply. It explains what
a "harness" is, how the same behavior is expressed _differently_ on each one, and why we reach for a
different parity mechanism for each kind of configuration — from "do almost nothing" to "give up on
automation entirely, on purpose."

This doc is the **why**. It does not list the commands you run — that is the job of the
[Harness Anatomy](harness-anatomy.md) reference table, which has one row per element with its source
location and its exact `roborepo` command. Read this first for the concepts; go there to actually
change something.

## What a harness is

A _harness_ is the program that runs an AI coding agent on your machine — it loads instructions,
exposes tools, runs the model, and reacts to events. This repo configures three of them:

- **Claude Code** — reads its config from `~/.claude/`.
- **Codex** — reads its config from `~/.codex/` (and global skills from `~/.codex/skills/`).
- **Gemini CLI** — reads its config from `~/.gemini/` (`settings.json` for root config/hooks/MCP,
  a `policies/` directory of TOML files for permissions).

They do the same _kind_ of thing but disagree on file names, file formats, and which directory they
scan. That disagreement is the entire reason this repo exists: we want to write a behavior **once**
and have every harness pick it up. The repo is the source of truth; every harness home directory
is downstream of it (mostly via symlinks — see [How It Works](../user/reference/architecture.md) for the
filesystem mechanics). Adding a harness means adding a provider to the registry
(`scripts/harnesses/registry.mjs`) that implements the same adapter contract described below —
Gemini CLI is the first one added after Claude and Codex, and its addition is what confirms the
steps below generalize past two.

## The shape of the problem

Every piece of harness configuration is the same story told twice — once in Claude's dialect, once in
Codex's. How _far apart_ the two tellings are decides how much work it takes to keep them in sync.
Two harnesses can disagree on any of four things:

- **Name** — `CLAUDE.md` vs `AGENTS.md` for the same always-on rules file.
- **Format** — JSON for Claude, TOML for Codex.
- **Location** — which directory the harness scans.
- **Semantics** — the deeper one: not just where the config lives but what it _means_. A hook that
  prints JSON the harness obeys is a different thing from a hook that prints text the harness shows.

When two harnesses differ only on name or location, bridging them is cheap. When they differ on
semantics, no amount of file shuffling will help — the behavior has to be expressed twice, by hand.

So the rest of this doc walks the configuration elements in order of **how much machinery it takes to
keep them in parity** — from the case where the harnesses already agree, up to the case where we
decide parity isn't even the goal. Each step adds exactly as much mechanism as the divergence
demands, and no more.

Here is the whole story on one page, scored against the four axes. The more boxes that differ — and
especially if **semantics** differs — the more (or different) machinery parity needs. Scored across
all three harnesses — a row is ✅ only when Claude, Codex, _and_ Gemini all agree:

| Element | Name | Format | Location | Semantics | → Resolution |
| --- | :---: | :---: | :---: | :---: | --- |
| Slash commands | ✅ | ❌ | ❌ | ✅ | Stamp a copy |
| Global rules | ❌ | ✅ | ❌ | ✅ | Generator |
| Permissions | ❌ | ❌ | ❌ | ✅ | Generator (per-harness output shape) |
| Skills | ✅ | ✅ | ❌ | ✅ | Symlink |
| MCP servers | ❌ | ❌ | ❌ | ✅ | One front-door command |
| Hooks | ❌ | ❌ | ❌ | **❌** | Author twice, by hand |
| Root config | ❌ | ❌ | ❌ | ❌ | No parity, on purpose |

✅ = every harness agrees on this axis, ❌ = at least one differs. Slash commands drop to ❌ on
**format** with Gemini in the picture: Claude and Codex both scan Markdown, but Gemini's are TOML —
the first axis where adding a third harness actually changes a row's score, not just its resolution.
(The renderer hasn't been extended to emit TOML yet — see the take on that gap in
[Step 1](#step-1--when-they-already-agree-slash-commands) below.) Note the jump at hooks: every other
element agrees on **semantics** (a rule means the same thing on every side, only the wrapping
differs), so a generator or a link can bridge it. Hooks are the first where the _meaning_ itself
diverges — which is exactly why automation stops there. Root config differs on everything too, but
for the opposite reason: there, difference is the point.

The rest of the doc walks these rows top to bottom, one section each.

### The same story in each harness's own words

The axis table above is abstract. Here is what each harness concretely expects for the same element —
the Claude-vs-Codex-vs-Gemini matrix. This is the "what the native side wants" companion to the "why
the tool is what it is" prose below:

| Element | What Claude expects | What Codex expects | What Gemini expects |
| --- | --- | --- | --- |
| Rules | `~/.claude/CLAUDE.md`, one always-on markdown file | `~/.codex/AGENTS.md`, same intent, different name + house style | `~/.gemini/GEMINI.md`, same intent again — capability still stubbed, no renderer branch yet |
| Root config | `~/.claude/settings.json` — permissions, hooks, MCP, plugin toggles in one JSON object | `~/.codex/config.toml` — TOML defaults, some behavior in separate files/runtime hooks | `~/.gemini/settings.json` — plain JSON object, closely shaped like Claude's (hooks and `mcpServers` as nested keys), merges with the same recursive-object-merge rule as Claude's settings.json rather than a re-port |
| Permissions | `permissions.allow` / `deny` / `ask` arrays in `settings.json` (real 3-state `ask`) | `approval_policy` / `sandbox_mode` / `network_access` in `config.toml` + rules-layer allow/deny; per-command `ask` only via a runtime hook | Policy Engine: a directory of `*.toml` files under `~/.gemini/policies/`, each `[[rule]]` block carrying a real native `allow`/`deny`/`ask_user` decision — no approximation or session-wide fallback needed |
| Skills / commands | Skills + `commands/` under `~/.claude/` | Same structure under `~/.codex/` home paths | Skills stubbed; slash commands are TOML, not Markdown — the existing renderer can't target Gemini's commands directory yet |
| MCP servers | Registration in native config + tool registry, plus matching permission entries | Entries in TOML config, own native registry shape | `mcpServers` key inside `settings.json`, direct JSON read/write — no CLI shell-out needed, unlike Claude |
| Plugins | `enabledPlugins` + `extraKnownMarketplaces` in `settings.json`, installed natively next launch | Own plugin/marketplace commands + native config; choice survives runs, harness installs later | Not yet modeled for this harness |
| Hooks | Wiring in `settings.json`, `.mjs` bodies; JSON control output the harness _obeys_ | Wiring in `hooks.json`, `.mjs` bodies; output read as plain text to _show_ | Wiring nested under `settings.json`'s `hooks` key, same location as Claude's — bulk read/write still stubbed |

For how each of these survives an install/update — backups, drift detection, per-element persistence —
see [Config Collision Handling](../user/reference/config-collision-handling.md#per-element-persistence). For the source
location and exact command per element, see
[Harness Anatomy](harness-anatomy.md#elements-at-a-glance).

---

## Step 1 — When they already agree: slash commands

A _slash command_ is a workflow the **user** starts on purpose by typing `/case-study` or
`/plan-write`. It's the easiest case because Claude and Codex happen to agree on almost
everything: both scan a `commands/` directory of Markdown files, same format, same idea. The only
gap between them is location (`~/.claude/commands/` vs `~/.codex/commands/`).

Because the gap is so small, parity barely needs a mechanism. We keep one list of commands and stamp
a copy into each directory. There's nothing to reconcile — the two outputs are the same file in two
places.

Gemini breaks the "already agree" premise: its slash commands are TOML, not Markdown. The stamp-a-copy
mechanism assumes the source and every target share one format — it has nothing to convert with.
Rather than force a wrong-format file into Gemini's commands directory, the renderer simply doesn't
target Gemini yet (`commands.render` stays stubbed in its adapter). This is a real scope gap, not a
parity choice: closing it needs the renderer to gain a second output format, not just a second output
path — different work from every other gap in this doc, all of which are name/location differences
the existing single-format renderer already handles.

> Takeaway: when harnesses already agree on format and meaning, parity is almost free — but "already
> agree" is an assumption to check per harness, not a property of the element itself. A third harness
> can fail an assumption the first two happened to share.

---

## Step 2 — Bridging a cosmetic gap: global rules

_Global rules_ are the always-on instructions a harness loads at the very start of every session —
the agent's standing behavior, like tone, how it explores code, how it verifies its work. Claude
reads them from `CLAUDE.md`; Codex reads them from `AGENTS.md`.

The only real difference is the **name**. Both are plain Markdown saying the same thing. But we still
don't write the two files by hand — and the reason is a lesson that recurs everywhere below: _the
behavior is the source of truth, not the file._

The real source is a set of small, harness-agnostic fragments — one per behavior (communication,
exploration, verification, and so on). A fragment is just the rule, with no idea which harness it's
bound for:

```markdown
## Communication

Use caveman full by default. Terse, no filler, fragments OK.

Switch to normal mode only when the user explicitly says `normal mode` or `stop caveman`.
```

A renderer concatenates the fragments into each target file and stamps a do-not-edit header so nobody
hand-edits the output:

```markdown
# Generated Harness Rules

Generated from `globals/system/rules/shared/` and harness-specific `globals/system/rules/<harness>/` fragments.
Do not edit this file directly; edit rule fragments and run `./scripts/build/render-rules.sh`.
```

One fragment edit regenerates **both** files identically. That is parity by generation, and it costs
us exactly one small generator to bridge a difference that is only skin-deep.

> Takeaway: even a trivial difference is worth a generator, because it makes "the behavior" — not the
> per-harness file — the thing you edit.

---

## Step 3 — Bridging a structural gap: permissions

_Permissions_ are the allow/deny lists that say what the agent may do without stopping to ask —
which shell commands, which tools, which external calls — plus session defaults like sandboxing.

Here the harnesses diverge harder. It's no longer just a name:

- Claude expresses permissions as a JSON array of tool matchers inside `settings.json`, with a
  real third `ask` state alongside allow/deny.
- Codex expresses them as TOML session defaults (`approval_policy`, `default_permissions`, a named
  permission profile, workspace roots, and network setting) _plus_ a separate binary
  (`forbidden`/`allow`-only) command-policy rules file — no native `ask` tier at the rules layer.

Different **format**, different **structure**, and — this is the interesting part — different
**expressiveness**. Yet the principle from Step 2 carries straight over: author the intent once, as
a flat list of named/arbitrary behaviors in a neutral data file, then _render_ it into each
harness's native shape. The renderer owns a clearly marked block in each output and leaves the
rest of the file alone:

```toml
# BEGIN GENERATED AGENT PERMISSIONS
# Source: manifests/inventory/agent-permissions.json
approval_policy = "on-request"
sandbox_mode = "workspace-write"
default_permissions = "managed-workspace"

[permissions.managed-workspace]
extends = ":workspace"

[permissions.managed-workspace.workspace_roots]
"~/.worktrees/roborepo" = true

[permissions.managed-workspace.network]
enabled = false
# END GENERATED AGENT PERMISSIONS
```

The mechanism is the same as global rules — one source, a renderer per target — even though the two
outputs look nothing alike. That's the point: a bigger structural gap doesn't need a _different kind_
of solution, just a renderer that knows two output shapes instead of one.

Where the gap doesn't fully close: an `ask`-bucket entry has nowhere to go in Codex's rules file
(binary forbidden/allow only), so the renderer must omit it there and fall back to a session-wide
`approval_policy` — a real asymmetry the render step can't paper over on its own. Closing THAT gap
took a different tool entirely: a runtime hook (`globals/system/hooks/codex/permission-check.mjs`) that
re-checks each shell command against the same source data and emits a genuine per-command `ask`
decision — confirmed possible only after reverse-engineering the shipped Codex binary's wire schema,
since Codex's hook protocol turned out to support a 3-state `permissionDecision` (`allow`/`deny`/`ask`)
that its config-file rules format does not expose. Lesson: a structural gap between two harnesses
isn't always closable by rendering alone — sometimes the target's *capability* is narrower in one
layer (config files) than another (hooks), and finding that requires checking past the documented
surface.

Gemini adds a third shape, and it's the interesting one: rather than a single settings file with a
generated block, Gemini's Policy Engine loads **every** `*.toml` file inside `~/.gemini/policies/`
and combines their rules. So the renderer doesn't need a marked-block-inside-a-shared-file merge at
all — it owns one whole file, `generated-permissions.toml`, and fully regenerates it on every render.
Anything else a user drops in that directory is simply another file the engine also loads, never
touched by roborepo. That's a fourth parity shape this doc hadn't needed yet: not "generate a block
inside a file you don't fully own" (Codex) and not "generate the file whole because it's the only
thing there" (Claude's simpler case) — "generate one whole file among siblings you don't control."
Each behavior/command in the manifest maps to exactly one `[[rule]]` block, and Gemini's decision
field is natively 3-state (`allow`/`deny`/`ask_user`) — the first of the three providers where `ask`
needs no Codex-style runtime-hook workaround; the config layer already expresses it.

> Takeaway: format and structure can differ wildly and a single source-plus-renderer still wins,
> as long as the _meaning_ is the same on both sides. A third harness can still introduce a genuinely
> new *ownership* shape — not just a new format — even after two harnesses have already exercised the
> "structural gap" case.

---

## Step 4 — When the files are identical but live apart: skills

A _skill_ is a bundle of instructions the agent loads only when a task matches it (`react`,
`code-style`, and so on). Each skill is a folder with a `SKILL.md`.

Skills are interesting because the content is **byte-for-byte identical** across harnesses — the only
thing that differs is **location**: Claude scans one directory, Codex scans another. When the files
are the same and only the path differs, generating a copy would be wasteful and would invite the two
copies to drift. So instead of rendering, we **symlink**: one canonical skill folder, with each
harness's expected directory pointed at it.

This is the first time the mechanism _changes_ rather than just scaling up. Rules and permissions
needed a renderer because the outputs genuinely differ. Skills don't — so a link, not a generator, is
the honest tool. Gemini's skill directory (`~/.gemini/skills/`) would fit the same symlink model — the
gap is location-only there too — but `skills.link` stays stubbed for Gemini for now, so the link isn't
wired up yet. No new mechanism would be needed to close it; it just hasn't been done.

> Takeaway: match the mechanism to the gap. A location-only difference wants a symlink, not a
> renderer — same parity goal, lighter tool.

---

## Step 5 — When rendering doesn't fit: MCP servers

An _MCP server_ is an external tool the agent can call — `jcodemunch` for code search, `jdocmunch`
for docs. Registering one isn't editing a file you can re-render at will; it's an _action_ that mutates
each harness's tool registry, and on Claude it also requires adding matching permission entries before
the agent will call the tool without prompting.

There's no clean single source file to render from, because the thing being kept in parity is a
_registration_, not a document. So parity moves from a render step to a **single front-door
command**: one command registers the server with every enabled harness and adds the Claude permissions
in the same motion. The guarantee is the same — do it once, every side agrees — but it's enforced
imperatively, by making the easy path the correct path, rather than declaratively by a generator.

Gemini slots into this command cleanly, and it's actually the simplest of the three: Claude's registry
write goes through the `claude mcp add` CLI (a subprocess call), Codex's is a hand-built TOML block,
but Gemini has a real JSON config file with an `mcpServers` key sitting right there — `roborepo mcp
add` reads and writes it directly, no shell-out, no block-marker bookkeeping. Same front-door command,
one more direct native shape underneath it.

> Takeaway: when the thing isn't a file, parity-by-rendering stops fitting. A single command that
> touches every harness at once keeps the "author once" promise without a source-of-truth document.

---

## Step 6 — When automation gives up: hooks

A _hook_ is a shell command the harness runs when something happens — a session starts, a tool is
about to run. Hooks can print a message into the session or block a tool outright. This is the
element where the two harnesses diverge the **most**, and the first one where we stop trying to
automate parity at all.

The divergence is on every axis at once — name, format, _and semantics_:

- **Claude** wires hooks inside `settings.json`, and a hook influences the session by printing a
  JSON control object the harness _obeys_:

  ```jsonc
  {"continue": false, "stopReason": "Grep and Glob are blocked. Use jcodemunch tools instead."}
  ```

- **Codex** declares hooks in a _separate_ `hooks.json`, with its own fields (like `statusMessage`),
  and reads a hook's output as **plain text to show**, not a control protocol to obey.

That last difference is the killer. It's not that the files are shaped differently — we solved
shaped-differently back in Step 3. It's that the _meaning_ of a hook's output is different: one
harness interprets it, the other displays it. There is no neutral source that renders cleanly into
both, because there is no shared notion of what a hook even _emits_.

So we don't render. A hook wanted on every harness is authored **once per harness**, in that
harness's own terms. This is the deliberate exception to the author-once rule, and the element most
likely to fall out of sync. Honest duplication beats a generator that would have to paper over a
genuine semantic difference.

Gemini nests its hook wiring inside `settings.json`'s `hooks` key — same file, same location as
Claude's, unlike Codex's separate `hooks.json` — but that's a location coincidence, not a semantics
one; whether Gemini's hook output is *obeyed* or merely *shown* isn't settled here, because bulk
`hooks.read`/`hooks.write` are still stubbed for all three providers. The merge logic
(`mergeHooksMap`/`unmergeHooksMap`) is shared with Claude's since the entry shape lines up, but no
hook has been authored for Gemini yet to prove the semantics out.

> Takeaway: when the harnesses disagree on _meaning_, not just shape, no generator can bridge them.
> Duplicating by hand and knowing it is more honest than a leaky abstraction.

---

## Step 7 — When parity isn't the goal: root config

_Root config_ is the mutable, machine-local layer — model choice, reasoning effort, trust settings,
hook approvals, enabled plugins. Claude keeps it in `settings.json`, Codex in `config.toml`, Gemini
in its own `settings.json`.

This is the one element where we **don't** force parity, and it's not because it's too hard — it's
because parity would be _wrong_. These settings are legitimately per-machine. Forcing every machine
to the same model or the same trust state would defeat the purpose.

So root config inverts the whole pattern. The repo keeps a _baseline_, but the active home file is a
local copy the user is free to diverge. On install, if a local file already exists, the installer
keeps it and prints merge guidance rather than clobbering machine-specific trust and approvals.
Gemini's merge step reuses Claude's recursive-object-merge rule directly rather than a re-port — its
settings.json is close enough in shape (a plain JSON object, `hooks` and `mcpServers` as nested keys)
that the same function serves both. That's the same "share the mechanism where the shape genuinely
matches" principle Step 4 (skills) made with a symlink, just showing up again one layer lower, inside
a per-harness renderer instead of at the file-location layer.

> Takeaway: parity is a means, not an end. When per-machine difference is the _correct_ behavior, the
> right amount of parity machinery is none.

---

## The pattern underneath

Read top to bottom, the seven steps trace a single decision: **spend exactly as much parity machinery
as the divergence demands, and not a drop more.**

| The harnesses differ on… | Right tool | Element |
| --- | --- | --- |
| Almost nothing (until a harness disagrees on format too) | Stamp a copy — or a real gap if it can't | Slash commands |
| Name only | A generator | Global rules |
| Format and structure | A generator (one output shape per harness) | Permissions |
| Location only | A symlink | Skills |
| It's an action, not a file | One front-door command | MCP servers |
| Meaning itself | Author twice, by hand | Hooks |
| Nothing _should_ match | No parity at all | Root config |

The throughline isn't "automate everything." It's: the per-harness files are build artifacts, not
source, _wherever a clean source exists_ — and where one doesn't (hooks) or shouldn't (root config),
say so out loud instead of forcing it. The two exceptions are exceptions precisely because their
semantics or their mutability make a shared generator a worse fit than honest duplication.

For the lookup table of every element, its source location, and the exact command to change it, see
[Harness Anatomy](harness-anatomy.md). For the filesystem and symlink mechanics underneath, see
[How It Works](../user/reference/architecture.md).
