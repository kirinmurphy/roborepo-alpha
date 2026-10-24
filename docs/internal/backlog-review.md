# Backlog review

## Purpose and scope

Reviewed on 2026-10-21 against commit `57f8f2199b6db87d829af8d41e387800518024c9` to identify obsolete proposals, work already delivered, and plans that still describe useful gaps.

The inventory covers all **49 Markdown files** below `docs/plans/backlog/`, including the two nested lifecycle design notes, plus the ZIP archive. Recommendations compare plan outcomes, current-state claims, task lists, relationships, source code, tests, and completed plans. This is a repository review: live harness behavior, upstream feature availability, registry publication, and external tap state were not verified. No implementation is certified complete by this audit.

The initial audit left plan files unchanged; the follow-up below records the subsequently authorized edits. “Retire” below means preserve the reasoning through archival or another documentation home; it does not mean delete unresolved requirements. “Refresh” means the outcome remains useful but the starting point is stale. “Keep” means the inspected code still supports the proposed gap, subject to normal preparation before implementation.

## Recommended decisions

| Recommendation | Evidence and consequence |
| --- | --- |
| Retire **Package Registry vs Live State Reconciliation** after preserving inbound references | **One Package State Model: What the User Chose, What Follows From It, What Is Live** explicitly incorporates its remaining scope. Maintaining both invites duplicate implementation. |
| Remove the ZIP from the active backlog after checking whether its old wording is worth retaining | It contains only historical copies of the repository-scope and repository-home/detail plans, both now in `completed/`. |
| Move the two lifecycle design notes out of the actionable backlog | They are context-transfer documents, lack plan metadata, and describe names and workflow proposals predating the shipped atomic lifecycle suite. Preserve unresolved documentation ideas rather than treating the notes as executable plans. |
| Consolidate **Harness Parity Across Providers** | Most of the document records shipped work; focused plans already own package dependencies and invocation policy. Preserve the remaining local/global override decision under an explicit owner before archiving the umbrella. |
| Re-scope **Generated State Stores: Inventory, Retention, and Visibility** | A retention registry, shared policy engine, doctor check, and store inspection/reset tooling now exist. Its longer telemetry-history policy and remaining inventory/visibility questions are separate unresolved work. |
| Re-scope the npm release plan around actual release gaps | Local publication scripts and a release guide exist. CI publishing, trusted-publisher configuration, exact registry-artifact verification, metadata, and real-machine acceptance need individual evidence; they cannot all be checked off from the scripts. |
| Reconcile the two permissions proposals before implementing either | Codex's permission hook implements per-command `ask`, while provider metadata and UI-plan scenarios still describe it as unavailable. The global audit should inform the remaining UI design. |
| Give Windows coverage one environment owner | The broad parity plan and narrower lifecycle plan both propose Windows runner/isolation infrastructure. Let the parity plan own the shared environment and ledger, and let lifecycle coverage own install/update/removal scenarios. |
| Align package-source, user-content, backup, and dependency plans | These plans propose overlapping package provenance, workspace layout, ownership, and cleanup contracts. Their sequencing should be explicit before any storage migration. |

## Findings shared across plans

### Completed work is not consistently reflected in the starting point

| Area | Verified current evidence | Backlog correction |
| --- | --- | --- |
| Storage | [Retention registry](../../modules/retention/registry.mjs), [policy engine](../../modules/retention/policy.mjs), [store CLI](../../scripts/cli/maintenance-stores.mjs), and `check_store_bounds` in [doctor](../../scripts/doctor.sh) | Update the generated-stores plan; preserve the separate question of telemetry history depth. |
| npm release | [Publication script](../../scripts/release/publish-npm.sh), [tag promotion](../../scripts/release/promote-npm-latest.sh), [package scripts](../../package.json), and [release guide](npm-release.md) | Replace “unpublished skeleton” and `beta.0` as current facts. The checkout declares `0.1.0-beta.8`; that alone does not prove a registry publication. |
| Repository scope | [Tokens route](../../scripts/cli/portal-routes-telemetry.mjs) reads the shared `repo` URL key, and [Tokens page](../../portal/tokens/app.js) uses shared repository scope | Remove the pending repository-selector task from the report-scope plan. Its described future `repository` parameter contract is also stale. |
| Codex permission prompts | [Permission hook](../../globals/system/hooks/codex/permission-check.mjs) emits `allow`, `deny`, or `ask`; [provider metadata](../../globals/harnesses/codex/provider.json) still declares `perCommandAsk: false` | Reconcile implementation, metadata, and fidelity scenarios. Static renderer omission of an `ask` rule no longer establishes the absence of prompting. Live effectiveness remains a separate check. |
| Plan commands | [Atomic CLI](../../scripts/cli/plans-command.mjs) already provides validation, lifecycle operations, preflight, approval, and landing checks | Refresh older proposals that describe `plans validate` as new or rely on generic portal lifecycle mutation. |
| Browser testing | [Playwright runner](../../scripts/test/portal-ui/run.mjs) and existing specs are wired through [package scripts](../../package.json) | Replace the package walkthrough's next action to “wire Playwright.” Recording and real end-to-end capture are separate questions. |
| Coding conventions | [Completed conventions work](../plans/completed/agent-config-code-quality-conventions.md) and current [code-style skill](../../globals/packages/code-style/skills/code-style/SKILL.md) removed line-count-driven splitting | Remove mandatory 150/200-line caps from the skill-reference, backup, reference-integrity, live-eval, and Windows-lifecycle proposals. Refresh the Tokens plan's size-guideline justification too. |

