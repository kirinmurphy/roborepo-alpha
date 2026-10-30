---
id: 4zyo2woj
priority: high
next_action: Run /plan-review to review the post-approval changes and renew human approval, then rerun /plan-close with a passing completion gate. The branch landed; approval is stale and the aggregate gate timed out at portal startup although its focused retry passed.
blocked_by: []
depends_on: ["hr78g4sj"]
related: ["8bjltk2n", "wjlt1zvf", "ia1q1z9", "permva27", "permissions-ui-revamp", "codex-cmux-hook-trust-review", "46qth5z8", "harness-capability-derived-resource-targeting", "7k3m9qd", "o9zwxuav"]
reviewed_commit: 60d2ba76e5a9ca0cc5dbb5d98ab73330c674d5de
worktree: credential-protection
---

# Keep local agent work within useful boundaries: Codex — Part 2: Credential protection

## Summary

Make known credential paths unavailable to sandboxed Codex processes using native filesystem
read-and-write denial. Reuse RoboRepo's existing credential-pattern list, preserve readable templates
and unrelated configuration, and report exactly which runtime/tool surfaces are covered.

This retains the original credential-follow-up id and recorded synthetic evidence. Provider cleanup
is now owned by Part 1; isolated app/browser execution is owned by Part 3.

## Context

The original write-scope plan (`ia1q1z9`) showed that restricting writes did not also restrict
credential reads. Local main at `60d2ba76` still renders Codex workspace roots and a network boolean
without credential-denial entries. Its read-only branch selects `:read-only` directly and renders
no filesystem entries either. The user selected native denial even though matching files
also become unwritable. Host networking remains restricted throughout this work.

| Layer | Responsibility |
| --- | --- |
| Native sandbox | Enforces file reads/writes and process network restrictions |
| Approval policy | Decides when a requested operation needs approval |
| Command hook | Classifies commands; it is not the proposed credential scanner |
| Hook trust | Determines whether installed hooks run; native file denial must not depend on it |
| Desktop/organization policy | May constrain effective settings; verify it separately |

| Existing source | Behavior to preserve or extend |
| --- | --- |
| `manifests/inventory/agent-permissions.json` | `read-secrets` is the credential-pattern source; `.env` variants are enumerated so `.env.example` and `.env.sample` remain readable |
| `scripts/harnesses/codex/index.mjs` | Resolves behavior overrides and calls the pure renderer; owns native projection and runtime-specific reporting |
| `scripts/harnesses/permissions-render.mjs` | Codex profile generation and `foreignBlockContent`; extend or delegate Codex-specific projection without changing Claude rendering |
| `scripts/cli/permissions-render.mjs` | Live render orchestration passes workspace roots, but currently supplies no explicit target-home option; preserve target creation rules and logged writes |
| `scripts/build/render-agent-permissions.mjs` | Build-time provider rendering passes a synthetic home; keep tracked output portable and distinct from live home materialization |
| `generated/codex/config.toml` | Derived install baseline; regenerate through provider adapters after source changes |
| `scripts/test/codex-permissions-foreign-lines-check.mjs` | Protect merged foreign-line preservation from `8f17eb2f`, including `notify` and unrelated tables |

### Series and prerequisites

```mermaid
flowchart LR
  P1[Part 1: Provider cleanup] -->|must land before| P2[Part 2: Credential protection]
  P1 -->|must land before| P3[Part 3: Isolated browser testing]
  P2 -->|must land before| P3
```

| Part | Plan | Ownership |
| --- | --- | --- |
| 1 | [[hr78g4sj]] | Provider routing, hook source ownership, headless invocation; mandatory prerequisite |
| 2 | This plan | Credential protection and historical characterization evidence |
| 3 | [[8bjltk2n]] | Disconnected app/browser workflow and scoped approval verification |

Part 1 landed through squash merge `b79bf35dac5f6c430c85b1352331a8c943d61038`, an ancestor
of current main. Its provider-owned sources, standalone manifest lookup, hook ownership/trust
safeguards, and declared headless invocation were rechecked against current code and focused
assertions. The implementation prerequisite is satisfied; `depends_on` retains the series
relationship and `blocked_by` is empty. Part 3 still requires credential protection to land before
using source staging. This plan does not relocate hooks itself.

### October 26 repository reconciliation

Verified against local main `60d2ba76e5a9ca0cc5dbb5d98ab73330c674d5de` in the primary checkout.
Origin identifies `kirinmurphy/roborepo-alpha`; its directory name is `roborepo`. Remote freshness
was not checked. The initial preparation read the related plans and Part 1 worktree copy; the
post-merge review rechecked Part 1's integrated record and the adjacent plan changes in its squash merge.

| Plan | Classification | Contract retained here |
| --- | --- | --- |
| [[hr78g4sj]] | Landed dependency; lifecycle/prose drift | Consume provider cleanup; close its review record separately |
| [[wjlt1zvf]] | Landed dependency | Preserve hook routing, logging, ownership, order, and readiness |
| [[ia1q1z9]] | Landed dependency; historical prose drift | Preserve write roots; supersede its Codex credential-read gap |
| [[8bjltk2n]] | Unlanded downstream dependency | Owns source staging, browser isolation, and repeat approvals |
| [[46qth5z8]] | Unlanded adjacent work; residual prose drift | Related-plan row now assigns Codex cleanup to Part 1; Claude entry/folders stay there |
| [[permva27]] | Unlanded adjacent audit | Owns editor/product decisions and broad fidelity audit |
| [[permissions-ui-revamp]] | Unlanded adjacent UI work | Consumes the audit; retains editor and gate/scope choices |
| [[codex-cmux-hook-trust-review]] | Unlanded adjacent study | Owns trust bypass research |
| [[harness-capability-derived-resource-targeting]] | Unlanded adjacent targeting work | Owns resource selection, independently of credential projection |
| [[7k3m9qd]] | Unlanded adjacent delivery work | Owns package delivery redesign; retain existing render integration here |
| [[o9zwxuav]] | Unlanded active adjacent package work | Owns selected/effective package and bundle state; no native credential projection |

