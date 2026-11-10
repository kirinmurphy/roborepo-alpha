---
id: primary-todo
priority: none
next_action:
blocked_by: []
depends_on: []
related: []
reviewed_commit:
---

# Primary Todo

> Status: completed / retired. The root managed-block work, live `/config` behavior,
> and shared-skill cache/symlink model shipped. Remaining work moved to the dedicated
> active plans.

## Purpose

This is the short, current queue for the next roborepo work. It pulls together
the last-commit review findings, the open plan docs, and new install/config-panel
friction observed during setup.

Use this as the first triage doc before choosing from the larger planning backlog.

## Direct Answers To Current Questions

### Skill copies vs source and symlinks

Current answer: roborepo-owned skills should have one source of truth in
`globals/agents/skills/<name>/`. The harness folders are runtime materialization:
`~/.claude/skills/<name>` and `~/.codex/skills/<name>`.

The current implementation uses a machine-local cache plus symlinked harness views.
That still protects users who create their own native skill folder in
`~/.claude/skills` or `~/.codex/skills`: if the folder does not point at the
roborepo cache, roborepo should treat it as user-owned and skip it.

Decision to revisit: whether managed runtime copies are still the best model, or
whether roborepo should instead create a clearly named managed folder and symlink
from each harness. If symlinks return, they must not overwrite a user-owned native
skill of the same name, and must still work when the checkout moves or is
uninstalled.

### Root rules import instead of full-file ownership

Current answer: do not pursue root imports for both harnesses. Claude supports
imports from `CLAUDE.md`, but Codex does not have a reliable documented import
system inside `AGENTS.md`.

Move forward with managed block injection instead. Roborepo owns only explicit
managed blocks and preserves all content outside them:

```md
<!-- BEGIN managed:roborepo-code-style -->
...Roborepo default rules...
<!-- END managed:roborepo-code-style -->
```

Repo installs should always update `./AGENTS.md`, create it when missing, and
inject inline Roborepo rules into that managed block. If `./AGENTS.override.md`
already exists, update the same managed block there too, because Codex prefers
the override and ignores same-directory `AGENTS.md`. Do not create
`AGENTS.override.md`; creating it would change Codex precedence for the repo.

Repo installs should also create or update `./CLAUDE.md` with a separate managed
import block that always imports `AGENTS.md`:

```md
<!-- BEGIN managed:roborepo-agents-import -->
@AGENTS.md
<!-- END managed:roborepo-agents-import -->
```

Claude should not import `AGENTS.override.md`; that file is Codex-specific
override behavior. The intended paths are:

```txt
Claude -> CLAUDE.md -> AGENTS.md
Codex  -> AGENTS.override.md if present, otherwise AGENTS.md
```

Global installs render harness-specific rules inline. Claude gets inline rules in
`~/.claude/CLAUDE.md`; Codex gets inline rules in `~/.codex/AGENTS.md`, plus
`~/.codex/AGENTS.override.md` only if that override already exists.

The managed block is the safety layer. The existing override file rule is the
compatibility layer. Install, update, and uninstall must be boring,
idempotent, and reversible.

### Web portal submit behavior

Current answer: there is no submit button. Toggles apply immediately.

When a toggle changes, the browser posts `{ id, enabled }` to the local server:

- packages: `/api/config/packages`
- skills: `/api/config/skills`

The server mutates the config and returns a fresh snapshot. The browser re-renders
from that snapshot. The UI should make this explicit with "toggles apply
immediately" copy and visible per-toggle progress/result state.

### Circles beside packages

Current answer: the circles are status dots. For package/skill rows they currently
reflect the same `active` value as the toggle, so they are mostly duplicate UI.

They do not currently encode a separate concept like "installed on disk" vs
"enabled in config" vs "pending restart". Either remove them where a toggle is
present, or make them show a genuinely distinct state.

## Priority Queue

### 1. Inject root guidance with managed blocks

Current rendered rules write the full generated guidance into:

- `~/.claude/CLAUDE.md`
- `~/.codex/AGENTS.md`

That makes install, update, and uninstall responsible for preserving a user's
default root guidance. The safer target is managed block injection:

1. Render Roborepo default rules from one source file inside the project/package.
2. Inline those rules into Codex-visible managed blocks.
3. Use Claude imports only where Claude supports them.
4. Remove only Roborepo managed blocks during uninstall.
5. Leave all other user-authored root guidance untouched.

Managed markers:

```md
<!-- BEGIN managed:roborepo-code-style -->
...
<!-- END managed:roborepo-code-style -->
```

