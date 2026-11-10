---
id: unified-package-configuration-plan
priority: none
next_action:
blocked_by: []
depends_on: []
related: []
reviewed_commit:
---

# Unified Package Configuration Plan

## Status

Completed on 2026-07-16

## Summary

RoboRepo previously represented one user-facing feature across several independently authored configuration surfaces:

- `manifests/inventory/packages.json`
- `manifests/inventory/skill-invocation.json`
- `manifests/inventory/slash-commands.json`
- package assets under `globals/packages/`
- skill assets under `globals/agents/skills/`
- generated Claude and Codex command files

This used to work, but it created multiple sources of truth for a single feature. A package that installed a skill and exposed a slash command had to be registered in several places that had to remain manually synchronized.

The target model is:

> Every optional or user-created installable feature is defined by exactly one package configuration file.

Each package may contain one resource or many resources. Skills, skill-backed slash commands, standalone slash commands, rules, hooks, services, plugins, MCP integrations, permissions, and RoboRepo CLI command implementations remain distinct resource types, but they are authored under one owning package.

Minimal RoboRepo bootstrap resources remain system resources and may continue to install directly outside the optional package system.

This plan defined the target package model and package engine. The completed implementation moved built-in packages and optional skill resources to package-owned `package.config.json` files, removed the legacy authored package/skill/command registries, removed the remaining legacy package manifest reader, and removed `project-context` and `/inventory` code paths.

---

## Problem

A conceptual package was distributed across several registries.

For example, a skill-backed command may require:

1. A package entry that installs the skill.
2. A skill invocation entry that describes automatic or manual use.
3. A slash-command entry that exposes the skill through `/command-name`.
4. A skill source directory.
5. Generated harness command files.
6. Hardcoded or inferred presentation behavior in onboarding and the Config UI.

The system reconstructed ownership by matching identifiers across these files.

This creates several failure modes:

- A package installs a skill but no command is registered.
- A skill says it has an explicit command, but no command exists.
- A slash command references an unknown skill.
- A skill is individually toggleable even though it is conceptually part of a package.
- Package presentation is inferred from resource shape rather than declared explicitly.
- A category typo can cause a feature to disappear or render incorrectly.
- Removing a package requires discovering and deleting references across unrelated directories.
- User-created packages need to understand internal RoboRepo registries instead of one package interface.

The old scaffold reduced manual work but did not remove the duplicated sources of truth.

---

## Goals

### Primary goals

- Define one authored configuration file for each optional or user-created package.
- Allow a package to wrap one resource or many resources.
- Give every optional resource exactly one owning package.
- Represent automatic skills, skill-backed slash commands, and standalone slash commands in the same package schema.
- Make package-level presentation explicit.
- Replace category inference with validated category identifiers.
- Support built-in and workspace packages through the same package interface.
- Make package creation, inspection, enablement, disablement, export, and removal package-centric.
- Preserve distinct installation handlers for different resource types.
- Remove the need to manually maintain package, skill invocation, and slash-command registries in parallel.

### Secondary goals

- Make package source physically modular and easy to remove.
- Reduce central manifest merge conflicts.
- Improve package validation and diagnostics.
- Prepare RoboRepo for user-created packages without exposing internal registry details.
- Keep generated normalized indexes possible where useful, while ensuring they are not authored sources of truth.

---

## Non-goals

This plan does not:

- Implement the `plan-docs` skill or Plans portal page.
- Define plan-document frontmatter or lifecycle conventions.
- Build a general third-party plugin marketplace.
- Make portal pages dynamically loadable from package configuration.
- Move core bootstrap resources into packages unless a concrete need appears.
- Preserve a permanent compatibility layer for the old manifests.
- Define the full migration checklist for every current package and skill.

Those items belong in separate implementation plans.

---

## Core decisions

## 1. Packages are the ownership boundary

Every optional or user-created installable resource belongs to exactly one package.

Examples:

```text
code-style
└── automatic skill
```

```text
plan-docs
└── skill
    └── /plan-docs slash-command entry point
```

```text
some-command
└── standalone slash command
```

```text
jcodemunch
├── MCP integration
├── rules
├── hooks
├── permissions
└── RoboRepo CLI commands
```

A package with one resource is still a valid package. The package wrapper provides lifecycle ownership, validation, presentation, inspection, export, and removal.

Resources may not have multiple owning packages.

Other packages compose an existing resource by depending on its owning package.

---

## 2. System resources remain outside the optional package system

Minimal resources required for RoboRepo itself to operate may remain direct system resources.

Initial system resources include:

