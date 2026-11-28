#!/usr/bin/env node
// The forge provider contract and registry, end to end with a fake provider for forge.example.test:
// the shipped GitHub provider and the fake both load, a provider missing a capability's method is
// refused at load naming the method, and the shared code (protect's read, the status command, doctor,
// the portal, and the permission render) reads the provider it is given. The fake never ships: it
// reaches the registry only through each lookup's `providers` option.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isolateGitConfig } from "./lib/git-config.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-forge-contract-"));
isolateGitConfig(root);
// The status and portal reads resolve the state root when they load, so it is set first.
process.env.ROBOREPO_STATE_ROOT = path.join(root, "state");
process.env.HOME = path.join(root, "home");
fs.mkdirSync(process.env.HOME, { recursive: true });

const { defineForgeProvider, validateForgeManifest } = await import("../../modules/forge/contract.mjs");
const { listForgeProviders, providerForRemoteUrl, providerForRepositoryId } = await import("../../modules/forge/registry.mjs");
const { githubProvider } = await import("../../modules/forge/providers/github/index.mjs");
const { fakeAgentIdentity, fakeManifest, fakeProvider, makeFakeProvider } = await import("./fixtures/forge-fake-provider/index.mjs");
const { readProtection } = await import("../../modules/forge/protection.mjs");
const { doctorLines, explainBotRepoAccess, formatReport, readCurrentAgentIdentity } = await import("../cli/forge-identity.mjs");
const { listPortalForgeProviders, loadAgentIdentityAccount } = await import("../cli/repository-agent-identity.mjs");
const { claudePermissions, renderCodexRules, resolveBehaviors } = await import("../harnesses/permissions-render.mjs");

const providers = [githubProvider, fakeProvider];
const FAKE_REPO = "git:forge.example.test/example/project";