Part 1's integrated review records explicit approval of implementation
`a8aa353fbb1b7cb45ad2822314385354b0f6f5f6`. Its feature tip `9facb7ee` need not be an ancestor
after squash: merge `b79bf35d` is an ancestor, and current code contains the accepted source and
headless contracts. The plan remains in `review/` with a merge/close next action and historical
unlanded prose. That is lifecycle/prose drift, not an implementation blocker. Closing it belongs
to its own workflow and was not performed in this review.

Hook-readiness squash `b134ef424292ece32822ce05efa5a41fc0df1fa8` is an ancestor of main.
Original reviewed commits need not be ancestors after squash. Current code confirms manifest-backed
hook routing, logged writes, per-file ownership, appended Codex entries, and provider readiness.
Its completed lifecycle needs no cleanup here.

Write-scope merge `e58a81927fb99bf460eb6a5ea9185224c2a585fd` and subsequent completion squash
`2d1dd799abc0234f4c9250793856b50d9975b4b0` are ancestors of main. Its later native evidence
contradicts older Not verified prose; historical prose cleanup remains separate. The Claude
companion's related-plan row now assigns Codex relocation to Part 1 and credential protection here.
Its introduction and non-goals still use older combined-companion wording; the approved series
split remains authoritative, with no unresolved scope choice.

Main installs Codex hook scripts from `globals/harnesses/codex/hooks` using `managed_files`,
retaining installed paths under `~/.codex/hooks`. Telemetry now selects an enabled eligible provider
and spawns its declared argv with a literal prompt. Codex's template is
`["exec", "--skip-git-repo-check", "--", "{prompt}"]`. Source relocation preserved standalone
state/app-root discovery, with its source-relative fallback corrected for the new depth.
The optional worktree-folder declaration remains deferred to the Claude companion and does not
block credential protection.

Capability-derived targeting remains adjacent, with its own unresolved resource-selection model.
This plan uses the existing provider `permissions.render` contract and a dedicated parity check;
it does not depend on that model or the audit's eventual product decision. The active package-state
plan [[o9zwxuav]] changes package selection and bundle dependencies, not native credential projection;
it introduces no additional implementation prerequisite here.

### Observed behavior

**Localhost, October 21, 2026.** During the hook-banner work, the browser-suite server failed inside
the Codex desktop session sandbox with `listen EPERM: operation not permitted 127.0.0.1`. Running the
suite with sandbox escalation succeeded, but repeated requests for local tests, portal inspection,
and restarts interrupted the user. This establishes a failure under that session's policy, not every
supported runtime's network capabilities.

**Reads and writes, Codex 0.140.0.** Recorded by `ia1q1z9` (repo-scoped write permissions) under the
profile then named `roborepo-workspace`:

| Path | Read | Write |
| --- | --- | --- |
| Active worktree | allowed | allowed |
| Sibling worktree of this repo (`~/.worktrees/roborepo/...`) | allowed | allowed |
| Primary checkout (outside `~/.worktrees`) | allowed | blocked (`Operation not permitted`) |
| `$HOME` (arbitrary file) | allowed | blocked (`Operation not permitted`) |
| `/etc/hosts` | allowed | — |
| `~/.ssh/config` | allowed | — |

`ia1q1z9` resolved the read question as "no hook needed" for its write-scope goal, and recorded
credential reads as this follow-up.

### October 23 characterization and decisions

All probes used synthetic fixture files. Native policy was supplied through temporary `-c`
overrides to `codex sandbox -P probe -C <fixture> -- <probe command>`; no installed permission
configuration was rewritten. The inner native sandbox could not start inside the chat sandbox
(`sandbox_apply: Operation not permitted`). The unrestricted control succeeded after explicit
sandbox permission, so the matrix ran there while the tested commands remained inside Codex's
native sandbox.

| Probe | Result | Evidence limit |
| --- | --- | --- |
| Baseline `:workspace` | Protected-directory fixture and `.env` readable; public and protected writes allowed | Synthetic paths only; no real credentials read |
| Native filesystem path and glob denial | Direct, shell, `xargs`, and symlink reads denied; protected writes denied; public file and `.env.example` readable | Passed positive/negative control assertions on macOS 0.163.0-alpha.11.2, not every manifest pattern or provider tool |
| New directory plus matching `.env` | Directory creation succeeded; writing its new `.env` was denied | Observed separately from startup-existing files; no Linux or Windows claim |
| Network disabled, local-binding flag changed | IPv4/IPv6 loopback binds and connections and wildcard bind denied | Does not run the app/browser suite |
| Proxy active, exact local allowlist, `allow_local_binding = true` | IPv4/IPv6 loopback binds and connections and wildcard bind allowed; direct reserved-address connect denied; HTTP proxy returned 403 for that destination | Fails the user's strict listener boundary despite these outbound checks |
| Proxy explicitly enabled, exact local allowlist, `allow_local_binding = false`, no upstream proxy | IPv4/IPv6 loopback binds and raw connections and wildcard bind denied; reserved-address HTTP request rejected with 403 | Fails the local test-server requirement |
| Loopback-to-nonloopback forwarding | Unavailable: host-side positive control timed out before the native test step | No forwarding success or failure is inferred |
| Disposable `node:22-bookworm-slim` runner | Only loopback interfaces; IPv4/IPv6 roundtrips passed; nonloopback connect returned `ENETUNREACH` | No host mounts, published ports, or downloads; native Codex and browser suite were not installed or run inside it |