- the `roborepo` CLI
- installer and bootstrap wiring
- required base configuration
- the always-installed `roborepo-support` skill

`roborepo-support` is currently installed directly as part of the base installation. It does not need an artificial user-visible package merely for structural purity.

The distinction is:

### System resource

- required for RoboRepo to function
- installed automatically
- not user-toggleable
- maintained as part of the application bootstrap

### Package resource

- optional, user-created, or independently managed
- enabled and disabled through package lifecycle
- inspectable as a package
- exported, imported, or removed as a package

This boundary may be revisited only if system resources later need independent lifecycle management.

---

## 3. Resource types remain distinct inside one package

A unified package configuration does not make all resources behave the same.

The package engine still needs distinct handlers for:

- skills
- skill-backed slash-command entry points
- standalone slash commands
- rules
- hooks
- permissions
- MCP integrations
- plugins
- services
- RoboRepo CLI commands

The distinction is operational, not organizational.

A skill is copied into the shared skill cache and linked into harness skill directories. A slash command is rendered into harness command directories. Rules are merged into generated instruction files. Hooks modify harness lifecycle configuration. Services may have bespoke enable and disable handlers.

These differences belong in resource-specific validators and installers, not in separate authored manifests.

---

## 4. Package presentation is explicit and package-level

Each package declares where it appears in onboarding and the Config UI.

Example:

```json
{
  "presentation": {
    "category": "commands",
    "order": 40
  }
}
```

RoboRepo must not infer user-facing placement from whether a skill has a slash command.

The package is the unit presented to the user, even when it contains several resources.

Resource-level presentation overrides are not part of the initial design. They should be added only if a concrete package needs to expose independently managed resources in different sections.

---

## 5. Categories use a validated central registry

Categories are referenced by stable IDs, not display labels.

Example registry:

```json
{
  "schemaVersion": 1,
  "categories": [
    {
      "id": "token-optimization",
      "label": "Token Optimization",
      "order": 10
    },
    {
      "id": "commands",
      "label": "Commands",
      "order": 20
    },
    {
      "id": "code-conventions",
      "label": "Code Conventions",
      "order": 30
    },
    {
      "id": "chat-time-output",
      "label": "Chat-Time Output",
      "order": 40
    }
  ]
}
```

A package references the ID:

```json
{
  "presentation": {
    "category": "commands"
  }
}
```

Unknown category IDs are validation errors.

RoboRepo must not:

- silently hide packages with unknown categories
- automatically create categories from arbitrary strings
- treat spelling or capitalization variants as new categories

Initial category registration remains closed and centrally managed. Extensible workspace categories may be considered later if there is a concrete use case.

---

## 6. Package source is colocated

Each built-in package lives in its own directory:

```text
globals/packages/
  code-style/
    package.config.json
    skills/
      code-style/
        SKILL.md

  plan-docs/
    package.config.json
    skills/
      plan-docs/
        SKILL.md

  jcodemunch/
    package.config.json
    rules.md
    hooks-claude.json
```

Workspace packages use the same shape:

```text
<workspace>/packages/
  my-package/
    package.config.json
    ...
```

Benefits:

- configuration and assets share one ownership boundary
- deleting a package directory removes its complete source
- package export and import become directory operations
- package scaffolding creates one self-contained module
- central manifest conflicts are reduced
- package inspection can report one source root

By default, package asset paths must remain inside the package directory. References outside the package directory should be rejected unless a narrowly defined system exception is introduced later.

---

## Target package schema

The exact schema may evolve during implementation, but it should support the following model.

```json
{
  "schemaVersion": 1,
  "id": "plan-docs",
  "label": "Plan Docs",
  "description": "Manage repository planning documents and initiate plan workflows.",
  "lifecycle": "optional",
  "presentation": {
    "category": "commands",
    "order": 40
  },
  "requires": [],
  "resources": [
    {
      "type": "skill",
      "id": "plan-docs",
      "source": "skills/plan-docs",
      "invocation": "manual",
      "risk": "medium",
      "entrypoints": [
        {
          "type": "slash-command",
          "name": "plan-docs",
          "description": "Manage plans, priorities, validation, handoffs, and next work.",
          "harnesses": [
            "claude",
            "codex"
          ]
        }
      ]
    }
  ]
}
```

---

## Resource examples

## Automatic skill

```json
{
  "schemaVersion": 1,
  "id": "code-style",
  "label": "Code Style",
  "description": "General coding conventions loaded automatically when relevant.",
  "lifecycle": "optional",
  "presentation": {
    "category": "code-conventions",
    "order": 10
  },
  "resources": [
    {
      "type": "skill",
      "id": "code-style",
      "source": "skills/code-style",
      "invocation": "auto",
      "risk": "low"
    }
  ]
}
```