### Metadata and validation

The repository's canonical validator returned exit code **1**. Its full-tree result was 131 plans, 301 findings, and 21 blocking findings. Filtering that captured result to backlog gives:

| Measure | Result |
| --- | ---: |
| Backlog Markdown records | 49 |
| Findings | 81 |
| Advisory findings | 75 |
| Blocking findings | 6 |
| Plans with findings other than legacy IDs | 16 |
| Legacy-ID advisories | 23 |

Legacy IDs are valid and should remain stable. The six backlog blocking findings are the missing frontmatter, IDs, and next actions on the two nested lifecycle notes. Missing priorities and structure are advisory findings. A missing recognized heading does not itself establish that the underlying idea is obsolete.

**Preserve User Data Across Installations and Macs** has a dangling `related` value, `telemetry-analyze-single-pass-perf`. The completed performance plan uses `telemetry-analysis-io-performance`; confirm that is the intended relationship before replacing it.

Other recurring corrections:

- Replace placeholder next actions in **User-Managed Packages And Add Workflows** and **Wrap-Up Codex Invocation and CodeRabbit Integration**.
- Refresh references to the old `plan-start` workflow to match `plan-execute` where the current workflow is intended.
- Replace nonexistent package scripts such as `test:plans`, `test:plans-findings`, `test:plans-portal-state`, and `test:telemetry-marker-cli` with commands selected from current [testing guidance](testing.md), [package scripts](../../package.json), and the actual check files.
- Distinguish dependencies already in `completed/` from unresolved prerequisites. For example, **Windows Provider Path Schema** still lists the completed provider architecture as a blocker.
- Treat body labels such as “Status: active” as stale prose; the folder owns lifecycle.

## File-by-file recommendations

### Packages and distribution

