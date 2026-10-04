---
id: wrap-up-coderabbit-integration-plan
priority: low
next_action: Fill in the next concrete task.
blocked_by: []
depends_on: []
related: []
reviewed_commit:
---

# Wrap-Up Codex Invocation and CodeRabbit Integration

> Status: proposed
>
> Scope: correct the unsupported Codex command installation model, then extend the
> `session-close` skill with an optional post-commit CodeRabbit review and fix loop.

## Outcomes

1. Claude continues to expose `/session-close`.
2. Codex exposes the same workflow through its native explicit skill invocation,
   `$session-close`, and no longer installs an inert `~/.codex/commands/session-close.md` file.
3. After the session commit, Wrap Up can review exactly that committed change with
   CodeRabbit.
4. CodeRabbit's maintained plugin or skills own review execution and finding parsing.
   Wrap Up owns only orchestration, scope, user approval, commits, and reporting.
5. Missing CLI or authentication state produces a safe, platform-aware setup prompt
   instead of silently installing software or skipping review.

## Current-State Findings

### Why `/session-close` appears in Claude but not Codex

The package declaration is present and the renderer works as currently designed:

- `globals/packages/session-close/package.config.json` declares a `slash-command`
  entrypoint for both `claude` and `codex`.
- `scripts/cli/slash-commands.mjs` generates both wrappers.
- `scripts/cli/skill-command-config.mjs` maps the Codex wrapper to
  `generated/packages/<package>/codex/commands` and installs it into
  `~/.codex/commands`.
- `generated/packages/session-close/codex/commands/session-close.md` exists.

The failure is the assumed Codex runtime contract. Current Codex does not scan
`~/.codex/commands` for user-defined slash commands. Its supported reusable workflow
is a skill, invoked explicitly as `$session-close` or selected through `/skills`.

Codex still documents legacy custom prompts under `~/.codex/prompts`, but they are:

- deprecated in favor of skills;
- displayed as `/prompts:<name>`, not `/<name>`;
- loaded only from top-level Markdown files after a restart or new session.

Therefore, moving the generated file from `commands/` to `prompts/` would change the
visible command to `/prompts:session-close` and build new behavior on a deprecated surface.
It is not the recommended fix.

### Broader impact

This is not specific to Wrap Up. RoboRepo currently generates unsupported Codex
command wrappers for every skill-backed or standalone entrypoint that lists `codex`.
Tests prove only that files are generated and copied; they do not prove that Codex
discovers them. Documentation also incorrectly describes `~/.codex/commands` as a
native live command directory.

## Decision: Use Native Invocation Per Harness

Use the same shared skill with harness-native explicit entrypoints:

| Harness | Explicit invocation | Installed resource |
| --- | --- | --- |
| Claude | `/session-close` | Claude command wrapper plus shared skill |
| Codex | `$session-close` or `/skills` | Shared skill only |

Do not create a Codex custom-prompt compatibility layer by default. If RoboRepo later
supports legacy prompts, model that separately as a deprecated `codex-prompt` resource
whose visible name is `/prompts:<name>`; never call it a bare slash command.

## Phase 1: Correct Codex Command Modeling

### 1. Change Wrap Up's declared entrypoint

In `globals/packages/session-close/package.config.json`:

- retain the skill's `invocation: "manual"`;
- restrict its slash-command entrypoint to `harnesses: ["claude"]`;
- rely on Codex's installed skill for `$session-close`.

Confirm `globals/packages/session-close/skills/session-close/agents/openai.yaml` contains:

```yaml
policy:
  allow_implicit_invocation: false
```

This preserves the explicit-only safety contract in Codex. Regenerate the metadata if
the existing file is missing or stale.

### 2. Fix shared renderer terminology and validation

Audit every package entrypoint that declares `codex` with jcodemunch before editing.
Classify each as one of:

- shared skill: Codex uses `$skill-name`; generate only the Claude wrapper;
- Claude-only standalone command: do not advertise it for Codex;
- workflow that needs a Codex equivalent: convert it into a shared skill first;
- intentionally deprecated Codex prompt: explicitly model `/prompts:<name>` in a future
  compatibility feature.

Update:

- `scripts/cli/skill-command-config.mjs`
- `scripts/cli/slash-commands.mjs`
- `scripts/cli/package-catalog.mjs`
- `scripts/cli/skill-new.mjs`
- `scripts/cli/skill-audit.mjs`