## Skill-backed slash command

```json
{
  "schemaVersion": 1,
  "id": "tighten",
  "label": "Tighten",
  "description": "Review and improve code against project conventions.",
  "lifecycle": "optional",
  "presentation": {
    "category": "commands",
    "order": 20
  },
  "resources": [
    {
      "type": "skill",
      "id": "tighten",
      "source": "skills/tighten",
      "invocation": "manual",
      "risk": "medium",
      "entrypoints": [
        {
          "type": "slash-command",
          "name": "tighten",
          "description": "Review and improve code against project conventions.",
          "harnesses": [
            "claude",
            "codex"
          ]
        }
      ]
    }
  ]
}
```

## Standalone slash command

```json
{
  "schemaVersion": 1,
  "id": "example-command",
  "label": "Example Command",
  "description": "A command-specific workflow with no reusable skill.",
  "lifecycle": "optional",
  "presentation": {
    "category": "commands",
    "order": 50
  },
  "resources": [
    {
      "type": "slash-command",
      "id": "example-command",
      "name": "example-command",
      "source": "commands/example-command.md",
      "description": "Run the example command workflow.",
      "harnesses": [
        "claude",
        "codex"
      ]
    }
  ]
}
```

## Composite package

A composite package owns no duplicate resources. It enables dependency packages.

```json
{
  "schemaVersion": 1,
  "id": "local-indexing",
  "label": "Local Indexing",
  "description": "Enable code and documentation indexing together.",
  "lifecycle": "optional",
  "presentation": {
    "category": "token-optimization",
    "order": 10
  },
  "requires": [
    "jcodemunch",
    "jdocmunch"
  ],
  "resources": []
}
```

The owning dependency packages retain ownership of their skills, commands, MCP integrations, and rules.

---

## Package directory discovery

The package loader should scan:

```text
globals/packages/*/package.config.json
<workspace>/packages/*/package.config.json
```

The loader should:

1. Read all package configurations.
2. Validate each package locally.
3. Validate the complete catalog globally.
4. Merge built-in and workspace catalogs according to existing override policy.
5. Return one normalized package model to all consumers.

Consumers should not independently parse package source files.

---

## Validation

## Package-local validation

Each package must validate:

- `schemaVersion` is supported.
- `id` is a valid slug.
- package directory name matches the package ID.
- `label` is non-empty.
- `lifecycle` is recognized.
- `presentation.category` exists in the category registry.
- `presentation.order`, when present, is numeric.
- `resources` is an array.
- each resource type is recognized.
- each source path exists.
- each source path remains inside the package directory.
- resource-specific required fields are present.
- harness values are supported.
- skill invocation values are supported.
- slash-command entry points are valid.

## Catalog-wide validation

The complete catalog must validate:

- no duplicate package IDs
- no duplicate skill IDs
- no duplicate slash-command names
- no duplicate RoboRepo CLI command ownership
- no resource has more than one owning package
- all required packages exist
- no dependency cycles
- workspace conflicts follow typed override rules
- all package presentation categories exist
- all generated harness outputs have one unambiguous source
- composite packages do not claim resources owned by dependencies

Validation failures should stop apply, onboarding, and package creation from producing partial state.

---

## Generated indexes

RoboRepo may generate normalized indexes for runtime use, diagnostics, or compatibility with existing renderers.

Possible outputs include:

```text
<generated-root>/package-catalog.json
<generated-root>/skill-invocation.json
<generated-root>/slash-commands.json
```

Rules:

- generated indexes are never manually edited
- package configuration remains the only authored source of truth
- generated files clearly identify their source and generated status
- `roborepo verify` checks that generated outputs match package sources
- generated indexes may be removed later if runtime consumers can use the normalized in-memory catalog directly

The initial implementation may use generated indexes to reduce migration risk, but the migration must not retain dual authored configuration.

---

## Package engine responsibilities

The unified package engine should provide:

```text
loadPackageCatalog()
validatePackageCatalog()
inspectPackage()
enablePackage()
disablePackage()
reconcilePackage()
listPackages()
```

Resource handlers should provide a common lifecycle interface:

```text
validate(resource, context)
probe(resource, context)
enable(resource, context)
disable(resource, context)
render(resource, context)
```

Not every resource type needs every operation. Unsupported operations should be explicit.

Example handler map:

```text
skill            -> skill handler
slash-command    -> command renderer
rules            -> rules renderer
hooks            -> hooks merger
permissions      -> permission merger
mcp              -> MCP installer
plugin           -> plugin installer
service          -> service handler
cli-command      -> CLI ownership resolver
```