| Plan | Recommendation and evidence |
| --- | --- |
| [One Package State Model: What the User Chose, What Follows From It, What Is Live](../plans/backlog/package-desired-state-and-dependencies.md) (`o9zwxuav`) | **Keep as the package-state owner.** [Rules rendering](../../scripts/cli/rules-render.mjs) still owns enabled-package state; [enablement](../../scripts/cli/packages.mjs) still recursively enables required dependencies. The catalog normalizes `requires` without the proposed recommendations/selectability model. Refresh related-plan sequencing and archive the superseded reconciliation proposal. |
| [Package Registry vs Live State Reconciliation](../plans/archived/package-registry-live-state-reconciliation.md) (`package-registry-live-state-reconciliation`) | **Retire into the desired-state plan.** That plan explicitly says it incorporates this scope. Read-only live probes, status, reconciliation, and adoption already exist in [package tooling](../../scripts/cli/packages.mjs); do not replay those phases. Preserve the stable ID through archival. |
| [Add Required and Recommended Skill Relationships](../plans/backlog/package-add-required-and-recommended-skills-and-references.md) (`ejsc769o`) | **Keep, refresh the baseline.** The dependency-model prerequisite remains outstanding. The completed [coding-conventions plan](../plans/completed/agent-config-code-quality-conventions.md) already improved the review rubric and expressly left `implementation-review` unbuilt. Extract and reuse that current rubric rather than recreating an older version. |
| [User-Managed Packages And Add Workflows](../plans/backlog/package-user-managed-and-add-workflows.md) (`user-managed-packages-and-add-workflows`) | **Substantially refresh and narrow.** [Catalog loading](../../scripts/cli/package-catalog.mjs), presentation metadata, package inspect/reconcile/adopt-live, and skill/MCP creation primitives already exist. Typed `roborepo add` flows, export/removal guarantees, and first-class user-content ownership remain proposals. Give this a real next action and settle its overlap with configurable sources. |
| [Decouple Platform Distribution from Configurable Sources](../plans/backlog/package-multi-source-distribution.md) (`jdsobwn`) | **Keep as a larger design, explicitly sequence it.** [Catalog loading](../../scripts/cli/package-catalog.mjs) still composes bundled and workspace packages; [the npm allowlist](../../package.json) still includes `globals/`. Multiple source adapters, immutable remote artifacts, provenance, and unbundling remain substantial new work. Coordinate ownership/layout with user content and profile backup before implementation. |
| [Separate Package Resource Semantics from Provider Delivery](../plans/backlog/package-resource-provider-delivery.md) (`7k3m9qd`) | **Keep, coordinate with targeting and Antigravity.** [Catalog normalization](../../scripts/cli/package-catalog.mjs) and [provider contracts](../../scripts/harnesses/contract.mjs) still use resource types and capability adapter groups; a serialized package-wide delivery plan is a distinct proposal. Declare which part must land before the provider migration. |
| [Package & User-Content CLI Test Guide](../plans/backlog/package-cli-test-guide.md) (`package-cli-test-guide`) | **Move useful walkthrough material into maintained testing documentation, or reduce to recording coverage.** Playwright is already installed and wired in [the runner](../../scripts/test/portal-ui/run.mjs). Recheck every walkthrough command against current help; do not keep browser installation as the next action. Its user-content dependency remains unresolved. |
| [RoboRepo Packaging 03: Publish npm Releases](../plans/backlog/infra-packaging-03-npm-release.md) (`1rajbd5o`) | **Refresh; do not mark wholly complete.** Local publishing, prerelease/tag safeguards, and documentation exist in [release tooling](../../scripts/release/publish-npm.sh). [CI](../../.github/workflows/ci.yml) has no publication job. Separate shipped local tooling from remaining metadata, CI/auth configuration, registry verification, stable-release, and soak acceptance. |
| [RoboRepo Packaging 04: Distribute Through Homebrew](../plans/backlog/infra-packaging-04-homebrew.md) (`qjsbhel5`) | **Keep, refresh its prerequisites.** No formula is tracked in this checkout; an external tap was not checked. Shared lifecycle work is completed and local npm release tooling exists. The remaining dependency is an agreed release artifact/channel contract, not building npm packaging from scratch. |
| [Let Users Review First-Run Configuration in Browser or Terminal](../plans/backlog/package-first-run-onboarding.md) (`v6lvuu2`) | **Keep, refresh the lifecycle and route baseline.** [Initialization state](../../scripts/cli/initialization-state.mjs) exists, while [presets](../../scripts/cli/presets.mjs) still supply the live wizard. The staged shared draft and dedicated setup experience remain distinct from completed onboarding iterations. The plan's route list is stale relative to the current Home page. Coordinate with Home calls to action. |

### Agent configuration and skills