```md
<!-- BEGIN managed:roborepo-agents-import -->
@AGENTS.md
<!-- END managed:roborepo-agents-import -->
```

Why this is first:

- It removes most backup/restore risk around user guidance files.
- It makes package rule toggles replace only roborepo-owned managed blocks.
- It gives `doctor`, `update`, and uninstall a smaller ownership surface.

Repo install target behavior:

- Always create or update `./AGENTS.md` with inline Roborepo rules.
- Never create `./AGENTS.override.md`.
- If `./AGENTS.override.md` already exists, inject the same inline Roborepo rules
  there because it shadows `AGENTS.md` for Codex.
- Always create or update `./CLAUDE.md` with the `@AGENTS.md` managed import
  block.
- Never make Claude import `AGENTS.override.md`.

Global install target behavior:

- Create or update `~/.claude/CLAUDE.md` with inline Roborepo rules.
- Create or update `~/.codex/AGENTS.md` with inline Roborepo rules.
- If `~/.codex/AGENTS.override.md` already exists, inject the same inline
  Roborepo rules there.
- Do not create `~/.codex/AGENTS.override.md`.

Managed block algorithm:

1. Ensure the parent directory exists.
2. Create the target file if it does not exist.
3. Read the file.
4. If neither marker exists, prepend the new managed block at the top.
5. If both markers exist, replace the old managed block with the new one.
6. If only one marker exists, stop with an error and do not modify the file.
7. Preserve all content outside the block.
8. Keep clean spacing between the block and user content.

Broken marker error:

```txt
Found an incomplete Roborepo managed block in AGENTS.md.

I cannot safely determine which content is Roborepo-owned and which content is user-owned.

Please edit the file manually, then rerun the installer.
```

Implementation checklist:

- Decide whether to extend `rendered_rules` or add a new manifest kind for
  managed root guidance blocks.
- Add root-file managed block insertion/replacement/removal helpers with exact
  begin/end markers.
- Update repo install to touch `AGENTS.md`, `CLAUDE.md`, and only an existing
  `AGENTS.override.md`.
- Update global install to touch `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, and
  only an existing `~/.codex/AGENTS.override.md`.
- Make update replace existing Roborepo blocks and preserve surrounding user
  content.
- Make uninstall remove only Roborepo managed blocks and leave files in place by
  default, even if empty.
- Fail safely when only one managed marker exists.
- Update `scripts/build/render-rules.sh`, `scripts/cli/presets.mjs`,
  `scripts/install/uninstall.sh`, `scripts/doctor.sh`, and the update report to
  understand the new ownership model.
- Add install/update/uninstall tests for user-authored root files, existing
  override files, missing override files, and broken managed markers.

Success criteria:

- A user can have arbitrary custom text in repo or global instruction files.
- Install adds only Roborepo managed blocks.
- Update changes only Roborepo managed blocks.
- Uninstall removes only Roborepo managed blocks.
- `AGENTS.override.md` is respected when already present and never created as the
  default install mechanism.
- Claude and Codex both receive the same Roborepo rules through their native
  reliable path.
- No pre-install backup is needed for normal root guidance changes.

### 2. Fix shared skill materialization and user-edit story

Recent install work copies managed shared skills into both native harness skill
folders. That is correct for harness discovery, but the model needs a clearer
source/edit boundary.

Current intended source:

- Source of truth: `globals/agents/skills/<name>/`
- Managed harness copies: `~/.claude/skills/<name>` and
  `~/.codex/skills/<name>`
- User-owned native skills: any skill folder in a harness home that does not
  carry `.roborepo-managed`

Problems to resolve:

- Fresh install and repair currently materialize only `roborepo-support`.
  Several active helper skills in `manifests/inventory/skill-invocation.json`
  can be missing from fresh installs.
- Copying every shared skill into both harness homes is noisy in install logs and
  looks like duplication without explaining the source-of-truth rule.
- Users need a clear way to edit their own native skill without roborepo
  overwriting it.

Target behavior:

1. Keep repo source canonical for roborepo-owned shared skills.
2. Keep harness-native folders as runtime materialization targets.
3. Never overwrite a user-owned native skill folder of the same name.
4. Expose which skills are managed, installed, skipped due to native collision,
   or unavailable.
5. Decide whether optional skills should be installed by default, package-gated,
   or command-gated.

Implementation checklist:

- Decide the default installed skill set: all low-risk helpers, support-only plus
  package toggles, or explicit bundles.
- If support-only remains, add package/bundle entries for every skill that the
  config panel can toggle.
- If all helpers install by default, update repair tests and install logs to call
  them cache-backed views and explain user-owned native skill folders are skipped.
- Add a `roborepo skill status` view that reports source, harness copy, managed
  marker, and native collision.
- Add tests for native skill collision in both harnesses.

Success criteria:

- The config panel does not advertise a skill that cannot be installed.
- Fresh install gives the advertised default helper behavior.
- A user-created `~/.claude/skills/foo` or `~/.codex/skills/foo` is never
  overwritten unless it carries `.roborepo-managed`.

### 3. Make config-panel writes explicit and legible

The web config panel currently has no submit button. Toggles are automatic:

- The client sends a POST as soon as a toggle changes.
- Package toggles post to `/api/config/packages`.
- Skill toggles post to `/api/config/skills`.
- The server mutates state and returns a fresh config snapshot.
- The client re-renders from that snapshot.

The circles to the left of package/skill rows are status dots. They reflect the
same `active` value that drives the toggle state. Today they do not communicate
anything materially different from the toggle.

Problems to resolve:

- No visible "auto-save" affordance, so users may look for a submit button.
- Status dots duplicate toggle state without explaining installed vs enabled vs
  pending-restart.
- Some packages have multi-step effects: rules render immediately, hooks/settings
  mutate immediately, plugin changes may take effect on next harness launch, and
  telemetry capture state changes separately from the portal server.

Target behavior:

1. Show a small "changes apply immediately" label near mutable sections.
2. Rename or tooltip the dot as "enabled" / "disabled", or remove it where the
   toggle already carries the same meaning.
3. Distinguish states when they are real:
   - enabled
   - installed
   - pending restart
   - skipped due to native user-owned skill
   - failed to apply
4. Show per-toggle progress and final result after POST.

Implementation checklist:

- Add status text or tooltip next to each toggle.
- Add copy near the panel header: "Toggles apply immediately."
- Use separate UI states when `mutatePackage` or `setSkillInstalled` returns
  skip/pending details.
- Revisit the left dot. Either remove it or make it encode a different state
  than the switch.

Success criteria:

- Users understand no submit button is needed.
- The panel distinguishes "currently active" from "installed on disk" when those
  differ.
- Package and skill rows explain delayed activation when a restart is required.

### 4. Harden ownership detection and update reporting

Last-commit review found smaller correctness and DX issues:

- `isRoborepoAuthored` should not treat any file containing
  `# Generated Harness Rules` as roborepo-owned. It should check the render
  header at the start of the file, like `isRenderedRulesOutput`.
