---
id: fable-security-behavior-audit
priority: none
next_action:
blocked_by: []
depends_on: []
related: []
reviewed_commit:
---

# RoboRepo Audit — Security, UX, and Native-CLI Divergence

**Date:** 2026-07-03
**Scope:** In-depth read-only audit of the install pipeline, hooks, telemetry, CLI dispatch,
permission model, and uninstall. Focus areas: security vulnerabilities, UX failure points,
divergence between the native agent CLI and this wrapper, intuitiveness, and unnecessary surface.

**Nature:** This document locates problems and points at solution directions. It is not an
implementation plan — fixes are to be fleshed out in follow-up sessions.

Findings are grouped by focus area, most severe first within each group.

---

## Security vulnerabilities

### 1. The full `globals/claude/settings.json` is copied verbatim into every user's `~/.claude/settings.json`

**Where:** base bundle → `applyRow` (`scripts/cli/presets.mjs:523`) → `copyItem` →
`copyTree(globals/claude/settings.json → ~/.claude/settings.json)`. The manifest row is
`claude root_config globals/claude/settings.json settings.json`
(`manifests/platform/manifest.tsv:32`). On a clean machine (no pre-existing settings.json) the
file lands byte-for-byte.

The file currently ships:

- **`"skipDangerousModePermissionPrompt": true`** — suppresses the confirmation gate before
  bypass / dangerous permission mode, **globally, by default**. Single most dangerous line in the
  repo. Every install silently removes a guardrail.
- **A large project-specific `permissions.allow` list** that is one dev's local history, not a
  shared baseline: `Bash(kill:*)`, `Bash(supabase start:*)`, `Bash(docker builder prune -f:*)`,
  `Bash(/bin/zsh -lc npm run check > /tmp/sembrando-astro-check.log 2>&1:*)`, convex / playwright /
  pnpm specifics. Broad grants (`kill:*` especially) pushed to all machines and all repos.
- **`"model": "opus"`** — overrides the user's model choice everywhere.
- **`roborepoProfile: "globals/claude/settings.json"`** — self-referential nonsense value. The
  field elsewhere holds a *profile name*; here it is a repo path. Reads as a copy-paste stamp bug.

**Divergence from intent:** the design intent (write-guard hook, `settings.starter.json`) says root
config should be lean and machine-local. But the starter is `{"$schema": ...}` only
(`globals/claude/settings.starter.json`), and the base bundle applies the fat file, not the starter.
Intent and actual install diverge.

**Solution direction:** ship the permission surface through the profile/permissions renderer, keep
`settings.json` source minimal, and never ship `skipDangerousModePermissionPrompt` / `model` in the
shared baseline.

### 2. Loopback portal mutation endpoints have no CSRF protection

**Where:** `scripts/cli/portal-server.mjs`. Binds `127.0.0.1` (good), but the POST endpoints
(`/api/config/packages`, `/api/config/permissions`) accept any JSON body with no origin check or
token.

Any web page open in the user's browser can POST to `127.0.0.1:4317` while the portal runs and flip
packages or **loosen the permission profile** — the `confirmedLooser` gate is just a boolean in the
body the attacker controls (`portal-server.mjs:88`). Low likelihood (portal is short-lived,
detached), but a real DNS-rebinding / cross-origin write surface.

**Solution direction:** require a per-session token in a header, or validate `Origin` / `Host`.

### 3. `content_matches_repo_source` drives destructive uninstall via `cmp` / `diff -r`

**Where:** `scripts/install/uninstall.sh` `reclaim_link_target` does `rm -rf "${home_abs}"` on a
content match against repo source.

Not exploitable per se, but the "is this roborepo's copy, safe to `rm -rf`?" decision hinges on
byte-identity. If two unrelated files ever match the repo source (empty files, trivial configs),
user data is deleted.

**Solution direction:** guard that the path is under an expected harness dir before `rm -rf`.

---

## User-experience failure points

### 4. Telemetry capture is an O(n²) latency tax on every tool call

**Where:** `telemetryCapture` (`scripts/cli/telemetry.mjs`) runs on **PreToolUse *and* PostToolUse**
for every tool, calling `transcriptStats` (`scripts/cli/telemetry-transcript.mjs:13`) which **reads
and re-parses the entire transcript JSONL from scratch each time** (`raw.split("\n")` over the whole
file).

In a long session the transcript is megabytes; the whole thing is re-parsed on every tool call.
Compounding: each capture is a **cold `node` process** spawned via `roborepo telemetry capture`, and
`telemetry.mjs` statically imports `portal-server`, `config`, `config-mutate`, `presets`,
`telemetry-analyze`, `telemetry-insights` — so every capture pays the full import-graph parse cost
for a job that appends one JSONL line. Felt as sluggishness on every action once telemetry is on.

**Solution direction:** a lightweight capture entrypoint importing only what it needs; incremental
transcript reads (seek from last offset) instead of full re-parse.

### 5. Non-interactive install silently makes irreversible choices

**Where:** `scripts/install/main.sh:92`. When stdin isn't a TTY and no `--on-conflict` is set, it
defaults to `keep` and proceeds. Combined with the settings copy (finding 1), a CI/scripted install
lands the full opinionated config with no prompt. The `keep` default is the safe direction, but
silently applying a global model/permission override is surprising.