The disposable-runner check used the already-installed image (Node v22.23.2) with:

```sh
docker run --rm --pull=never --network=none --cap-drop=ALL \
  --security-opt=no-new-privileges --read-only --user=node \
  -i node:22-bookworm-slim node --input-type=module -
```

Its assertions covered interface isolation, local roundtrips, and the unreachable external route.
A wildcard listener succeeds inside that namespace but has no nonloopback interface to expose it.
This differs from granting wildcard listeners or access to existing local relays on the host.

A read-only native `config/read` plus `configRequirements/read` query for this checkout returned
project, user, and system layers; effective `approval_policy = "on-request"`,
`default_permissions = "managed-workspace"`, and `features.network_proxy = true`; the selected
profile extends `:workspace`, has network disabled, and has no filesystem entries. The query
returned no managed requirements. This describes that CLI configuration lookup, not the policy
inherited by every existing desktop session. The sandboxed query timed out; the explicitly
permitted unrestricted query succeeded without a model call or config write.

The native fixture profile used these filesystem entries, expressed as equivalent TOML:

```toml
[permissions.probe]
extends = ":workspace"

[permissions.probe.filesystem]
"<fixture>/protected" = "deny"
"<fixture>/**/.env" = "deny"
```

The user selected **native read-and-write denial** for credential patterns and **strict
loopback-only enforcement** for networking. A heuristic command scanner is no longer the proposed
credential mechanism. The tested host-native networking combinations do not meet both strict
binding and working local test-server requirements. The user subsequently approved an isolated
app/browser runner; keep host networking disabled. A runner changes where tests execute and does not authorize host portal
restarts or solve fresh-session approval persistence.