| Plan | Recommendation and evidence |
| --- | --- |
| [Codex Cmux Hook Trust Review](../plans/backlog/agent-config-codex-cmux-hook-trust.md) (`codex-cmux-hook-trust-review`) | **Keep as an investigation.** Completed security work does not establish cmux's current launch arguments or hook-source trust behavior. Reproduce with versioned live evidence before choosing a warning or enforcement response. This audit did not certify those external claims. |
| [Keep local agent work within useful boundaries: Codex — Part 2: Credential protection](../plans/backlog/harness-codex-sandbox-boundaries-and-provider-leaks.md) (`4zyo2woj`) | **Keep, revalidate the enforcement design.** [The Codex hook](../../globals/system/hooks/codex/permission-check.mjs) classifies command prefixes; it does not implement the proposed credential-path argument scanner. An argument scanner's coverage limits and current native capabilities must be established before promising full read-security parity. |
| [Rough Draft: Harness Incident Logging and Evidence Capture](../plans/backlog/agent-config-harness-incidents.md) (`8ac41f2d`) | **Keep as a low-priority draft.** The inspected [CLI catalog](../../manifests/platform/cli/command-definitions) and [state paths](../../scripts/cli/state-paths.mjs) do not expose the proposed incident workflow. Evidence consent, automatic candidates, and retention remain real product decisions; telemetry analytics completion does not satisfy them. |
| [Native Skill Tooling Coverage](../plans/backlog/agent-config-native-skill-tooling.md) (`native-skill-tooling-followups`) | **Refresh and reduce.** [Doctor](../../scripts/doctor.sh) already reports unmanaged skill drift. Metadata detail, an adoption feature report, and pinning remain separate enhancements; basic unmanaged reporting should not be treated as entirely new. Coordinate pin/provenance storage with package sources. |
| [Audit Global Agent Permissions Management](../plans/backlog/agent-config-permissions-global-audit.md) (`permva27`) | **Keep; use its findings before the UI rewrite.** [Global configuration](../../scripts/cli/config.mjs) and [permission rendering](../../scripts/harnesses/permissions-render.mjs) still mediate native settings. Include the demonstrated hook-versus-provider-metadata contradiction in the audit. No live cross-harness permission audit was performed here. |
| [Permissions UI Revamp](../plans/backlog/agent-config-permissions-ui-revamp.md) (`permissions-ui-revamp`) | **Rewrite the motivating defect and acceptance cases.** [The hook](../../globals/system/hooks/codex/permission-check.mjs) now provides the per-command decision path described as absent. [Provider metadata](../../globals/harnesses/codex/provider.json) still reports degraded behavior, so fidelity remains relevant. Gate/scope simplification is still a design choice and should follow the global audit. |
| [Inspect Repository Agent Configuration in the Portal](../plans/backlog/agent-config-repository-inspector.md) (`nrvwti51`) | **Keep.** [The repository branch of the Agents page](../../portal/config/app.js) still renders the repository splash. Global inventory components and provider discovery are reuse opportunities, not proof that the repository inspector shipped. Normalize section headings before promotion. |
| [Skill Reference Docs & Portal Conventions](../plans/backlog/agent-config-skill-reference-docs.md) (`skill-reference-docs-and-conventions`) | **Split and consolidate.** The [framework-less markup reference](../../globals/packages/javascript-typescript/skills/javascript-typescript/references/framework-less-markup.md) exists, [reference compliance](../plans/completed/agent-config-skill-reference-compliance.md) has separate completed work, and [portal architecture](portal-architecture.md) is a maintained home. Preserve any remaining umbrella-trigger or automatic-review decision explicitly; remove retired line caps and avoid another general conventions plan. |
| [Skills vs. Commands: Invocation & Risk Policy](../plans/backlog/agent-config-skills-vs-commands-policy.md) (`skills-vs-commands-invocation-policy`) | **Reduce to unresolved decisions.** The plan itself lists the audit generator, trigger checker, rendering, risk metadata, and manual-entrypoint validation as shipped, and [catalog code](../../scripts/cli/package-catalog.mjs) confirms the model. Remaining command presentation, broader trigger coverage, and native manual-only semantics need focused tasks. Coordinate native invocation with the Wrap-Up proposal. |
| [Wrap-Up Codex Invocation and CodeRabbit Integration](../plans/backlog/agent-config-wrap-up-coderabbit.md) (`wrap-up-coderabbit-integration-plan`) | **Split and refresh.** [Codex provider metadata](../../globals/harnesses/codex/provider.json) still declares a commands directory, while [Session Close](../../globals/packages/session-close/skills/session-close/SKILL.md) has no CodeRabbit integration. The proposed native invocation correction affects all command packages and should have one owner; optional external review should consume the shared review rubric. Replace its placeholder next action and revalidate upstream contracts. |

### Harness providers and Windows