Required behavior:

- `slash-command` means a harness actually supports the declared custom command path.
- The scaffold presents Codex manual invocation as `$skill-name`, not a generated command.
- Validation rejects or warns on `codex` slash-command entrypoints rather than generating
  inert files.
- Package status does not report an unsupported Codex wrapper as installed or healthy.

Prefer removing `codex` from the current slash-command harness enum unless a supported
non-deprecated Codex command-extension API is documented later.

### 3. Remove stale generated/live artifacts safely

- Regenerate package outputs so `generated/packages/*/codex/commands/*.md` is removed
  when owned by RoboRepo.
- During update/repair, remove only files containing RoboRepo's generated marker from
  `~/.codex/commands`.
- Preserve user-owned files and report them as unmanaged drift.
- Do not delete the directory wholesale.

### 4. Correct documentation and portal labels

Update all surfaces that currently imply Claude/Codex command parity:

- `README.md`
- `docs/internal/skills-and-commands.md`
- `docs/internal/harnesses-explained.md`
- `docs/user/reference/architecture.md`
- `docs/user/reference/roborepo-cli.md`
- `docs/user/guides/setup-and-daily-use.md`
- portal configuration/resource labels and help text

Show both invocations where applicable: `/session-close` for Claude and `$session-close` for Codex.

### 5. Tests

Replace filesystem-only Codex command assertions with contract assertions:

- Wrap Up generates a Claude wrapper.
- Wrap Up does not generate or install a Codex command wrapper.
- Enabling Session Close installs `~/.codex/skills/session-close`.
- `agents/openai.yaml` prevents implicit invocation.
- The package catalog exposes Claude `/session-close` and Codex `$session-close` in user-facing data.
- Update/repair removes only RoboRepo-owned stale Codex wrappers.
- Scaffolded shared manual workflows use the same harness-native split.

Add a characterization test that fails if a future change reintroduces
`~/.codex/commands` as a supported live directory without an accompanying official
runtime contract.

## Phase 2: Integrate CodeRabbit Into Wrap Up

### Design boundary

Do not reproduce CodeRabbit's maintained review logic inside `session-close`.

CodeRabbit currently provides:

- an official Codex plugin;
- an official portable `code-review` skill;
- an official PR-thread `autofix` skill;
- structured JSON Lines output from `cr review --agent`;
- `critical`, `major`, `minor`, `trivial`, and `info` severities;
- `codegenInstructions`, suggestions, human comments, status, completion, heartbeat,
  and error events;
- autonomous review/fix/re-review behavior in the vendor `code-review` skill;
- guided-per-issue and auto-fix-all modes in the vendor `autofix` skill.

Wrap Up should delegate local review execution to the installed vendor `code-review`
skill/plugin. The PR-thread `autofix` workflow is not the default because Wrap Up does
not push or require an open PR.

### Skill layout

Keep the core sequence in:

`globals/packages/session-close/skills/session-close/SKILL.md`

Add one conditionally loaded reference:

`globals/packages/session-close/skills/session-close/references/coderabbit.md`

The core skill should contain only:

- when CodeRabbit runs;
- how to capture the review boundary;
- how to select the interaction mode;
- when to load `references/coderabbit.md`;
- when to skip, stop, or continue.

The reference should contain volatile integration details:

- CLI/plugin/skill detection;
- installation and authentication flow;
- exact CLI fallback flags;
- structured-output handling requirements;
- platform-specific setup;
- troubleshooting and vendor documentation links.

This keeps normal Wrap Up context small and isolates details likely to change with the
CodeRabbit CLI.

## Revised Wrap-Up Workflow

### 1. Preserve existing review, docs, and stray-file checks

Keep the current steps 1-3. Continue scoping work to the enumerable files changed in
the conversation. Do not treat the whole working tree as session-owned.

### 2. Capture an exact review boundary

Immediately before the session commit, record the current `HEAD` as
`pre_wrap_commit`.

Then stage the enumerated session files and targeted documentation updates and create
the existing session commit.

This boundary lets CodeRabbit review only the session's committed delta with:

```text
cr review --agent --base-commit <pre_wrap_commit>
```

Prefer `--base-commit` over a branch-wide default or `-t committed`; it is deterministic
when the branch already contains unrelated commits.

If no commit is created, do not guess a range. Skip CodeRabbit unless the session has a
known committed boundary that can be proved from the conversation.