Official guidance checked October 23:
[Permissions](https://learn.chatgpt.com/docs/permissions) distinguishes enabling command networking
from activating its filtering proxy; its local/private-target flag is not documented as a
listener-address allowlist. It also describes filesystem deny entries and platform-specific glob
behavior. The native probe results above, rather than those docs alone, establish the observed
macOS behavior.


## Goals

- Deny reads and writes to every credential path form the supported native mechanism claims.
- Preserve ordinary source reads, approved workspace/temp writes, and readable templates.
- Preserve foreign configuration and make unsupported tool/runtime states explicit.
- Supply verified credential protection before Part 3 stages source for the runner.

## Proposed design

### Credential-read enforcement

Render native filesystem `deny` entries from resolved `read-secrets` intent. The accepted boundary
denies both reads and writes to matching paths. Preserve the explicit template exceptions
(`.env.example` and `.env.sample`); do not replace the enumerated environment-file patterns with an
unrestricted `.env.*` glob. Normalize the manifest's home and absolute glob anchors for the native
provider, and test every pattern under synthetic roots before applying anything to a real home.
Use resolved behaviors after overrides: a resolved `deny` produces native denial; other buckets
must not silently retain denial or be advertised as credential protection. Do not invent native
path-specific prompting for `ask`; report unsupported intent explicitly.

The manifest currently has 15 patterns: five home-directory patterns and ten absolute-glob
patterns. Cover each independently, including `*.pem`, `id_rsa`, `id_ed25519`, and all enumerated
`.env` forms. Preserve native glob semantics rather than scanning only files present at startup.
Home anchors and Claude's `//` spelling need Codex-specific translation. Build output must contain
neither the packer's home nor the build script's synthetic `/Users/you` home as a literal deny
root. Verify whether the supported runtime resolves portable home anchors; if it requires concrete
paths, materialize against the target home only on live apply and test packed installation under a
different synthetic home. Never derive the target from the contributor's ambient home.

Keep native projection in the Codex provider, reusing the existing render/apply path. Preserve
`foreignBlockContent`, `notify`, unrelated tables, read-only mode, configured workspace roots, and
reapply idempotence. Apply the credential boundary in both writable and read-only modes; choosing
`:read-only` alone must not drop the denies. Use a named profile extending `:read-only` when
filesystem entries are needed, without adding writable roots. Keep the existing resolved network
policy and approval behavior intact in each mode. Document the accepted restriction on
credential-file edits and the fact that separately escalated processes require their own boundary
assessment; denial inside a native sandbox does not certify an unrestricted process.

Use a dedicated provider parity check, not a new required `permissions` method. Gemini remains
explicitly unsupported; Claude keeps its current renderer. This uses existing policy intent and
leaves the global audit's editor/product decision intact. Verify the selected runtime supports and
enforces the projection before reporting protection. Unsupported versions or inherited policy must
produce an explicit limitation, not a heuristic fallback or a confinement claim.

Native `codex sandbox` evidence concerns sandboxed processes. Establish separately which command,
structured-read, browser, MCP, and nested execution surfaces use that policy. No native process test
certifies all tools. Read effective managed requirements in each claimed runtime and verify native
denial in a fresh session. Record approval interactions as evidence only; the scoped repeat-approval
workflow stays with Part 3. Every coverage record must name the executable/version, platform, policy source,
profile, surface, controls, and result. Unsupported or unverified surfaces remain explicit and
cannot satisfy Part 3's source-staging prerequisite by inference.


## Implementation plan

### Confirm prerequisites and remaining coverage

- [x] Verify Part 1's final implementation landed and clear `blocked_by`. October 26 post-merge
      review confirmed squash `b79bf35d` is an ancestor of main; current provider routing, relocated
      sources, ownership/trust safeguards, logging, and foreign-config preservation were checked.
      Five focused checks passed; see Preparation verification below.
- [x] Resolve desktop and CLI executables through `scripts/harnesses/discovery.mjs`
      (`selectedHarnessExecutable`) and their provider detection data. Record versions and effective
      permission layers separately for each claimed runtime; do not add a hardcoded binary picker.
      Retain historical fixture results as scoped evidence, not certification of a newer runtime.
- [x] Extend fixtures across every `read-secrets` pattern, template exception, deep/new paths,
      links, and supported command/structured-read/nested-tool surface. Use synthetic files only.
- [x] Establish platform-specific glob behavior before claiming Linux or Windows enforcement;
      list unsupported or unverified surfaces explicitly.

### Implement native credential protection

- [x] Add dedicated Codex native-projection and enforcement parity checks, with explicit unsupported
      runtime/tool states. Preserve Gemini and the generic capability contract.
- [x] Add focused native-projection fixtures before implementation; assert missing denies fail.
      Cover all 15 manifest patterns, resolved deny/allow/ask intent, both write modes, TOML
      escaping, home and absolute anchors, templates, workspace roots, and idempotence.
      Extend `scripts/test/codex-permissions-foreign-lines-check.mjs` for both resulting profiles.
- [x] Add a synthetic native enforcement runner that consumes provider-rendered configuration,
      asserts an unrestricted positive control and sandboxed negative controls, and fails when
      denial is missing. A missing binary, unsupported platform, or unusable nested sandbox must
      report unavailable instead of passing. Record supported runtime/platform coverage separately.
- [x] Implement native filesystem denial from `read-secrets` in both writable and read-only Codex
      profiles. Preserve resolved intent, workspace roots, foreign config, and safe reapply; leave
      command classification in `permission-check.mjs` unchanged.
- [x] Register deterministic projection/parity checks in `scripts/test/check-groups.json` using
      existing group ownership. Missing or overstated coverage must fail; explicitly unsupported
      providers remain loadable without advertising protection. Keep native enforcement verification
      explicit so a skipped local probe cannot satisfy a claimed supported-runtime gate.
- [x] Pass any required target-home context through the existing live/build provider-render path,
      and extend live-render, packed-install, and clean-machine permission fixtures for target-home
      isolation, read-only denial, update/reapply, and preservation of unrelated settings.
- [x] Update every document listed under Documentation impact with the measured coverage and limits.
- [x] Verify live against the shipped Codex binary, since shell quoting and expansion only show up
      when a real shell runs the command.


## Validation

- Every known credential match is denied in both writable and read-only profiles for each claimed
  runtime/tool surface. Public fixtures and `.env.example`/`.env.sample` remain readable; approved
  workspace/temp operations retain their boundaries.
- Direct, shell, `xargs`, symlink, deep, and newly created credential fixtures have positive and
  negative controls. Rendered TOML or direct hook invocation alone does not prove native enforcement.
- Missing/overstated coverage fails dedicated parity checks; unsupported providers stay loadable
  without advertising protection. Claude behavior and the generic capability contract are retained.
- Reapply/update retains native denies, workspace roots, `notify`, unrelated keys/tables, and
  command-hook responsibilities. Native denial does not depend on hook trust or command parsing.
- Run the new deterministic projection/parity check and native enforcement runner (paths chosen
  during implementation), then the existing checks below. New check paths are deliverables, not
  commands available in the current checkout.
- Run `node scripts/test/permissions-render-live-characterization-check.mjs`,
  `node scripts/test/codex-permissions-foreign-lines-check.mjs`,
  `node scripts/test/permission-rule-home-path-check.mjs`,
  `node scripts/test/gemini-adapter-characterization-check.mjs`,
  `node scripts/test/root-config-write-policy-check.mjs`,
  `node scripts/test/hook-composition-check.mjs`, `npm run test:package-install`,
  `env CLEAN_MACHINE_STRICT=1 npm run test:clean-machine-permissions-sandbox`,
  `bash scripts/doctor.sh --quiet`, `git diff --check`, and `npm run check` before handoff.
- Run synthetic native enforcement checks with the actual supported Codex binary. Document
  separately which desktop, nested execution, browser, and MCP paths inherit the policy.

## Documentation impact

- `docs/user/reference/config-control-panel.md`: explain known credential patterns, both read/write
  denial, template exceptions, and unsupported provider/tool states.
- `docs/user/reference/codex-hooks.md`: distinguish native file denial from command-hook trust,
  approval, and sandbox escalation.
- `docs/internal/harness-provider-interface.md`: describe provider-native projection and dedicated
  parity without adding a universal enforcement method.
- `docs/internal/config-panel-internals.md`: document resolved intent, native anchor translation,
  target-home materialization, writable/read-only profiles, and shared build/live rendering.
- `docs/internal/testing.md`: list deterministic parity versus native enforcement checks, required
  runtime evidence, and unavailable-platform handling.

## Risks

| Risk | Mitigation |
| --- | --- |
| Credential edits also fail | User accepted read-and-write denial; document it and preserve template exceptions |
| Pattern projection widens or loses policy | Normalize anchors and test each pattern in both writable/read-only modes |
| One native process probe is presented as all-tool coverage | Characterize tool surfaces independently; report unsupported or unverified states |
| Re-rendering removes user config | Retain merged foreign-line handling and its regression coverage |
| Runtime or inherited policy cannot enforce the projection | Report the specific limitation; no scanner fallback or silent widening |

## Decision Log

- October 27 human review: the user explicitly selected "Accept documented coverage limits for
  this delivery (Recommended)" for desktop/product file tools, browser/MCP/escalated execution,
  and Linux/Windows. Reclassified the three unchecked Not tested tasks as coverage limitations
  below because verification of those surfaces is not required for this delivery. None is marked
  tested or protected. Future use of any unverified surface for protected source staging still
  requires independent boundary verification. This decision accepts coverage limits; it does
  not approve the implementation commit.

- October 22: split the Codex boundary work from the Claude companion, retaining this id because
  the landed write-scope plan references its credential-read gap.
- October 23: user selected native credential read-and-write denial and dedicated provider parity.
  Synthetic macOS 0.163.0-alpha.11.2 fixtures passed the matrix above. Host-native network candidates
  failed the selected strict boundary; the no-mount Node container established feasibility only.
- October 24: user adopted the isolated app/browser runner with strict host networking and separate
  host-portal restart approval. Those implementation requirements now belong to Part 3.
- October 24: user approved splitting the work and required provider cleanup first. This document
  becomes Part 2 while retaining `4zyo2woj`, its existing path/lifecycle, and the original probe
  evidence. Part 1 owns provider cleanup; Part 3 owns browser isolation. No implementation result,
  approval persistence, forwarding result, or other plan's completion is inferred from the split.
- October 24: at the user's request, return Part 2 from ready to backlog while retaining its id,
  title, evidence, and provider-cleanup prerequisite.
- October 26 initial preparation, before Part 1 merged: checked local main `d6b7fea2`,
  the Part 1 worktree at `9facb7ee`, related plans, render/apply sources, fixtures, and docs of record. Hook-readiness is landed;
  Part 1 remains unlanded despite its worktree's approval. Recorded it in `blocked_by`, reconciled
  stale ownership notes, specified target-home portability and read-only projection, and separated
  deterministic checks from native coverage. Preparation changes no feature code or related lifecycle.

- October 26 post-merge review: verified provider-cleanup squash `b79bf35d` on main
  `60d2ba76`, rechecked its source/headless contracts and five focused checks, and cleared the
  implementation blocker. Part 1's separate lifecycle closure remains outstanding. No credential
  enforcement implementation or new runtime certification is inferred from its merge.

### Implementation decisions

- Preserve portable runtime `~/` anchors rather than materialize homes during live apply. The
  native temporary-home assertion verified support; one projection serves generated, packed and
  live paths without ambient-home coupling or a new render contract.
- Keep read-only network disabled, matching the former built-in `:read-only` selection. The new
  named profile adds denial without writable roots or a new network grant; the writable profile
  retains its resolved network behavior.
- Use provider-owned credential translation called by the existing pure render core, with no
  universal permissions method. The alternative was generic provider enforcement API expansion,
  which the approved scope explicitly excludes.
- Keep native enforcement explicit rather than an availability-skipping CI check. Its unavailable
  exit is `2`; deterministic CI checks cover projection and prevent broader tool/platform claims.
  The test-orphan exemption records why the native runner is deliberately outside the CI group.
- Preserve the existing documentation shapes and owner map. Updated the five docs of record and
  repaired the related backlog-review link after the lifecycle move.

## Preparation verification

Post-merge review on main `60d2ba76` passed:

```text
node scripts/test/codex-permissions-foreign-lines-check.mjs
node scripts/test/permissions-render-live-characterization-check.mjs
node scripts/test/hook-composition-check.mjs
node scripts/test/shared-target-rows-check.mjs
node scripts/test/telemetry-synthetic-provider-check.mjs
```

These assertions cover foreign-config preservation, live render behavior, hook composition,
per-file install/removal and standalone discovery, and synthetic headless invocation. They do not
prove native credential denial, which remains unimplemented. The selected-plan reference/command
scan passed. The broader docs-reference check found a pre-existing stale link in
`docs/internal/backlog-review.md` to the package-state plan's old backlog location; that plan is now
active. This review does not change that unrelated document.
No full parity gate or historical native probes were rerun for this plan-only refinement.

## Open questions

No unresolved policy choice or implementation dependency blocker remains. Actual runtime/tool
coverage is implementation verification; unsupported surfaces must be explicit, and Part 3 cannot
use source staging until its native boundary is established. Historical runtime probes above were
not rerun during preparation.


## Execution evidence

October 26 implementation on `codex/credential-protection`, based on main `9bd17f36`.
Start transition `602a1bc4` was APPROVED without correction passes. The authoritative worktree is
Git administrative worktree `credential-protection`; this document contains no machine-local path.

- Discovery selected the same executable for CLI and desktop: Codex CLI `0.163.0-alpha.11.2`
  bundled with ChatGPT on macOS. This records executable identity, not desktop tool inheritance.
- The read-only native `config/read` query returned project, user and system layers, effective
  `on-request`, `managed-workspace`, `sandbox_mode: null`, network disabled and no filesystem
  entries. `configRequirements/read` returned `requirements: null`. The installed home was not
  changed. The query timed out inside the chat sandbox and succeeded after an authorized
  unrestricted launch without a model call.
- A standalone temporary-home native probe asserted that `~/.ssh/**` resolves against the runtime
  home. Thus neither build nor live rendering needs home expansion or a new target-home option.
- The deterministic projection test initially failed on the missing `~/.ssh/**` entry before the
  implementation. It now passes all 15 patterns across nine write/credential-intent combinations,
  escaping, roots, templates, idempotence, unknown anchors and explicit coverage metadata.
- Native enforcement ran the provider-rendered config in fresh synthetic homes with managed
  requirements included. Both `managed-workspace` and `managed-read-only` passed 31 file cases:
  all 15 independent patterns at shallow and ten-level paths, plus a symlink. Direct Node reads,
  `cat`, shell, `xargs` and descendant Node reads were denied, as were writes. Public and template
  reads passed; read-only public writes failed. Creating a directory and its new `.env` was also
  tested in writable mode: directory allowed, credential write denied. The unrestricted control
  passed, and removing denies made the same negative controls fail. No actual credentials were
  accessed. The nested chat sandbox returned unavailable (`sandbox_apply: Operation not permitted`);
  the explicitly authorized host launch of the same runner passed with native commands sandboxed.
- Coverage metadata is recorded in `scripts/test/fixtures/codex-credentials/coverage.json`.
  Desktop sessions, product structured-read tools, browser, MCP and escalated processes remain
  unverified; Linux and Windows remain unverified. These do not inherit certification from the
  native process checks. Part 3 must stage through a tested native command surface or separately
  establish its chosen surface's boundary.
- Foreign-line, home-path, Gemini, root-config-write, hook-composition and live-render checks passed.
  Packed install passed with portable home anchors, read-only denial and idempotent reapply into a
  different temporary home. Strict clean-machine permission checks also passed. Final gate results
  and the independently reproduced base failure are recorded under Review below.
- The started verification environment is the native synthetic sandbox runner, plus disposable
  packed-install/container fixtures. This configuration change has no persistent server or
  shareable URL; installed live settings were not rewritten.

## Coverage limitations accepted for this delivery

- Verify credential denial in a fresh desktop session and product structured-read tools after
      applying the new profile. No disposable desktop session was configured; native subprocess
      checks do not exercise desktop tool dispatch or inherited session policy.
- Verify native enforcement on Linux and Windows before claiming either platform. No native
      hosts for those platforms were used; the Linux container checks render/install behavior only.
- Establish credential boundaries independently for browser, MCP and separately escalated
      execution before using those surfaces for protected source staging. These tools were not
      certified by the native subprocess runner and have separate execution boundaries.


## Review

### Findings

- [x] Backlog audit linked this plan at its former active path after submission to review;
      corrected `docs/internal/backlog-review.md:86` in `62777699`. Main's corresponding link
      also named a missing ready path. The documentation reference check now passes.

- [x] Missing-denies native control omitted `--include-managed-config` while the main probe
      included it. Fixed: both runs now include managed policy; the same native matrix and
      missing-denies mutation passed again after correction (`808681c7`).

### Verification

- Pass 1 (fresh-context validator at `db965d67`): one fix finding above. Projection, foreign-line,
  live-render and whitespace checks independently passed. Documentation review found no violations
  under technical-writing core, shapes, section guidance, representation, anti-patterns, review loop,
  organization and supplied constraints. No renderer defect found; unverified surfaces were candid.
- Full parity reached 57/61 deterministic suites; four browser suites could not import the absent
  Playwright development dependency in the new worktree. Locked dependencies were installed from
  the local npm cache with `npm ci --offline --no-audit --no-fund`; the rerun passed 61/61. This was
  setup, not a base failure.
- October 27 final gate: `npm run check` ran doctor (107 passed) and the main suite (463 passed,
  1 failed). The failure at `scripts/test/cli-surface-integration-check.mjs:361` expected another
  cached ahead repository after a single-repo refresh; the screen remained at Press Enter. A
  separate validator executed the same check on main and reproduced the identical assertion,
  classifying it as a base failure. The focused feature-worktree rerun passed. No unrelated fix
  was made; the aggregate command is recorded as failed, not green.
- Every remaining available parity component was executed separately after that early exit:
  install collisions passed; deterministic CI suites passed 61/61; packed installation passed;
  strict clean-machine base, installation, permissions and onboarding suites passed; portal UI
  passed 141/141. Windows installer parity was unavailable because PowerShell was absent.
- Final current-state checks passed: doctor (107 checks), credential projection (15 patterns,
  nine combinations), `git diff --check`, and plan validation (zero blocking findings, three
  advisory Not tested entries).
- Pass 2 (fresh-context validator at `808681c7`): no fix or escalate findings. Reviewed the full
  main-to-feature diff, acceptance criteria, renderer, controls, coverage records, installation,
  docs of record and gate evidence; independently reran projection and whitespace checks. The
  base test failure above is recorded separately and does not block submission. Implementation
  is complete within the measured native macOS command surface; unverified surfaces remain
  explicit under Not tested. No policy decisions or implementation tasks remain blocked.

### Human-review verification — October 27

- Synchronized main `7d417ddf70b3d2aa6cd75d0d6b8576cd7b40745f` into the feature branch as
  `93d381987d9b01ddf999656e90ba3c125d27efd1`, with the user's explicit merge permission;
  no conflicts occurred. The primary checkout's unrelated pending edits were not included.
- Fresh-context Validator pass at `93d381987d9b01ddf999656e90ba3c125d27efd1`: clean,
  no fix or escalate findings. Independently inspected requirements, changed code, fixtures,
  installation, documentation, and coverage limitations; projection, foreign-line preservation,
  live-render characterization and `git diff --check` passed independently.
- Seven focused checks passed on the synchronized result: credential projection (all 15 patterns,
  nine intent/write combinations), live render, foreign lines, home paths, Gemini adapter,
  root-config write policy, and hook composition. `git diff --check` passed.
- `node scripts/test/codex-credential-enforcement-check.mjs` returned unavailable inside the chat
  sandbox (`sandbox_apply: Operation not permitted`). Its explicitly permitted host launch passed:
  both profiles, 31 synthetic file cases each, unrestricted controls, missing-denies mutation,
  public/template reads, write boundaries, links, deep paths and newly created credential paths.
- The three Not tested entries remain limitations on coverage claims, not required manual
  acceptance checks for the measured macOS native command surface. No protection claim is made
  for desktop/product tools, browser, MCP, unrestricted execution, Linux or Windows.
- First host `npm run check`: doctor passed 106 checks; main suite passed 464/464;
  installation collisions passed; CI suites passed 60/61. The only failure was the selected
  plan's stale lifecycle link, corrected in `62777699`; the failed documentation check then passed.
  The canonical aggregate exited nonzero and was not reported green.
- Components following that early exit were executed separately at `62777699` and passed:
  `npm run test:package-install`, strict `test:clean-machine`, `test:clean-machine-install-sandbox`,
  `test:clean-machine-permissions-sandbox`, `test:clean-machine-onboarding-sandbox`, and
  `npm run test:portal-ui` (141/141). PowerShell is absent, so Windows installer parity is unavailable.
- Main advanced to `977d29f04ab25f5191f21c832cb98709be99efae` during verification. Synchronized
  it without conflicts as `85786aa84afd8f942f32e2550a5b57ad6e1d88e6`. Credential implementation,
  native fixtures, coverage and generated configuration are byte-identical to the earlier result;
  the passing native macOS evidence above is reused for those unchanged files.
- Fresh-context Validator pass at `85786aa8` against `977d29f0`: clean. Independently passed
  projection, foreign lines, live rendering, plan suite, lifecycle manifest, lifecycle transitions,
  documentation references and whitespace checks. The link correction was also independently verified.
- Final `npm run check` at `85786aa8` failed at doctor: the base branch's plan-execute skill has
  a 503-line body, above its 500-line budget. `git diff main --` for that file is empty; main's
  committed file is identical, confirming a base failure. Doctor otherwise passed 106 checks.
  No unrelated skill edit was made. This is a base failure, not an implementation finding.
- Main's subsequent `a68a9cc3` changes only another plan under `docs/plans/`; it changes no
  implementation content relative to the synchronized base. Earlier component evidence is reused
  for unchanged code; affected lifecycle checks passed independently as listed above.
- `npm run test:portal-ui` against the newly synchronized base passed 146/146.
- Code review and available verification are complete with the base failure above explicitly
  retained. The approval check nevertheless reports review incomplete because all three unchecked
  Not tested entries count as required manual checks. The earlier classification of these entries
  as nonblocking limits was not accepted by that gate. No verification or human approval is inferred.
  Ask the human whether to retain them as documented unverified coverage limits for this delivery
  (with an explicit plan decision), or require their verification before approval. Do not check
  them off without actual evidence.
- Resumed after the user's explicit October 27 coverage decision recorded in the Decision Log.
  Preserved all three limitations as unverified prose rather than checking off unperformed work.
  Implementation and base content are unchanged from the verified result; earlier checks are
  reused. No unresolved findings or required manual acceptance checks remain. Implementation
  approval is requested separately for the exact reviewed commit below.

### Result
- Status: pending
- Reviewed implementation commit: f90412a258c6a1177ea33a6531581d53020f21db
- Base commit: ac7c6bb207f3431b0e4c3a308c973adc9717424f

#### Re-review — October 30, 2026

- Resume path: changes since review, after landing. The prior complete review covered
  `81ae9e362000c1a48574b1aeceda4c2302b19570` against base
  `977d29f04ab25f5191f21c832cb98709be99efae`; its explicit approval below remains historical.
  This pending result does not renew that approval.
- The 28 changed paths since approval cover plan priority/lifecycle rules, dependency actions,
  shared copy controls, tests, the plan-execute report reference, and the control-panel guidance
  for absent Codex configuration. Credential rendering, generated Codex configuration, and native
  enforcement fixtures are unchanged. The feature implementation is byte-identical outside
  `docs/plans/` to squash `28932c1c85535759e8cf565ccdd096d6735e8946`.
- The canonical `node scripts/cli/main.mjs plans landed 4zyo2woj --json` retry passed, revalidating
  that squash as the absorbing commit at the exact feature/base tips above. Base synchronization
  was not run on the already-landed branch. Its worktree and branch were not changed.
- Fresh-context Validator: no actionable fix or escalate findings in the changed and directly
  affected code. Checked acceptance criteria, observable tests, documentation of record, coverage
  limits, flow/cohesion, data/state, and comments/abstractions. No review fix commits were needed.
- Passed: `node scripts/test/codex-credential-projection-check.mjs` (15 patterns, nine combinations),
  `node scripts/test/codex-permissions-foreign-lines-check.mjs`,
  `node scripts/test/permission-rule-home-path-check.mjs`,
  `node scripts/test/plans-portal-state-check.mjs`,
  `node scripts/test/plan-lifecycle-manifest-check.mjs`, and
  `node scripts/test/plan-suite-skills-check.mjs`. The Validator independently passed projection,
  foreign lines, portal state, lifecycle manifest, skill checks, and documentation references.
  Whitespace validation excluding the two inaccessible TLS fixtures passed; plan validation
  reported zero findings.
- `npm run check` did not pass: doctor passed 106 checks, then the CLI suite reported three
  package add-skill assertion failures and failed temporary-fixture cleanup with `EPERM`.
  These failures are not classified as base failures; their cause was not established. Later
  aggregate components were not reached. No aggregate pass or waiver is inferred.
- `node scripts/test/permissions-render-live-characterization-check.mjs`,
  `node scripts/test/gemini-adapter-characterization-check.mjs`,
  `node scripts/test/root-config-write-policy-check.mjs`,
  `node scripts/test/hook-composition-check.mjs`, and
  `node scripts/test/plan-lifecycle-transitions-check.mjs` exited nonzero while removing their
  temporary fixtures (`EPERM`). Available isolated retries retained that failure; printed
  assertion-success messages are not counted as passing commands. Test-created untracked
  hook-composition files were removed without changing tracked implementation.
- `npm run test:portal-ui` could not bind `127.0.0.1` (`listen EPERM`) and also failed temporary
  cleanup. Its separately permitted retry failed with the same two errors; no browser assertions
  ran in either attempt.
- The canonical approval reader still reports stale approval (28 implementation paths since
  the old approved commit). It also lists the inaccessible
  `scripts/test/fixtures/runtime-tls/localhost-cert.pem` and
  `scripts/test/fixtures/runtime-tls/localhost-key.pem` as pending implementation changes.
  Git status reports denied access to those paths, so their working contents were not compared
  or treated as verified clean. They were not read or changed. Status excluding those paths was
  clean after test-file cleanup; the primary checkout retains unrelated pre-existing edits.
- Correction after the user's October 30 follow-up: main already includes
  `fb3a32b568b8fecaf7203e3adb23c6a8ea403093`, which removes both tracked PEM fixtures and
  generates disposable TLS credentials in memory through `scripts/test/lib/local-test-tls.mjs`.
  The assigned historical feature tip does not include that commit and still reads the old
  fixtures. The PEM-specific obstacle above concerns that older worktree, not current main.
  The same main commit also makes inaccessible-file checks report unavailable rather than
  treating unreadable files as verified edits. Neither correction was incorporated into the
  older worktree used for this review; its cleanup and localhost errors remain separate observed
  failures. Current main's disposable TLS implementation has not been rerun in this review.
- Native enforcement was not rerun: its unrestricted positive controls read synthetic paths
  denied by this session's policy. Previously recorded macOS native-command evidence remains
  historical evidence for unchanged files, not a fresh runtime certification. The three human-
  accepted coverage limitations remain unchanged; no new manual acceptance task is inferred.
- Approval is not requested while required verification and trustworthy freshness checking remain
  unavailable. Resume with a passing `npm run check` and canonical approval-reader output from
  an environment permitted to inspect the repository's synthetic test fixtures and clean up its
  temporary directories. This record changes only the primary plan's Result; it does not alter
  the landed worktree, recover approval, close the plan, or authorize cleanup.

### Approval
- Decision: approved
- Reviewed implementation commit: 81ae9e362000c1a48574b1aeceda4c2302b19570
- Confirmed by: human
- Evidence: October 27, 2026, the user selected "Approve this implementation" in response to
  the exact-commit approval question for this plan, including the accepted coverage limits and
  recorded base-branch skill-size failure. Review freshness was rechecked before recording.

## Verification

### Closure attempt — October 27, 2026

- Result: blocked; remains in review. No completion commit, server shutdown, or worktree cleanup.
- Primary checkout: main at `6eba62ad78ad37d0e3a62230869281378919cc04`. The assigned worktree's
  review document matched the primary document byte for byte before this attempt's evidence edits.
- Plan validation: zero findings, zero blocking findings. No unchecked Not tested entries;
  the previously accepted coverage limitations remain unverified and unchanged.
- Seven focused checks passed: credential projection (15 patterns, nine intent/write combinations),
  live rendering, foreign-line preservation, home paths, Gemini adapter, root-config write policy,
  and hook composition. Whitespace validation passed.
- Canonical `npm run check`: the sandboxed run failed with localhost `listen EPERM` restrictions.
  The permitted host rerun passed doctor (106 checks), the main suite (464/464), installation
  collisions, deterministic CI suites (61/61), packed installation, and all four strict
  clean-machine suites. Windows installer parity was skipped because PowerShell is unavailable.
  The aggregate exited 1 at portal UI startup: `error: timed out waiting for ready file`.
  The runner waits 15 seconds for server readiness; the timeout's cause is unverified. No waiver
  or aggregate pass is inferred from earlier successful components.
- Focused `npm run test:portal-ui` host retry: passed 151/151. No code changes were needed.
  This resolves verification of the UI assertions but does not change the aggregate exit status;
  obtain a passing aggregate on the next review/close run or an explicit waiver of its failed
  startup check. No unrelated startup behavior was changed during this credential-plan closure.
- Native enforcement: the nested sandbox returned unavailable (`sandbox_apply: Operation not
  permitted`). The permitted host launch passed with Codex `0.163.0-alpha.11.2` on macOS, fresh
  synthetic configuration, and native sandbox commands/descendants: both profiles, 31 file cases
  each, unrestricted controls, missing-denies mutation, public/template reads, write boundaries,
  links, deep paths and newly created credential paths. No broader tool/platform claim is made.
- Documentation impact: inspected all five named docs of record against credential projection,
  profile rendering and coverage metadata; no unresolved required drift found. The control-panel
  reference additionally documents that a missing Codex configuration skips profile rendering.
- Approval: stale. Approved implementation `81ae9e362000c1a48574b1aeceda4c2302b19570` differs
  from feature tip `f90412a258c6a1177ea33a6531581d53020f21db`. The canonical approval check
  reports 28 changed paths outside plan documents. `/plan-review` must review the current result
  and obtain renewed human approval; this attempt preserves the existing approval as historical evidence.
- Landing: newly scanned by the canonical content-level check; the feature branch carried its own
  work and is absorbed by the squash merge below. The first sandboxed scan was unavailable;
  the permitted retry succeeded. Landing does not make the stale approval fresh.
- Absorbing commit: 28932c1c85535759e8cf565ccdd096d6735e8946

Changed paths reported by the approval check:

```text
docs/user/guides/plan/lifecycle/plan-suite.md
docs/user/reference/config-control-panel.md
docs/user/reference/plans-portal.md
globals/packages/plan-suite/skills/plan-execute/SKILL.md
globals/packages/plan-suite/skills/plan-execute/references/final-report.md
manifests/platform/plan-lifecycle.json
modules/plan-suite/transition-rules.mjs
portal/plans/app.js
portal/plans/elements/plan-card.js
portal/plans/elements/plan-status.js
portal/plans/lifecycle.js
portal/plans/plan-actions.js
portal/plans/plan-drawer-partial.html
portal/plans/plan-drawer.css
portal/plans/plan-drawer.js
portal/plans/state.js
portal/plans/templates.js
portal/shared/base.css
portal/shared/copy-button.js
portal/shared/copy-menu.js
portal/shared/widget-templates-partial.html
scripts/test/plan-lifecycle-manifest-check.mjs
scripts/test/plan-lifecycle-transitions-check.mjs
scripts/test/plan-suite-skills-check.mjs
scripts/test/plans-portal-state-check.mjs
scripts/test/portal-ui/plans-status.spec.mjs
scripts/test/portal-ui/portal-ui.spec.mjs
scripts/test/portal-ui/repository-scope.spec.mjs
```