- Uninstall package stripping can remove permissions that the user had before
  roborepo if they match package permissions. Prefer ownership markers or a
  narrower poisoned-backup cleanup path.
- The update report can double-count the same paths as root config and
  permissions. Make report groups reflect distinct ownership surfaces.

Implementation checklist:

- Replace broad rendered-rule regex checks with start-of-file header checks.
- Add tests for user files that mention `# Generated Harness Rules` as plain text.
- Track package-injected permissions with enough ownership metadata to avoid
  removing user-owned entries.
- De-duplicate update report groups.

### 5. Continue policy/control-plane work

After the root guidance and skill install model are safer, return to
`skills-vs-commands-invocation-policy.md`.

Next useful pieces:

- automated audit/check commands
- trigger tests
- manual-only validation for harness-specific skill invocation settings
- command/skill install parity checks

This should follow the ownership work because the current install/runtime model
still determines which skills and commands are actually visible to users.

### 6. Flag when onboarding never happened

The first-install welcome page records `onboardedAt` in the presets state
(`~/.roborepo/presets/state.json`) on every exit path. But if a user lands roborepo
some other way (manual config, partial install, an interrupted bootstrap), that
field can stay null and the intro/onboarding never runs — silently.

Add a check that surfaces this:

- `roborepo doctor` should warn when `presetsState.onboardedAt` is null
  ("onboarding never completed — run `roborepo onboard`").
- Consider a session-start statusline/hook nudge as well, but doctor is the
  minimum.

Not implemented yet; captured here so the welcome-page work has a safety net.

## References

- `docs/plans/harness-parity-todo.md`
- `docs/plans/skills-vs-commands-invocation-policy.md`
- `docs/plans/project-context-v2-plan.md`
- `docs/plans/completed/package-gated-install.md`
- `scripts/cli/rules-render.mjs`
- `scripts/cli/config-dashboard.mjs`
- `scripts/cli/portal-server.mjs`
- `scripts/install/install-lib.sh`
- `scripts/install/uninstall.sh`
- `manifests/inventory/skill-invocation.json`
- `manifests/inventory/packages.json`