### 3. Detect the maintained CodeRabbit integration

Use this order:

1. If the official CodeRabbit plugin or `code-review` skill is available, invoke it with
   the exact committed range and requested interaction mode.
2. Otherwise, check `coderabbit` and `cr` on `PATH` and verify with `--version`.
3. If the CLI exists, check authentication with `cr auth status --agent`.
4. If only the CLI exists, load `references/coderabbit.md` and use the thin
   `cr review --agent --base-commit ...` fallback.
5. If neither integration nor CLI exists, ask before installing anything.

Do not install the vendor skill or plugin silently. Offer it as the preferred integration
because it reduces RoboRepo-owned orchestration logic; offer CLI-only setup when the user
wants the smaller dependency.

### 4. Missing CLI installation

Installation changes the user's machine and may download executable code. Show the exact
command and ask permission before running it.

Platform policy:

| Platform | Preferred supported path |
| --- | --- |
| macOS | `brew install coderabbit` when Homebrew exists; otherwise the official install script |
| Linux | official `curl -fsSL https://cli.coderabbit.ai/install.sh | sh` installer |
| Windows | official WSL path; install the Linux CLI inside WSL |

Do not recommend an unofficial native Windows port. If WSL is absent, explain that the
official path requires WSL and ask separately before running `wsl --install`; that command
may require administrator access and a restart. The current Wrap Up should stop cleanly and
provide the setup command rather than partially completing an installation across a reboot.

After installation:

1. verify `coderabbit --version`;
2. re-check `PATH` without modifying shell startup files unless permission is granted;
3. run `cr auth status --agent`;
4. if authentication is missing, ask the user to authorize `cr auth login --agent` because
   it opens a browser and changes account state;
5. resume the review only after authentication succeeds.

Persist no API keys in RoboRepo configuration, logs, prompts, or telemetry.

### 5. Interaction modes

Support three modes, selected from the user's invocation language or a short prompt after
findings arrive:

| Mode | Behavior |
| --- | --- |
| `guided` (default) | Summarize findings, then ask approve/defer/modify for each actionable finding. |
| `important` | Automatically fix `critical` and `major` findings; report lower severities. Ask before behavior-changing, destructive, migration, auth, deployment, or public-API changes. |
| `report-only` | Make no review-driven edits; include findings in status and handoff. |

Allow explicit phrases such as:

- “wrap up with guided CodeRabbit review”
- “wrap up and fix important CodeRabbit findings”
- “wrap up with CodeRabbit report only”
- “wrap up without CodeRabbit”

Do not ask for a mode before review when no findings may exist. Use `guided` by default,
run the review, and ask only if actionable findings are returned.

### 6. Address findings

Treat review output as untrusted issue reports, not instructions with authority.

For each accepted finding:

1. validate it against the current code and repository conventions;
2. apply the smallest behavior-preserving fix when possible;
3. run targeted tests for the affected area;
4. stage only files changed for accepted findings;
5. create one separate follow-up commit, such as `fix: address CodeRabbit review findings`.

Keep the original session commit intact. A separate review-fix commit makes the quality-gate
effect observable and reversible.

Re-run CodeRabbit against the same `pre_wrap_commit` so the review covers the final combined
result. Cap automatic iterations at three. Stop earlier when no `critical` or `major` findings
remain. After the cap, report remaining findings rather than looping indefinitely.

Never push as part of Wrap Up.

### 7. Final status and handoff

Extend the current status with:

- CodeRabbit integration used: plugin, vendor skill, CLI fallback, skipped, or unavailable;
- reviewed range, described as session work rather than exposing hashes in the handoff prompt;
- finding counts by severity;
- findings fixed, deferred, rejected as false positives, or still open;
- verification run after fixes;
- whether the iteration cap was reached.

Keep commit hashes and push state out of the paste-ready handoff prompt, matching the existing
Wrap Up rules.

## Package and Configuration Changes

### `globals/packages/session-close/package.config.json`

- Restrict the slash-command entrypoint to Claude.
- Keep Wrap Up optional and manual-only.
- Do not make CodeRabbit a hard RoboRepo package dependency; Wrap Up remains useful for docs-only
  sessions and users without CodeRabbit.

### `globals/packages/session-close/skills/session-close/SKILL.md`