| Plan | Recommendation and evidence |
| --- | --- |
| [Capability-Derived Resource Targeting](../plans/backlog/harness-capability-derived-resource-targeting.md) (`harness-capability-derived-resource-targeting`) | **Refresh substantially.** [Plan Write's package](../../globals/packages/plan-write/package.config.json) already names Claude, Codex, and Gemini; the “seven closed pairs” count is stale. Declarative capability targeting remains useful. The prioritized Codex-ask phase has implementation in [the hook](../../globals/system/hooks/codex/permission-check.mjs), so replace that next action with remaining targeting and fidelity work. |
| [Antigravity CLI Provider Integration](../plans/backlog/harness-antigravity-cli-integration.md) (`antigravity-cli-provider-integration`) | **Keep, revalidate before implementation.** [Gemini remains registered](../../globals/harnesses/gemini/provider.json); this checkout has not performed the planned retirement. The plan already marks several native paths/capabilities unverified. Migration, deprecation scope, and plugin delivery need current authenticated evidence; do not infer them from old binary strings alone. |
| [Keep local agent work within useful boundaries: Claude](../plans/backlog/harness-claude-worktree-entry-and-provider-leaks.md) (`46qth5z8`) | **Keep, refresh renamed workflow references.** [Hook composition](../../scripts/cli/hook-composition.mjs) still branches on Codex and [provenance](../../modules/developer-runtime/provenance.mjs) still hardcodes Claude/Codex patterns. The old `plan-start` references must be reconciled with current `plan-execute`. The fresh-desktop deny test remains a prerequisite, not a verified result. |
| [Harness Parity Across Providers](../plans/archived/harness-parity.md) (`harness-parity-todo`) | **Consolidate, then archive the umbrella.** Most entries explicitly record delivered work. Dependencies and invocation have focused owners. Preserve the unresolved local/global override policy under a named owner; do not drop it while retiring the historical checklist. |
| [Windows Provider Path Schema](../plans/backlog/os-windows-provider-path-schema.md) (`windows-provider-path-schema`) | **Rewrite the current-state premise; retain manifest-driven resolution if still needed.** [PowerShell currently uses `USERPROFILE/.claude`](../../scripts/install/install-windows.ps1), not the plan's claimed `APPDATA/Claude`. [Path expansion](../../scripts/harnesses/paths.mjs) remains home-relative, and the installer still has a provider switch. Determine actual supported Windows paths before adding an environment-variable schema; remove the completed architecture blocker. |
| [Verify installation, updates, and removal on Windows](../plans/backlog/os-windows-lifecycle-coverage.md) (`0pzhhong`) | **Keep, assign shared runner setup to the parity plan.** [CI](../../.github/workflows/ci.yml) still runs only the static Windows installer check. Real lifecycle/ownership scenarios are missing from that job. Remove the superseded file-size cap and coordinate isolation, prerequisites, and artifacts with the broader environment plan. |
| [Windows Test Environment and Behavior Parity](../plans/backlog/os-windows-test-environment-and-parity.md) (`l1mz96d9`) | **Keep as the environment/coverage owner.** [CI](../../.github/workflows/ci.yml) confirms the narrow static Windows job. Its first real behavior matrix remains useful, but lifecycle scenarios should be owned once, and broad subsystem coverage should not imply that macOS-only capabilities have Windows implementations. |

### Storage, Git, runtime, and telemetry

| Plan | Recommendation and evidence |
| --- | --- |
| [Generated State Stores: Inventory, Retention, and Visibility](../plans/backlog/infra-generated-state-stores.md) (`n8kw3rp2`) | **Reduce to residual work.** [Retention tooling](../../modules/retention/registry.mjs) and [doctor integration](../../scripts/doctor.sh) invalidate “no shared inventory/visibility.” The collector and derived skills-cache policy still need review. A days-based telemetry window, truncation disclosure, disk-share warnings, and atomic-write reuse are not established as delivered; preserve those decisions rather than declaring this plan complete. |
| [Preserve User Data Across Installations and Macs](../plans/backlog/infra-portable-user-profile-backup.md) (`74h2tlim`) | **Keep, refresh contracts and relationships.** [Roots](../../scripts/cli/roots.mjs) still separate app/workspace/state without the proposed profile/records/machine layout. [Telemetry backup](../../scripts/cli/telemetry.mjs) is not a portable profile restore workflow. Fix the dangling performance relationship, remove retired size rules, and reconcile new source/provenance storage before migration. |
| [Git Exec Consolidation](../plans/backlog/git-exec-consolidation.md) (`git-exec-consolidation`) | **Keep, expand the inventory before editing.** Private unbounded `spawnSync` wrappers remain in [Plans](../../modules/plan-suite/index.mjs), [capture](../../scripts/cli/telemetry-capture.mjs), and [markers](../../scripts/cli/telemetry-markers.mjs). Capture also has a separate direct Git call for a diff fingerprint. Refresh missing test-script names and audit the claimed security benefits per actual Git operation. |
| [Runtime Remote Branch Status](../plans/backlog/developer-runtime-remote-branch-status.md) (`developer-runtime-remote-branch-status`) | **Keep as an unresolved product choice.** [Runtime Git](../../modules/developer-runtime/git.mjs) supplies local-ref status; the proposed forge-data source is distinct. Completed Git-health and metadata work does not establish live PR/CI status. Decide opt-in, authentication dependency, caching, and freshness semantics before implementation. |
| [Tokens Report: Scope Controls and Deeper Change Comparison](../plans/backlog/telemetry-tokens-report-scope-and-comparison.md) (`nl40n9vr`) | **Refresh the shipped scope and performance baseline.** Shared repository scope exists in [routes](../../scripts/cli/portal-routes-telemetry.mjs) and [the page](../../portal/tokens/app.js). Range/harness/model controls and deeper comparisons remain proposals. Fold in completed [analysis performance](../plans/completed/telemetry-analysis-io-performance.md) and [oracle](../plans/completed/telemetry-analytics-oracle-live-observer.md) work when reassessing payload/analytics tasks. Remove the retired size guideline. |
| [Unify Repository Attribution and Add Telemetry Reset Controls](../plans/backlog/telemetry-repository-attribution-and-reset.md) (`nt33p9jn`) | **Keep, coordinate reset semantics with storage tooling.** [Registry aliases](../../modules/repositories/registry.mjs) and shared repository scope already exist, but the inspected [Tokens routes](../../scripts/cli/portal-routes-telemetry.mjs) do not expose the proposed selective reset workflow. Existing store reset and telemetry purge are starting points; validate alias behavior across cohorts/cache keys before changing attribution. |
| [Telemetry Content Fingerprints: Skill and Rule Revision Tracking](../plans/backlog/telemetry-content-fingerprints-revision-tracking.md) (`f0j4j8y2`) | **Keep, update the schema starting point.** [Snapshot schema v2](../../scripts/cli/telemetry-schemas/snapshot-schema.mjs) hashes configuration and ambient package-resource evidence, not the proposed per-file content revisions. The conditions prerequisite is complete. Extend the existing v2 contract rather than replaying earlier snapshot design. |
| [Verify the End-to-End Token Capture Path](../plans/backlog/telemetry-portal-capture-path.md) (`u8211thb`) | **Keep.** [Browser empty-state tests](../../scripts/test/portal-ui/portal-ui.spec.mjs) stub report responses, while the [completed oracle](../plans/completed/telemetry-analytics-oracle-live-observer.md) explicitly excludes capture wiring and browser rendering. Neither proves the proposed joined discovery → enablement → installed hook → production capture → visible report scenario. |

### Plans and portal

| Plan | Recommendation and evidence |
| --- | --- |
| [Plan Lifecycle Suite 05 — Blockers and Dependencies](../plans/backlog/plan-lifecycle-suite-blockers-dependencies.md) (`plan-lifecycle-suite-blockers-dependencies`) | **Keep, refresh around the shipped atomic suite.** [Lifecycle policy](../../modules/plan-suite/lifecycle-policy.mjs) and [CLI](../../scripts/cli/plans-command.mjs) exist; manual reasons and blocker mutation are still a proposed extension. `blocked_reasons` changes the accepted frontmatter contract and needs explicit schema ownership. Remove the completed lifecycle prerequisite from the next action and refresh obsolete API/test references. |
| [Unclassified Plan Recovery](../plans/backlog/plan-lifecycle-suite-unclassified-plan-recovery.md) (`plan-unclassified-plan-recovery`) | **Keep but rebase the recovery design.** [The portal](../../portal/plans/app.js) still conditionally exposes Unclassified; guided recovery is distinct from deterministic validation. Older generic move/repair references must align with [current atomic commands](../../scripts/cli/plans-command.mjs). The two nested notes are metadata-invalid backlog documents, not root-level unclassified files. |
| [Surface Plan Reference Integrity Where Plans Are Edited](../plans/backlog/plan-reference-integrity-surfacing.md) (`p3vbk03v`) | **Reduce to document-path integrity and any missing real-tree coverage.** [Validation CLI](../../scripts/cli/plans-command.mjs) already exists and [findings](../../modules/plan-suite/findings.mjs) already cover ID relationships. `DOC_LINK_NOT_FOUND` is still a proposal. Update command signatures, lifecycle scope, test names, historical plan counts, and the removed line cap; keep advisory link findings distinct from blocking exit semantics. |
| [Plans Portal — Live Refresh and Static Slash-Command Preflight](../plans/backlog/portal-plans-live-refresh.md) (`plans-portal-live-refresh-and-static-preflight`) | **Split into two optional decisions.** [Plans routes](../../scripts/cli/portal-routes-plans.mjs) have refresh but no events route; the [page](../../portal/plans/app.js) has manual refresh and synchronization polling rather than the proposed general file-change subscription. Portal lifecycle mutation described as shipped in this plan is no longer the current API. Static command help is a separate native-invocation concern. |
| [Walk New Users Through Setup from the Home Page](../plans/backlog/portal-home-onboarding-calls-to-action.md) (`rtkmc8kf`) | **Keep, coordinate with staged first-run setup.** [Home](../../portal/home/app.js) still renders independent setup/harness notices rather than the proposed four-step sequence. Completed Home and onboarding work supplies the reusable baseline, not this exact sequence. Settle whether this guides ongoing setup or duplicates the future `/setup` experience. |

### Session launching, tests, and status lines

| Plan | Recommendation and evidence |
| --- | --- |
| [Session Launching — Milestone 1: macOS Core Workflow](../plans/backlog/session-launching-milestone-1.md) (`plan-session-launching-milestone-1`) | **Keep, refresh architecture and commands.** The provider contract declares session launch but [Claude](../../scripts/harnesses/claude/index.mjs) and [Codex](../../scripts/harnesses/codex/index.mjs) provide stub launch groups. That is not the proposed session store/service/UI. Reuse current atomic lifecycle and provider boundaries; replace `serve` and missing test-script references where stale. |
| [Session Launching — Milestone 2: Reliability and Multi-Terminal Workflows](../plans/backlog/session-launching-milestone-2.md) (`plan-session-launching-milestone-2`) | **Keep behind milestone 1, retain as provisional scope.** Reconciliation, terminal registration, and concurrency policies depend on a real launch lifecycle. Do not promote incident-driven choices before milestone 1 produces evidence. Reuse [retention policy](../../modules/retention/policy.mjs) where appropriate instead of designing bounds from scratch. |
| [Session Launching — Milestone 3: Cross-Platform Adapters](../plans/backlog/session-launching-milestone-3.md) (`plan-session-launching-milestone-3`) | **Keep behind milestones 1–2, coordinate Windows prerequisites.** [CI's Windows job](../../.github/workflows/ci.yml) is still static; the broader Windows environment plan should own general runner setup. Concrete adapter filenames and platform promises must follow the macOS implementation rather than this early sketch. |
| [Live Evals for Skill Routing and Plan Closing](../plans/backlog/test-agent-behavior-evals.md) (`0jped168`) | **Keep, refresh the baseline and scope the claim.** [Package scripts](../../package.json) still have no eval runner. However, [completed conventions work](../plans/completed/agent-config-code-quality-conventions.md) records live-agent samples, so “none of the claims has evidence” is too broad. A repeatable hermetic routing/closure runner remains new work. Refresh `plan-start`, scenario contracts, counts, and retired size rules. |
| [Tier and Diff-Scope Validation](../plans/backlog/test-validation-tiers-and-diff-scoping.md) (`q6lj4w96`) | **Keep.** [Package scripts](../../package.json) have scoped commands but not the proposed composed `check:*` tiers; [CI](../../.github/workflows/ci.yml) still runs the same full gate on its Linux/macOS matrix. Refresh the inventory of suites, especially oracle and browser checks, before proposing skip rules. |
| [Usage Statusline — Claude Idle Refresh Property](../plans/backlog/usage-statusline-claude-refresh.md) (`usage-statusline-claude-refresh`) | **Keep as upstream research, not a ready configuration change.** [The shipped statusLine fragment](../../globals/packages/usage-statusline/claude/statusline.json) has command and padding settings without a refresh interval. This audit did not establish that a supported native refresh key exists. Confirm it and its minimum version before implementation; otherwise record an accepted limitation. |
| [Usage Statusline — Codex Footer Parity via an Upstream Hook](../plans/backlog/usage-statusline-codex-parity.md) (`usage-statusline-codex-hook-parity`) | **Keep externally contingent, revalidate the blocker.** [The package fragment](../../globals/packages/usage-statusline/codex/status-line.json) still selects native footer fields. Current upstream command-hook availability was not verified. Existing native selections are not command-rendered parity; filing the drafted request requires a separate explicit instruction. |

### Legacy documents and archive

| File | Recommendation and evidence |
| --- | --- |
| [Historical plan ZIP](history/plan-lifecycle/repository-plans-snapshot.zip) | **Remove from active backlog after historical-content review.** Archive listing contains only `portal-repository-scope.md` and `portal-repository-home-and-detail.md` under old backlog paths. Both [repository scope](../plans/completed/portal-repository-scope.md) and [home/detail](../plans/completed/portal-repository-home-and-detail.md) have completed plan records. The old ZIP is not an additional implementation proposal. |

## Suggested cleanup order

1. Archive the duplicate reconciliation plan with a reference to its surviving owner; preserve its stable ID.
2. Preserve the two design notes in an appropriate historical home and remove the ZIP from active backlog after checking whether any old design detail is worth keeping.
3. Refresh factual regressions: Windows path premise, Codex prompt support versus metadata, npm tooling, shared repository scope, removed commands, and retired size limits.
4. Reduce storage, invocation policy, skill-reference, and reference-integrity proposals to their actual remaining work.
5. Resolve ownership between Windows plans, between the onboarding plans, and across package sources/user content/profile storage. Preserve the remaining parity-policy decision before archiving its umbrella.
6. Re-run plan validation after any actual cleanup and inspect inbound relationships before moving or deleting records. Use lifecycle archival for managed plans; a folder move alone does not record retirement rationale.

## Verification and limits

```text
node scripts/cli/main.mjs plans validate --json
  Exit 1: full tree 131 plans / 301 findings / 21 blocking.
  Backlog subset: 49 records / 81 findings / 6 blocking.
unzip -l docs/plans/backlog/roborepo-repository-plans.zip
  Two historical plan copies, both with completed counterparts.
npm run check
  Not run: review/documentation only; no implementation changes.
```

Code and test inspection establishes what is represented in this checkout, not runtime correctness. No plan was moved to completed, no approval was inferred, and external integrations were not exercised.

## Applied follow-up (2026-10-21)

The user authorized all recommendations after the audit. All 45 remaining backlog plans were
synchronized, keeping stable IDs and unresolved scope. The reconciliation and parity umbrellas
were archived through canonical transitions (commits `f7d7d6fb` and `c2d5b5dc`); both had no
assigned worktree. The remaining local/global precedence decision now belongs to the invocation
policy plan. No active or review worktree was moved or modified.

The two legacy notes and ZIP were preserved under `docs/internal/history/plan-lifecycle/`. A
maintained user-content testing runbook now lives in `docs/internal/package-user-content-testing.md`,
and its stable backlog plan tracks only unfinished joined coverage and recording.

Current-state corrections, remaining tasks, owner boundaries, completed prerequisites, next
actions, schema headings, command references, and retired size rules were updated. The pre-existing
priority increase in the Claude worktree-entry plan was retained. External runtime/release research
remains explicitly unverified; no upstream issue, publication, or configuration change was made.

The original counts and recommendations above remain the initial audit snapshot. Follow-up checks:

```text
node scripts/cli/main.mjs plans validate --json
  Backlog: 45 records, 0 blocking findings, 21 legacy-ID advisories only.
  Full tree: exit 1, 129 records, 253 findings, 15 pre-existing blockers in completed/.
bash scripts/doctor.sh --quiet
  Passed all 102 checks.
git diff --check
  Passed.
Identity, priority, links, and historical-file preservation checks
  All 45 surviving IDs/priorities retained; backlog/report links resolve.
  Both historical notes and the ZIP are byte-identical to their original copies.
npm run check
  Not run: plan/documentation changes only; no executable, generated, or test-orchestration changes.
```

## Later scope correction

At the user's request, obsolete lifecycle-state proposals were removed from the relocated design
notes and the blocker plan. Earlier byte-preservation results describe the original move; the
notes now intentionally differ from those originals. The historical ZIP remains unchanged.

## Lifecycle proposal cleanup

The user subsequently retained only live running-step tracking, plan-skill handoffs, and
simultaneous-launch protection. The two relocated proposal notes were deleted at the user's
request. The [lifecycle follow-up index](history/plan-lifecycle/README.md) identifies the owners
and remaining questions. Earlier preservation statements above describe the initial audit, not
the current contents. The historical ZIP is unchanged.