Package-level lifecycle coordinates these handlers in deterministic order.

---

## CLI direction

Package management should become the primary user-facing interface.

Target commands:

```text
roborepo package list
roborepo package inspect <id>
roborepo package create
roborepo package enable <id>
roborepo package disable <id>
roborepo package validate [id]
roborepo package export <id>
```

Compatibility aliases such as:

```text
roborepo enable <id>
roborepo disable <id>
```

may remain if they are useful, but they should delegate to the package engine.

The package creation workflow should offer templates:

- automatic skill
- skill plus slash command
- standalone slash command
- rules package
- integration package
- composite package
- empty custom package

The creator should write one package directory and should not require the user to edit separate inventory manifests.

---

## Config UI and onboarding

The Config UI and terminal onboarding should consume the same normalized package presentation model.

They should not:

- infer category from whether a skill has a slash command
- maintain special-case lists of package IDs
- independently reconstruct package ownership

A normalized package presentation entry should include:

```json
{
  "id": "plan-docs",
  "label": "Plan Docs",
  "description": "Manage repository planning documents.",
  "category": "commands",
  "order": 40,
  "enabled": false,
  "status": "disabled",
  "badges": [],
  "resources": [
    "skill",
    "slash-command"
  ]
}
```

Both the web UI and terminal onboarding render from that model.

Package category is explicit in `package.config.json`.

---

## Workspace parity

Built-in and workspace packages should use the same package schema and validation.

Differences should be limited to source root and override policy.

```text
Built-in:
  globals/packages/<id>/package.config.json

Workspace:
  <workspace>/packages/<id>/package.config.json
```

Workspace packages may not silently replace built-in packages. Existing typed replace behavior should remain explicit.

Package creation should default to the workspace package root for user-created packages.

---

## Enable and disable behavior

Enabling a package should:

1. Resolve and enable dependencies.
2. Validate resource ownership.
3. Apply resource handlers in deterministic order.
4. Record desired package state.
5. Re-render derived configuration.
6. Probe actual state.
7. Report complete, partial, or blocked status.

Disabling a package should:

1. Check whether enabled packages depend on it.
2. Reject unsafe removal or require explicit dependent-package handling.
3. Reverse owned resource handlers.
4. Remove package state.
5. Re-render derived configuration.
6. Probe actual state.
7. Preserve external or user-owned resources that RoboRepo does not own.

A package must never remove a resource owned externally or by another package.

---

## Package status

Recommended package states:

```text
disabled
enabled
partial
blocked
external
```

These describe desired versus observed package installation state.

They are unrelated to planning-document lifecycle statuses.

---

## Source layout

Target built-in layout:

```text
globals/
  packages/
    <package-id>/
      package.config.json
      skills/
        <skill-id>/
          SKILL.md
          references/
          scripts/
      commands/
        <command-id>.md
      rules/
      hooks/
      services/
```

Packages should include only directories they use.

The current top-level shared skill source may remain temporarily during migration, but the final migration should colocate optional skill sources with their owning package.

System-owned `roborepo-support` may remain under a dedicated core source path because it is not an optional package resource.

---

## Documentation model

Maintainer documentation should describe:

- the package ownership invariant
- system resources versus package resources
- package schema
- resource types
- category registry
- package lifecycle
- built-in versus workspace packages
- dependency and ownership rules
- generated output rules
- package creation workflow

Consumer documentation should focus on:

- listing packages
- enabling and disabling packages
- creating a package
- inspecting what a package installs
- resolving validation errors

Consumers should not need to understand generated skill or slash-command registries.

---

## Testing strategy

## Unit tests

- package config parsing
- package-local validation
- category validation
- path-boundary validation
- resource normalization
- duplicate ownership detection
- dependency resolution
- dependency-cycle detection
- package presentation normalization
- resource handler dispatch
- generated index rendering

## Integration tests

- enable and disable a single-skill package
- enable and disable a skill-backed command package
- enable and disable a standalone command package
- enable a multi-resource integration package
- enable a composite package and its dependencies
- reject duplicate command ownership
- reject unknown categories
- reject missing source files
- reject path traversal outside the package root
- preserve external native skills
- load and apply a workspace package
- enforce typed workspace replacement
- render identical terminal and web presentation models

## Migration verification

The separate migration plan should include checks that:

- no legacy authored package registry remains
- no legacy authored skill invocation registry remains
- no legacy authored slash-command registry remains
- no optional skill remains outside a package
- no optional slash command remains outside a package
- generated harness files match package source
- documentation contains no obsolete package instructions
- `project-context` and `/inventory` are fully removed