### 6. `head` / `cat` on a source file is blocked even for a one-line peek

**Where:** `globals/claude/hooks/block-source-exploration.mjs`. Denies `head -50 file.ts`,
`cat file.ts`, `grep pat src/x.ts`. `head` / `tail` with a line range is normal and cheap and
jcodemunch doesn't cleanly replace it. The block is well-guarded (pipes allowed, non-source allowed)
but the `head` / `tail` / `cat` inclusion over-reaches into legitimate quick reads.

---

## Native CLI ↔ wrapper divergence (counterproductive)

### 7. `block-source-exploration.mjs` redirects to jcodemunch even when jcodemunch isn't installed

**Where:** the hook is wired **unconditionally** in `globals/claude/settings.json`
(PreToolUse:Bash). But the Grep/Glob block and the jcodemunch tools come from the **jcodemunch
*package*, which is opt-in** (`globals/packages/jcodemunch/hooks-claude.json`).

A user who installs roborepo without enabling jcodemunch gets: Bash `cat`/`grep`/`head` on source
blocked → told "use jcodemunch search_text/search_symbols" → **those MCP tools don't exist on their
machine**. The agent is now worse off than vanilla Claude: can't grep, can't cat, and the suggested
alternative is absent. The unconditional hook and the conditional package are misaligned.

**Solution direction:** gate `block-source-exploration.mjs` on jcodemunch being enabled, or ship it
only when the package is on.

### 8. Grep/Glob block uses `continue:false`, which halts the whole turn

**Where:** `globals/packages/jcodemunch/hooks-claude.json` returns
`{"continue": false, "stopReason": ...}`. `continue:false` stops the agent, not just the tool —
heavier than `permissionDecision:"deny"` (which blocks the call and lets the agent adapt). Native
Claude leans on Grep constantly; a hard turn-halt on Grep is a jarring divergence.

**Solution direction:** use `deny` with a redirect reason instead of `continue:false`.

### 9. `model: opus` + caveman plugin are forced globally

A user who prefers Sonnet, or who never wanted caveman mode, gets both on every repo after install
with no per-install opt-out surfaced. The wrapper overrides native defaults the user didn't ask to
change. (See finding 1 for the `model` line; caveman comes from `enabledPlugins` in
`globals/claude/settings.json`.)

---

## What could be more intuitive

- **`settings.json` mixes three concerns** (shared baseline, one dev's project allowlist, personal
  preferences like model). Splitting "baseline vs. personal" would make it obvious what's safe to
  share. Currently you can't tell by looking.
- **`roborepoProfile` field holding a file path** (finding 1) reads as a bug to anyone inspecting
  their installed config.
- **Two hand-rolled conflict prompt loops** — `main.sh` (top-level adopt policy) and
  `install-lib.sh` `choose_path_conflict_action` (per-path) — with near-identical copy. A reader
  hits "didn't I already answer this?" Consolidating would reduce confusion.
- **Telemetry's cost isn't disclosed at enable time.** "Turn on token capture" reads as free
  observation; it's a per-tool-call overhead. A one-line note at `telemetry enable` would set
  expectations.

---

## What is unnecessary / over-built

- **Web portal + telemetry-insights + LLM synthesis** (`/api/insights-llm` shells out to
  `claude -p`) is a large surface (`portal-server`, `telemetry-analyze` ~514 lines,
  `telemetry-insights`, `telemetry-seed-demo`, config dashboard, two HTML pages) for what a
  harness-config tool needs. Biggest maintenance/attack surface in the repo and least core to "keep
  Claude+Codex config aligned." Worth asking whether it earns its keep.
- **`capture-dense-bash.mjs`** writes a forever-growing `~/.claude/logs/dense-bash.jsonl` to "mine
  patterns later." Pure data collection with no consumer wired up. Dead-weight I/O on every
  multi-line Bash call. If nothing reads it, cut it.
- **`telemetry-seed-demo.mjs` (~242 lines)** ships in the install tree.
- **`is_roborepo_authored` marker regex duplicated in 3+ places** (`install-lib.sh`,
  `uninstall.sh`, `presets.mjs`) with a "keep both in sync" comment — a drift trap. One source of
  truth would remove a class of future bug.

---

## Recommended fix order

1. **Finding 1** — stop shipping `skipDangerousModePermissionPrompt` / `kill:*` / personal allowlist
   / `model:opus` in the global baseline.
2. **Finding 4** — the telemetry per-tool-call full-transcript re-parse + cold-node cost.
3. **Finding 7** — the unconditional jcodemunch redirect that fires without jcodemunch present.

---

## Verification

Read-only audit. No commands run against live config. Findings traced through source:

- `scripts/cli/presets.mjs` copy path (`applyRow` → `copyItem` → `copyTree`)
- `scripts/cli/telemetry-transcript.mjs` full re-parse (`transcriptStats`)
- `globals/claude/settings.json` contents
- Hook wiring: `globals/claude/settings.json` (unconditional) vs
  `globals/packages/jcodemunch/hooks-claude.json` (conditional)
- `scripts/install/main.sh`, `install-lib.sh`, `uninstall.sh` install/reclaim logic
