# RoboRepo Maintainer Docs Map

Docs are organized by the question a reader is trying to answer. Use the table below to find the
doc of record first; supporting docs should add context, not redefine the behavior.

## Start Here

| I need to... | Start here | Then read |
| --- | --- | --- |
| Install roborepo on a machine | [First-Time Setup](../user/guides/first-time-setup.md) | [Install Workflows](../user/guides/install-workflows.md) |
| Use roborepo day to day | [Daily Use](../user/guides/setup-and-daily-use.md) | [roborepo CLI Commands](../user/reference/roborepo-cli.md) |
| Write, implement, and close plans | [Plan Suite Walkthrough](../user/guides/plan/lifecycle/plan-suite.md) | [Plans Portal Reference](../user/reference/plans-portal.md) |
| See token/tool cost and mark changes over time | [Telemetry Walkthrough](../user/guides/telemetry.md) | [Telemetry Service Reference](../user/reference/telemetry.md) |
| Understand collision behavior | [Config Collision Handling](../user/reference/config-collision-handling.md) | [Install Workflows](../user/guides/install-workflows.md) |
| Use the CLI | [roborepo CLI Commands](../user/reference/roborepo-cli.md) | [roborepo CLI Internals](cli-internals.md) |
| Know which agent CLIs roborepo manages | [Supported Harnesses](../user/guides/harnesses/supported-harnesses.md) | [Harness Provider Interface](harness-provider-interface.md) |
| Choose or inspect behavior packages | [Config Control Panel](../user/reference/config-control-panel.md) | [Daily Use](../user/guides/setup-and-daily-use.md) |

## Harness Architecture

| I need to... | Start here | Then read |
| --- | --- | --- |
| See which harnesses are supported and what each receives | [Supported Harnesses](../user/guides/harnesses/supported-harnesses.md) | [How the Harnesses Work](harnesses-explained.md) |
| Add support for a new harness | [Harness Provider Interface](harness-provider-interface.md) | [Harness Anatomy and Parity](harness-anatomy.md) |
| Understand why harness parity uses different mechanisms per tool | [How the Harnesses Work](harnesses-explained.md) | [Harness Anatomy and Parity](harness-anatomy.md) |
| Change a harness element | [Harness Anatomy and Parity](harness-anatomy.md) | [How It Works](../user/reference/architecture.md) |
| Understand filesystem materialization | [How It Works](../user/reference/architecture.md) | [Manifest And Materialization](../architecture/manifest-and-symlinks.md) |
| Understand config vs. code boundaries | [Config-Code Separation](../architecture/config-code-separation.md) | [Documentation Map And Audit](../architecture/documentation-map-and-audit.md) |
| Understand rules generation | [Rules Parity and Layering](rules-parity-and-layering.md) | [Config Collision Handling](../user/reference/config-collision-handling.md#rendered-rules) |

## Feature Areas

| Area | Doc of record | Supporting docs |
| --- | --- | --- |
| Skills and slash commands | [Skills And Slash Commands](skills-and-commands.md) | [roborepo Skills Interface](../user/reference/roborepo-skills.md) |
| Claude hooks | [Claude Hooks](../user/reference/claude-hooks.md) | [Hooks Internals](hooks-internals.md), [Harness Anatomy and Parity](harness-anatomy.md#hooks) |
| Codex hooks | [Codex Hooks](../user/reference/codex-hooks.md) | [Hooks Internals](hooks-internals.md), [Harness Anatomy and Parity](harness-anatomy.md#hooks) |
| Code indexing | [jcodemunch](../user/reference/jcodemunch.md) | [roborepo CLI Commands](../user/reference/roborepo-cli.md#indexing) |
| Docs indexing | [jdocmunch](../user/reference/jdocmunch.md) | [roborepo CLI Commands](../user/reference/roborepo-cli.md#indexing) |
| Convention capture | [Convention Capture](../user/reference/convention-capture.md) | [Config Control Panel](../user/reference/config-control-panel.md) |
| Plans portal and workflows | [Plans Portal Reference](../user/reference/plans-portal.md) | [Plan Suite Walkthrough](../user/guides/plan/lifecycle/plan-suite.md) |
| Telemetry and the telemetry portal | [Telemetry Service Reference](../user/reference/telemetry.md) | [Telemetry Walkthrough](../user/guides/telemetry.md) |
| Inventory manifests | [Inventory Manifest README](../../manifests/inventory/README.md) | [Config-Code Separation](../architecture/config-code-separation.md) |
| NPM release workflow | [NPM Release Workflow](npm-release.md) | [Testing RoboRepo](testing.md) |
| Maintainer test matrix | [Testing RoboRepo](testing.md) | [NPM Release Workflow](npm-release.md) |
| Docker-backed test sandboxes | [Docker Test Sandboxes](docker-test-sandboxes.md) | [Testing RoboRepo](testing.md) |
| Test development vs packaged RoboRepo | [Test Scenarios](test-scenarios.md) | [Testing RoboRepo](testing.md) |
| Test fresh onboarding / harness permutations | [Test Scenarios](test-scenarios.md) | [Testing RoboRepo](testing.md) |

## Implementation Internals

Each user reference below has a maintainer companion for module maps, routes, and tests.

| User reference | Internals |
| --- | --- |
| [roborepo CLI Commands](../user/reference/roborepo-cli.md) | [roborepo CLI Internals](cli-internals.md) |
| Portal pages | [Portal Architecture](portal-architecture.md) |
| [Plans Portal Reference](../user/reference/plans-portal.md) | [Plans Portal Internals](plans-portal-internals.md) |
| [Config Control Panel](../user/reference/config-control-panel.md) | [Config Control Panel Internals](config-panel-internals.md) |
| [Runtime](../user/reference/runtime.md) | [Runtime Internals](developer-runtime-internals.md) |
| [Config Collision Handling](../user/reference/config-collision-handling.md) | [Config Collision Internals](config-collision-internals.md) |
| [Telemetry](../user/reference/telemetry.md) | [Telemetry Internals](telemetry-internals.md) |
| [Claude Hooks](../user/reference/claude-hooks.md), [Codex Hooks](../user/reference/codex-hooks.md) | [Hooks Internals](hooks-internals.md) |
| Workspace roots (withheld from user docs until plan `74h2tlim` completes) | [Application, Workspace, and State Roots](root-domains.md) |
| Skill visibility package | [Skill Reference Observation](skill-reference-observation.md) |

## Maintenance Notes

Use live reference docs for current behavior. Files under `docs/plans/` are working notes or
historical implementation records; they can explain why a decision happened, but they should not be
the only source for current behavior.

Maintainer/developer docs for this repo live under `docs/internal/`. End-user walkthroughs
belong under `docs/user/guides/`, and end-user technical references belong under `docs/user/reference/`.

The current docs cleanup audit lives at
[Documentation Map And Audit](../architecture/documentation-map-and-audit.md).