try {
  // Loading and validation.
  assert.deepEqual(listForgeProviders().map((provider) => provider.id), ["github"], "only GitHub ships");
  assert.equal(fakeProvider.id, "fake-forge");
  const { invite: _invite, ...withoutInvite } = fakeAgentIdentity;
  assert.throws(() => makeFakeProvider({ adapters: { agentIdentity: withoutInvite } }), /capability "agent-identity" requires adapters\.agentIdentity\.invite to be a function/);
  assert.throws(() => makeFakeProvider({ manifest: { ...fakeManifest, capabilities: [...fakeManifest.capabilities, "branch-protection"] } }), /requires adapters\.branchProtection to be an object/);
  assert.match(validateForgeManifest({ ...fakeManifest, cli: undefined }).join("\n"), /cli must be an object/);
  assert.match(validateForgeManifest({ ...fakeManifest, capabilities: ["teleport"] }).join("\n"), /unknown capability: teleport/);
  assert.throws(() => defineForgeProvider({ manifest: { ...fakeManifest, hosts: [] }, adapters: {} }), /hosts must be a non-empty array/);
  console.log("✓ GitHub and the fake load; a missing method or a bad manifest is refused at load, named.");

  // The registry finds a repo's provider by host, and a remote by the provider that parses it.
  assert.equal(providerForRepositoryId(FAKE_REPO, { providers }).provider, fakeProvider);
  assert.equal(providerForRepositoryId("git:github.com/example/project", { providers }).provider, githubProvider);
  assert.equal(providerForRepositoryId(FAKE_REPO).provider, null, "without the fake, its host has no provider");
  assert.equal(providerForRepositoryId("local:abc"), null);
  assert.equal(providerForRemoteUrl("https://forge.example.test/example/project.git", { providers })?.provider, fakeProvider);
  assert.deepEqual(providerForRemoteUrl("git@github.com:Example/Project.git"), { provider: githubProvider, host: "github.com", repo: "example/project" });
  console.log("✓ The registry resolves repos and remotes to their provider, and a host it lacks to none.");

  // protect's read: the fake has no branch protection, so the repo reads as unsupported, with the
  // manual steps of the providers that do.
  const protection = await readProtection({ repositoryId: FAKE_REPO, cwd: root }, { providers });
  assert.equal(protection.state, "unsupported");
  assert.equal(protection.reason, "forge.example.test is not GitHub");
  assert.equal(protection.repository, "example/project");
  assert.deepEqual(protection.manualSteps, githubProvider.adapters.branchProtection.manualSteps);
  console.log("✓ roborepo protect's read reports the missing capability for a repo on the fake's host.");

  // The status command's read and text, under the fake's name.
  const status = await readCurrentAgentIdentity({ provider: fakeProvider, repositoryId: FAKE_REPO, cwd: root });
  assert.equal(status.state, "not-set-up");
  assert.equal(status.repository, "example/project");
  assert.equal(formatReport(status, fakeProvider), "Fake Forge agent identity is not set up (optional). Run roborepo git fake-forge setup in your own terminal to let agents act on Fake Forge as a bot account.");
  console.log("✓ The shared status reports \"not set up\" under the fake provider's name.");

  // Doctor's line in a checkout on the fake's host, and none for GitHub there.
  const checkout = path.join(root, "checkout");
  for (const args of [["init", "-q", "-b", "main", checkout], ["-C", checkout, "remote", "add", "origin", "https://forge.example.test/example/project.git"]]) {
    const result = spawnSync("git", args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const lines = await doctorLines({ cwd: checkout, providers });
  assert.deepEqual(lines, [{ level: "ok", text: "Fake Forge agent identity not set up (optional) — run roborepo git fake-forge setup in your own terminal" }]);
  assert.deepEqual(await doctorLines({ cwd: checkout }), [], "the shipped providers add no line on another host");
  assert.equal(await explainBotRepoAccess({ cwd: checkout, env: {}, providers }), null, "a shell not routed through the fake's bot is not its problem");
  console.log("✓ Doctor checks the provider that serves the repo, and only that one.");

  // The portal lists the fake and names it in the account it reads.
  assert.deepEqual(listPortalForgeProviders({ providers }).map(({ id, displayName, hosts }) => ({ id, displayName, hosts })), [
    { id: "github", displayName: "GitHub", hosts: ["github.com"] },
    { id: "fake-forge", displayName: "Fake Forge", hosts: ["forge.example.test"] },
  ]);
  const account = await loadAgentIdentityAccount({ providerId: "fake-forge", providers, stateRoot: path.join(root, "state"), fresh: true });
  assert.deepEqual(account.provider, { id: "fake-forge", displayName: "Fake Forge" });
  assert.equal(account.state, "not-set-up");
  assert.equal(account.guide.command, "roborepo git fake-forge setup");
  await assert.rejects(loadAgentIdentityAccount({ providerId: "nope", providers }), (error) => error.code === "BAD_REQUEST");
  console.log("✓ The portal lists the fake provider and names it in the account response.");

  // Per-provider buckets: with only the fake's identity on, GitHub's behaviors keep their defaults.
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "manifests", "inventory", "agent-permissions.json"), "utf8"));
  const tagged = manifest.behaviors.filter((behavior) => behavior.host === "github" && behavior.agentIdentityBucket);
  assert.ok(tagged.length > 0, "the inventory has GitHub behaviors with an identity bucket");
  const bucketsUnder = (ids) => new Map(resolveBehaviors(manifest, {}, { agentIdentityProviders: ids }).map((behavior) => [behavior.id, behavior.bucket]));
  const off = bucketsUnder([]);
  const fakeOnly = bucketsUnder(["fake-forge"]);
  const githubOn = bucketsUnder(["github"]);
  for (const behavior of tagged) {
    assert.equal(fakeOnly.get(behavior.id), behavior.bucket, `${behavior.id}: the fake's identity leaves GitHub's default`);
    assert.equal(githubOn.get(behavior.id), behavior.agentIdentityBucket, `${behavior.id}: GitHub's identity lifts it`);
  }
  assert.deepEqual(fakeOnly, off, "the fake's identity changes no shipped behavior");
  assert.deepEqual(claudePermissions(manifest, {}, { agentIdentityProviders: ["fake-forge"] }), claudePermissions(manifest, {}, { agentIdentityProviders: [] }));
  assert.equal(renderCodexRules(manifest, {}, { agentIdentityProviders: ["fake-forge"] }), renderCodexRules(manifest, {}, { agentIdentityProviders: [] }));
  console.log("✓ A host-tagged identity bucket follows only its own provider in the Claude and Codex renders.");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