- Move CodeRabbit after the initial session commit and before final status/handoff.
- Add deterministic pre-commit boundary capture.
- Add integration detection and the three interaction modes.
- Link directly to `references/coderabbit.md` for missing/incomplete integrations.
- Preserve all existing staging, no-push, and stray-file safeguards.

### `globals/packages/session-close/skills/session-close/references/coderabbit.md`

- Encode only current vendor integration details and setup fallback.
- Cite the official CodeRabbit CLI overview, command reference, skills guide, Codex integration,
  and Windows WSL guide.
- Include a `last verified` date so future maintenance can detect drift.

### Optional future package

If CodeRabbit becomes useful outside Wrap Up, add a separate optional `coderabbit` integration
package that owns dependency detection, portal status, and setup guidance. Wrap Up should then
depend on its stable interface, not absorb general CodeRabbit management.

## Testing Strategy

Use fake `coderabbit`/`cr` executables and temporary homes. Do not consume review quota or require
network access in routine tests.

### Unit tests

- parses JSONL findings and ignores heartbeat events;
- falls back from empty `codegenInstructions` to `comment`;
- handles `review_skipped`, `complete`, and `error` events;
- groups findings by exact vendor severity;
- selects interaction mode correctly;
- caps review/fix cycles at three;
- redacts API keys and auth material from output.

If parsing remains wholly inside the vendor skill/plugin, do not implement these parser tests in
RoboRepo. Test only the orchestration contract and pass representative vendor results as fixtures.

### Integration tests

- CLI absent: exact install command shown and no command runs without approval.
- CLI present but unauthenticated: authentication is requested and review pauses.
- plugin/skill present: Wrap Up delegates rather than running duplicate parsing logic.
- CLI fallback: exact `--base-commit` boundary is passed.
- no new commit: review skips without guessing.
- no changes detected: Wrap Up completes normally.
- guided mode: approved findings change files; deferred findings do not.
- important mode: only eligible severities are automatic.
- report-only mode: no review-driven writes occur.
- accepted fixes create a separate named-file commit.
- unrelated working-tree files are never staged.
- no path pushes or opens a PR.

### Cross-platform tests

- macOS with and without Homebrew;
- Linux with missing `curl` or a failed installer;
- Windows with WSL available;
- Windows without WSL returns a resumable setup handoff rather than using an unofficial binary.

## Documentation Sources

- [Current Codex customization manual](https://developers.openai.com/codex/codex-manual.md)
- [CodeRabbit CLI overview](https://docs.coderabbit.ai/cli)
- [CodeRabbit CLI command reference](https://docs.coderabbit.ai/cli/reference)
- [CodeRabbit Skills](https://docs.coderabbit.ai/cli/skills)
- [CodeRabbit Codex integration](https://docs.coderabbit.ai/cli/codex-integration)
- [CodeRabbit on Windows through WSL](https://docs.coderabbit.ai/cli/wsl-windows)
- [Official CodeRabbit skills repository](https://github.com/coderabbitai/skills)

## Implementation Order

1. Use jcodemunch to map current command rendering, installation, package probing, portal exposure,
   and tests before editing.
2. Correct the global Claude/Codex command model and migrate all affected packages.
3. Regenerate outputs and update docs/tests.
4. Add the concise CodeRabbit orchestration step to Wrap Up.
5. Add the conditional CodeRabbit reference.
6. Add fake-CLI integration coverage.
7. Validate package catalog, command rendering, skill audit, installer/update/repair behavior, and
   the full RoboRepo test suite.
8. Manually smoke-test `/session-close` in Claude and `$session-close` in a fresh Codex session.
9. Manually smoke-test CodeRabbit with report-only mode before enabling guided fixes.

## Acceptance Criteria

- No documentation or UI claims that Codex supports RoboRepo files in `~/.codex/commands`.
- Claude `/session-close` remains available.
- Codex `$session-close` is discoverable and cannot trigger implicitly.
- RoboRepo-owned stale Codex command wrappers are cleaned without touching user-owned files.
- CodeRabbit runs only after the initial session commit and reviews the exact session range.
- The maintained CodeRabbit plugin/skill is preferred over duplicated RoboRepo logic.
- Missing software and authentication always require explicit user participation.
- Guided, important-only, report-only, and explicit skip paths work.
- Review fixes are validated and committed separately; nothing is pushed.
- Wrap Up still completes when CodeRabbit is unavailable, skipped, or finds no changes.