---

## Rollout strategy

The implementation should be divided into two documents.

### This document: package system design

Defines:

- target package schema
- ownership rules
- resource model
- presentation model
- category registry
- loader and validation behavior
- package engine interfaces
- workspace parity
- testing expectations

### Companion migration plan

Defines:

- package-by-package migration order
- movement of current skill and command assets
- replacement of existing manifests
- updates to installers, doctor, verify, onboarding, and Config UI
- removal of temporary generated compatibility outputs
- removal of old loaders and renderers
- removal of `project-context` and `/inventory`
- final repository cleanup and validation

The migration plan must end with one source of truth and no permanent dual-read path.

---

## Risks and mitigations

### Risk: package configuration becomes too broad

Mitigation:

- keep resource schemas typed
- use handler-specific validation
- avoid generic arbitrary configuration blobs
- add new resource types only when a real lifecycle exists

### Risk: asset colocation creates a large repository move

Mitigation:

- separate schema implementation from migration
- migrate package-by-package
- preserve generated outputs during the transition
- remove compatibility only after all consumers use the normalized catalog

### Risk: category registry becomes another duplicated manifest

Mitigation:

- keep it intentionally small
- make it the only authored source for category IDs and labels
- have all UIs consume the same normalized categories
- validate every package reference

### Risk: package-level presentation is insufficient

Mitigation:

- use package-level presentation initially
- defer resource-level presentation overrides
- add overrides only after a concrete package demonstrates the need

### Risk: system resources become a second uncontrolled architecture

Mitigation:

- keep the system-resource list minimal
- document why each system resource is required
- prohibit user-created system resources
- require an architectural decision before adding new direct bootstrap paths

---

## Open implementation decisions

These should be resolved during implementation, without changing the agreed architecture:

1. Exact JSON Schema format and location.
2. Exact filename and location of the category registry.
3. Whether normalized indexes are written to the repository or only generated in a state/cache directory.
4. Whether compatibility aliases remain for `roborepo enable` and `roborepo disable`.
5. Resource handler execution order.
6. Whether package config uses `resources` or retains the current name `components`.
7. Whether package descriptions for slash-command entry points may default to the package description.
8. Exact policy when disabling a dependency required by another enabled package.

Recommended default for item 6: use `resources`, because the entries describe owned artifacts and behaviors rather than only install-time components.

---

## Acceptance criteria

The package unification is complete when:

- every optional built-in resource belongs to one package
- every user-created resource must be created inside one package
- one `package.config.json` is the authored source of truth for each package
- skill invocation and slash-command behavior are declared inside the owning package
- standalone slash commands are declared inside an owning package
- package presentation category is explicit
- category IDs are centrally registered and strictly validated
- the Config UI and terminal onboarding render from one normalized package model
- built-in and workspace packages use the same schema
- package dependencies are explicit
- no resource has multiple owners
- system resources are documented and limited to required bootstrap functionality
- legacy authored package, skill invocation, and slash-command manifests are removed
- compatibility readers and migration scaffolding are removed
- `project-context` and `/inventory` code and references are removed
- doctor and verify detect package ownership, schema, source, dependency, and rendered-output errors
- all package lifecycle and migration tests pass

## Completion evidence

Verified on 2026-07-16:

- built-in packages are authored under `globals/packages/*/package.config.json`
- package-owned skills are colocated under `globals/packages/*/skills/*/SKILL.md`
- the only remaining `globals/agents/skills` source is the required system `roborepo-support` skill
- `manifests/inventory/packages.json`, `manifests/inventory/skill-invocation.json`, and `manifests/inventory/slash-commands.json` are absent
- `globals/agents/skills/project-context` and `globals/packages/project-context` are absent
- generated Claude and Codex command wrappers contain only current package-owned commands
- `scripts/cli/package-catalog.mjs` no longer falls back to `manifests/inventory/packages.json`
- `scripts/cli/workspace-resources.mjs` imports workspace package configs from `globals/packages/*/package.config.json` and no longer converts legacy package manifest rows
- package catalog validation rejects package configs that still use legacy `components` as authored source
- workspace validation rejects legacy `components` package configs and enforces typed replace overrides for workspace packages and MCP servers
- active docs no longer instruct maintainers to add optional shared skills or package entries through legacy registries

---

## Follow-up plans

After this architecture plan:

1. **Plan Docs and Plans Portal Plan**  
   The implementation plan for the built-in Plans viewer, the optional `plan-docs` package, `/plan-docs`, document lifecycle conventions, prompt generation, and package-disabled versus package-enabled UI behavior.
