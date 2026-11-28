# Forge Providers

A forge provider is RoboRepo's adapter for one Git host with an API (GitHub today; GitLab,
Bitbucket, or Gitea later). It is unrelated to harness providers under `scripts/harnesses/`.
The layer is described in `docs/internal/cli-internals.md` (`## Git host calls`).

## Rules that hold for every provider

- Code outside `modules/forge/providers/<id>/` never names a host or a provider id. It asks
  `modules/forge/registry.mjs` for the repo's provider and checks the capability it needs; a missing
  capability reports `{ supported: false }` the way an unknown host does.
- A provider's agent account acts only on its own `hosts`: every `credential`, `url.*.insteadOf`,
  `http.<url>`, and `includeIf` section in its package gitconfig and in the files its setup writes
  names only those hosts; a plain `include` points only into its own state folder; the bot is the
  author only through `includeIf "hasconfig:remote.*.url:..."` on its hosts; every CLI call pins the
  host; its config patches set and clear only its `cli.identityVariables` and
  `agent.networkDomains`; its tokens live only under `~/.roborepo/<agent.stateFolder>/`.
  `scripts/test/forge-host-scoping-check.mjs` enforces this.
- The hooks cannot import the registry, so each provider has a `HOST_CLIS` entry in both
  `protected-branch-push.mjs` copies. `scripts/test/forge-provider-parity-check.mjs` keeps it equal
  to the manifest and the two copies identical.

## Adding a second provider

Use the GitHub provider (`modules/forge/providers/github/`) as the model and the fake provider
(`scripts/test/fixtures/forge-fake-provider/`) as the minimum shape. Write the plan first; a second
provider is its own plan.

1. **Manifest.** `modules/forge/providers/<id>/provider.json`: `id`, `displayName`, `hosts`, `cli`
   (`name`, `configSubfolder`, `configDirVariable`, `tokenVariables`, `identityVariables`), `agent`
   (`packageId`, `stateFolder`, `commandNamespace`, `networkDomains`), and `capabilities`.
   `modules/forge/contract.mjs` validates it at load.
2. **Adapters.** An `index.mjs` exporting the provider with one method group per declared
   capability, each with the methods `FORGE_CAPABILITY_REQUIRED_METHODS` lists. Register it in
   `SHIPPED` in `modules/forge/registry.mjs`.
3. **Package.** `globals/packages/<id>-agent-identity/`: its gitconfig (credential helper, URL
   rewrite, author `includeIf`, all keyed on its hosts), `rules.md` naming
   `roborepo git <commandNamespace> setup`, and config patches for its identity variables and
   network domains. The Git include slot: GitHub owns `GIT_CONFIG_KEY_1`/`VALUE_1`, and two packages
   cannot both own it. Move every identity package to one shared include file that lists each
   enabled provider's gitconfig before shipping the second package.
4. **Commands.** In `manifests/platform/cli/command-definitions/git/`:
   `<commandNamespace>.namespace.json`, `<commandNamespace>-setup.command.json`, and
   `<commandNamespace>-status.command.json`, calling the shared exports in
   `scripts/cli/forge-setup.mjs` and `scripts/cli/forge-identity.mjs` with the provider id.
5. **Permissions.** Behaviors in `manifests/inventory/agent-permissions.json` tagged
   `"host": "<id>"`, with `agentIdentityBucket` where the bot may do more than the user's default;
   deny `roborepo git <commandNamespace> setup` and allow its status. Untagged identity buckets
   (`push-code`) lift only when every provider with an agent account is on; revisit that rule when
   the second provider lands.
6. **Hooks.** A `HOST_CLIS.<id>` entry in both `protected-branch-push.mjs` copies with its CLI,
   identity variables, config folder, package id, state folder, and its own denied and
   allowed-as-agent lists, and an `AGENT_IDENTITY_PACKAGES` entry (`<id>: '<packageId>'`) in the
   Codex `globals/harnesses/codex/hooks/permission-check.mjs`. The parity check fails until both
   match the manifest.
7. **Claude sandbox.** Exclude the provider's CLI and `git <commandNamespace> status` in
   `scripts/harnesses/claude/sandbox-settings.mjs`.
8. **Portal and doctor.** Home keeps one account read, for the first listed provider: its offer,
   account card, and setup note (`portal/home/agent-identity.js`). Key them by provider so a repo
   on the new host shows its own account and setup command. Doctor's crash line in
   `scripts/doctor.sh` names GitHub; make it name the provider or none.
9. **Browser links.** `KNOWN_PROVIDER_HOSTS` in `modules/repositories/config.mjs` is a separate list
   of hosts the portal builds web links for (it already names `gitlab.com`, `bitbucket.org`, and
   `codeberg.org`). Add the new host there if it is missing, or derive the list from the registry.
10. **Checks.** The contract, parity, and host-scoping checks pick up the new provider from the
   registry, as do RoboRepo's own Git calls (`agentGitConfigPaths` in
   `modules/repositories/git-exec.mjs`) and the Agents page's list of packages Settings controls;
   add tests for its adapter methods beside the GitHub ones, and portal UI cases only if the
   provider changes what the cards show.
