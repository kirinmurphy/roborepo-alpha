# Harness Provider Interface

Read this to understand how roborepo supports more than one coding-agent CLI, and to add support for
a new one.

For what the supported harnesses do from a user's point of view, read
[Supported Harnesses](../user/guides/harnesses/supported-harnesses.md) first.

## Why the Interface Exists

Every harness stores the same *ideas* in a different *shape*. Rules are Markdown in
`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, or `~/.gemini/GEMINI.md`. Permissions are a JSON key in
Claude's `settings.json`, a marker block inside Codex's `config.toml`, and a roborepo-owned TOML file
in Gemini's `~/.gemini/policies/` directory. MCP servers are a CLI call for Claude, a TOML table for
Codex, and a JSON key for Gemini.

Without an abstraction, every feature would carry its own `if claude … else if codex …` ladder, and
each ladder would be a place to forget a harness. That failure mode is not hypothetical: Gemini once
passed 108 `doctor` checks while missing two entire artifact classes, because it sat *outside* the
delivery loops rather than failing inside them. Nothing had a row to fail on, and no rows reads
exactly like every row passing.

The interface exists to make "forgot a harness" impossible to express: platform code iterates the
registry, and a harness opts into behavior by declaring a capability.

## The Three Layers

Support for a harness is split across three layers with a strict rule about what may know what.

**Platform** — `scripts/cli/`, `scripts/build/`, `scripts/install/`
Owns *behavior*: what a rules file should contain, when permissions are re-rendered, how a package
install proceeds. Knows the vocabulary of capabilities. Must never know that Codex uses TOML or where
Gemini keeps its policy files.

**Provider** — `scripts/harnesses/<id>/`, `globals/harnesses/<id>/`
Owns *everything specific to one harness*: its file formats, path layout, native tool names,
detection hints. A provider is the only place a harness's native shape may appear.

**Adapter** — the `adapters` object a provider exports
The connection between them. Platform code calls `provider.adapters.<group>.<method>(…)`; the
provider decides what that means natively.

The practical test: if you are writing platform code and need to name a specific harness, something
is in the wrong layer. Ask which *capability* you actually mean, and iterate providers that declare
it.

## Anatomy of a Provider

A provider is two files.

### 1. The manifest — `globals/harnesses/<id>/provider.json`

Pure data, no code. Validated against `scripts/harnesses/provider-manifest.schema.json`.

```jsonc
{
  "schemaVersion": 1,
  "id": "gemini",                    // lowercase slug; the harness's identity everywhere
  "displayName": "Gemini CLI",       // shown to users; never derive this from the id
  "commandName": "gemini",           // the executable
  "adapter": "gemini",               // which scripts/harnesses/<dir>/ implements it

  "detection": {                     // ONLY these locations are ever checked
    "executables": ["gemini"],
    "homeCandidates": ["~/.gemini"],
    "configCandidates": ["~/.gemini/settings.json"],
    "minimumConfidence": "probable"
  },

  "paths": {                         // every path this harness owns, home-relative
    "home":       { "path": "~/.gemini",               "kind": "directory" },
    "rootConfig": { "path": "~/.gemini/settings.json", "kind": "file" },
    "rules":      { "path": "~/.gemini/GEMINI.md",     "kind": "file" },
    "skills":     { "path": "~/.gemini/skills",        "kind": "directory" },
    "commands":   { "path": "~/.gemini/commands",      "kind": "directory" },
    "policies":   { "path": "~/.gemini/policies",      "kind": "directory" }
  },

  "capabilities": [                  // the contract: what this harness accepts
    "root-config", "rules", "permissions",
    "skills", "slash-commands", "hooks", "mcp"
  ],

  "extensions": {                    // native-shape hints platform code reads generically
    "roborepo": {
      "rootConfigFormat": "json",
      "hooksStorage": "embedded-in-root-config",
      "mcpStorage": "json-mcpServers-key",
      "permissionsStorage": "policy-engine-toml-directory",
      "toolNameMap": { "Write": "write_file", "Edit": "replace", "Read": "read_file" }
    }
  }
}
```

Two rules matter more than the rest:

- **Declare a capability only if the harness genuinely supports it.** Capabilities are a contract,
  not a wish list. Declaring one without the adapter methods fails validation at registration.
- **Paths are data, never derived.** Platform code resolves paths through
  `resolveHarnessPath(manifest, key)`. Nothing should build `~/.${id}` by hand — that assumption
  breaks the moment a harness's directory is not named after its id.

Per-platform overrides go in an optional `platforms` key (`darwin`, `linux`, `win32`). Detection
keys layer over the base detection object; unmentioned executable and home candidates remain in
force. On macOS, `platforms.darwin.detection.desktopCandidates` declares bounded app roots and
layouts, a bundle ID, and an executable inside the bundle. Desktop roots may be absolute or
`~/`-relative; home and config candidates remain `~/`-relative. See the Claude and Codex manifests
for the two supported layouts. The resolver validates bundle identity and `--version`, then retains
the newest working desktop runtime alongside any CLI observation. A moved app outside the declared
roots is not found.

Discovery persists source, path, and version for executable evidence, plus setup warnings, in
machine-local harness state schema version 2. Older state is rebuilt on the next refresh. A
validated runtime without a native home remains below the `confirmed` minimum and produces launch
guidance. Installer writes still depend on home presence alone.

### 2. The adapter — `scripts/harnesses/<id>/index.mjs`

Executable code, exported through `defineHarnessProvider`, which validates the manifest and checks
that every declared capability has its required methods before returning a frozen provider.

```js
export const geminiProvider = defineHarnessProvider({
  manifest: geminiManifest,
  adapters: {
    discovery:  { detect: () => detectHarnessProvider(geminiManifest) },
    rootConfig: { merge: mergeGeminiSettings, render: normalizeGeminiRootConfig },
    permissions:{ render: renderGeminiPermissions },
    hooks:      { merge: mergeRootConfigHooks, unmerge: unmergeRootConfigHooks, /* … */ },
    mcp:        { addServer, removeServer, list, /* … */ },
  },
});
```

Each capability maps to a required adapter group and method set, defined in
`CAPABILITY_REQUIRED_METHODS` (`scripts/harnesses/contract.mjs`):

| Capability | Group | Required methods |
| --- | --- | --- |
| `root-config` | `rootConfig` | `merge`, `render` |
| `rules` | `rules` | `render` |
| `permissions` | `permissions` | `render` |
| `skills` | `skills` | `link` |
| `slash-commands` | `commands` | `render` |
| `hooks` | `hooks` | `read`, `write`, `merge`, `unmerge` |
| `mcp` | `mcp` | `add`, `remove`, `addServer`, `removeServer`, `list` |
| `package-config` | `rootConfig` | `mergePackageComponent`, `unmergePackageComponent` |
| `telemetry-capture` | `telemetry` | `wireCaptureHooks` |
| `telemetry-rate-limits` | `telemetry` | `parseRateLimits` |
| `telemetry-transcripts` | `transcripts` | `locate`, `parse` |
| `session-launch` | `session` | `launch` |
| `session-resume` | `session` | `resume` |

### Hooks: read, merge order, and readiness

`hooks.read({ cwd, hooksPath })` returns a promise of one record per installed hook handler:
`{ event, command, sourcePath, trust, enabled, identity? }`. `event` uses the fragment spelling
(`PostToolUse`) so records compare directly with `hooks` resources. `trust` is one of `trusted`,
`managed`, `untrusted`, `modified`, `not-required`, or `unknown`. The optional `identity` is an
opaque digest that changes exactly when the harness would ask for review again (Codex folds the
trust key and definition hash into it); it is never trust material itself.

| Provider | `read` | Trust source |
| --- | --- | --- |
| Claude | Reads the `hooks` key of `settings.json` | Always `not-required`: Claude has no per-hook approval. It is not proof a hook runs: an interactive session holds settings hooks until the user trusts the workspace, while `-p` and SDK sessions treat it as trusted. Package status says "configured" rather than "active" for these hooks |
| Codex | Asks `codex app-server` for `hooks/list`, using the executable `selectedHarnessExecutable` picks (a `PATH` CLI first) | Codex's own `trustStatus`; `isManaged` maps to `managed`. A missing, old, or slow runtime returns the file's entries with `trust: "unknown"` instead of throwing |
| Gemini | Still the `notYetMigrated` stub; readiness skips it | — |

Two optional `hooks` methods feed the readiness comparison: `core()` returns the harness's core hook
fragment, and `guidance()` returns next-step copy for a harness that gates hooks on trust (Codex).
Codex derives its guidance from validated discovery evidence, preferring a desktop-bundled CLI over
one on `PATH`. Availability does not establish which interface the user is actively using.

| Guidance field | Meaning |
| --- | --- |
| `command` | Shell-quoted review executable, or null when none is available |
| `review` | `{ executable, args }` for opening the harness review screen, or null |
| `review_required`, `inactive`, `terminalHint` | Provider-owned status and action copy |
| `reviewApp` | Desktop review instructions when the desktop app is detected; otherwise null |
| `preferredInterface` (optional) | `desktop` or `cli`; the provider's presentation preference based on availability |
| `reviewButtonLabel`, `terminalOptionLabel` (optional) | Labels for the terminal action and its disclosure |
| `missingCore` (optional) | `{ title, message, steps, installLabel, manualApprovalStep, purposeLabel, cliSetupLabel, cliSetup }`; procedural installation/review/session steps, contextual hook-purpose help from readiness and CLI setup tooltips (`cliSetup`: `string[]`), with manual instructions when terminal launch is unavailable |

`packageReview` optionally supplies `{ message, mixedMessage, steps, purposeLabel,
reviewCaution, cliSetupLabel, cliSetup }` for installed package-hook approval. Its installation
step is complete independently of the core bundle; mixed pending sets use its shared approval
steps while listing both owners. Shared rendering adds the combined pending owner/count/event approval instruction from readiness.

Shared code renders this guidance without choosing a provider's executable or product-specific copy.

Core hooks are expected only once installed by choice: when a harness's core hooks arrive through a
`hook_fragment` manifest row, readiness includes them only if the bundle holding that row is
selected (`scripts/cli/core-hook-bundle.mjs`). Claude's core hooks ride in its root
config, which every install applies, so they are always expected.

Codex’s `core()` reads the canonical source fragment, including its source-only `_descriptions`
map. Each expected hook can carry `name` from native `statusMessage` and `description` from
that map; the comparison preserves both. Native generated output and merges exclude the
underscore metadata. The portal derives approval help from these hook records rather than a
static provider-purpose list.

`scripts/harnesses/hook-readiness.mjs` builds the expected set from `core()` plus enabled packages'
`hooks` resources for that harness, compares it with `read()`, and reports one state per group:
`active`, `review_required`, `inactive`, `missing`, or `unknown`, plus `reviewRevision`: a digest of
the pending RoboRepo hooks' identities, or null when none await review. Surfaces offer review once
per revision. Records from another `sourcePath` never satisfy an expected hook, and a pending hook
RoboRepo did not install never enters the revision. Package status (`probeHooks`), the portal route
`/api/config/hooks/<harness>/status`, `doctor --installed`, and the CLI completion hint
(`scripts/cli/hook-review-guidance.mjs`) all consume it.

`hooks.merge` order differs on purpose. Claude and Gemini prepend a fragment's entries, because
Claude treats the first decisive hook result as final. Codex appends, because Codex keys trust by
position (`<file>:<event>:<group index>:<handler index>`) and prepending would revoke trust the
user already granted. Codex launches matching command hooks concurrently, so order carries no
decision priority there. Core Codex hooks go through the same merge: the `hooks` bundle's
`hook_fragment` row (`scripts/cli/shared-target-rows.mjs`) appends them after package hooks that
are already installed.

### Migration state — read this before you are surprised

Not every capability's logic lives in its adapter yet. Several still live in `scripts/cli/*.mjs` and
are wired to `stubAdapterGroups`, which throws a clear "not migrated yet" error rather than silently
doing nothing. This is true for **all** providers, not just new ones — `rules`, `skills`, and
`commands` render through platform code today.

The consequence for a new provider: declaring `rules` does not mean writing a rules adapter. It
means your manifest's `rules` path gets picked up by the existing platform renderer. Follow what
Claude and Codex actually do rather than the table above, which describes the destination.

## The Registry

`scripts/harnesses/registry.mjs` is a static, import-time map of every known provider:

```js
const PROVIDERS = new Map([
  [claudeProvider.id, claudeProvider],
  [codexProvider.id, codexProvider],
  [geminiProvider.id, geminiProvider],
]);
```

It is deliberately static and roborepo-owned. A workspace can enable, disable, or configure a known
provider, but cannot name an arbitrary module for roborepo to execute — providers are code, so
letting config choose them would be an execution vector.

Platform code reaches providers three ways:

```js
listHarnessProviders()                  // iterate — the default for delivery loops
getHarnessProvider(id)                  // one provider; throws if unknown
harnessIdsWithCapability("skills")      // ids declaring a capability
```

`harnessIdsWithCapability` (`scripts/cli/rules-render.mjs`) is the one to reach for when targeting
"the harnesses that support X". Prefer it over any literal list — it is what makes a new provider
opt in by declaring a capability rather than by an edit someone must remember.

## The Shell Layer

Install, update, doctor, and uninstall are bash, not Node, so they cannot import the registry
directly. They reach it through two shared helpers in `scripts/lib/manifests-data.sh`:

```bash
harness_detected_rows      # id  homePath  present  displayName  rootConfigPath  confidence
repo_internal_skill_dirs   # project-scope skills dirs, one per skills-capable provider
```

`harness_detected_rows` shells out to `roborepo harness detected`, so the registry stays the single
source of truth across both languages. Iterate it instead of writing `~/.claude`/`~/.codex` literals
— column 2 is the provider's own home path, which is not required to match its id. Column 3 is the
home-presence gate for writes; column 6 reports live discovery confidence for guidance. Bash
readers must consume all six columns so confidence cannot become part of `rootConfigPath`.

Two constraints worth knowing before editing these scripts:

- **Some scripts run in sandboxes** that copy only `scripts/cli/` and `scripts/build/`. Source
  `manifests-data.sh` conditionally and fall back, rather than hard-failing the step.
- **`node -e` blocks that use `require()` cannot use top-level `await`** — it is a parse error, not
  a runtime one. Read the provider manifests from `globals/harnesses/*/provider.json` synchronously
  instead of importing the ESM registry.

## Adding a New Provider

1. **Write the manifest** at `globals/harnesses/<id>/provider.json`. Start with the capabilities you
   can verify against the real tool. Confirm native shapes from the harness's own package or docs,
   not by analogy to another harness — Gemini's permission decisions are `allow`/`deny`/`ask_user`,
   and guessing `ask` from Claude's vocabulary would have produced a file the Policy Engine rejects.

2. **Write the adapter** at `scripts/harnesses/<id>/index.mjs`. Export via `defineHarnessProvider`.
   Use `stubAdapterGroups` for capabilities whose logic still lives in platform code, matching what
   Claude and Codex do.

3. **Register it** in `scripts/harnesses/registry.mjs`.

4. **Add rule fragments** at `globals/system/rules/<id>/` — the per-provider location the renderer
   reads by convention. Create this only if the harness needs rules the others should not get;
   shared fragments reach every harness without it.

5. **Update the Windows installer.** `scripts/install/install-windows.ps1` maintains its own
   `$KnownHarnessIds` rather than deriving it from the manifests (every harness home is
   `~/`-relative on Windows too; deriving the list is follow-up work). `scripts/test/windows-installer-check.ps1` fails CI if
   the two drift, so this step is enforced rather than remembered. Run it locally with PowerShell
   Core (`brew install --cask powershell@preview`); it is static analysis and needs no Windows.

6. **Verify:**
   ```bash
   npm test                       # full suite, including third-provider genericness checks
   bash scripts/doctor.sh         # manifest validity, registry construction, path coherence
   roborepo harness inspect <id>  # manifest and capabilities as roborepo sees them
   ```

## How Genericness Is Enforced

Because the real providers always exist together, a two-provider assumption can hide indefinitely.
Three tests register a fabricated `acme` provider in a subprocess (the registry is a static
import-time map, so this requires process isolation) and assert it is treated as a first-class
harness:

| Test | Proves |
| --- | --- |
| `config-synthetic-provider-check.mjs` | Config snapshot and root-config path maps generalize |
| `telemetry-synthetic-provider-check.mjs` | Telemetry analysis and capability lookups generalize |
| `delivery-synthetic-provider-check.mjs` | Artifact **delivery** reaches a provider in no hardcoded list |

The third is the one that guards the Gemini failure mode directly. It registers `acme` *without*
Gemini, so a loop merely widened from two ids to three still fails. It also asserts every provider
declaring a capability resolves the path that capability needs — the coherence check that catches a
harness sitting outside the mechanism.

When you add a provider, these tests should pass without modification. Needing to edit one is a
signal that something reintroduced a fixed-provider assumption.

## Where to Go Next

- [Supported Harnesses](../user/guides/harnesses/supported-harnesses.md) — the user-facing view
- `scripts/harnesses/contract.mjs` — capability vocabulary and validation
- `scripts/harnesses/gemini/` — the most recently added provider, and the clearest worked example
