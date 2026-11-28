#!/usr/bin/env node
// What must stay equal to each forge provider's manifest, because it is spelled out again where the
// registry cannot be loaded or read: the protected-branch-push hooks' HOST_CLIS table (hooks import
// only Node built-ins), the Codex permission hook's package table, each provider's command
// definitions under the shared `git` namespace, and the permission inventory's `host` tags. Then the
// hook itself, run with a second, fake table entry, shows that the identity checks read each entry
// rather than GitHub's variables.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listForgeProviders, providersWithCapability } from "../../modules/forge/registry.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8");
const CLAUDE_HOOK = "globals/system/hooks/claude/protected-branch-push.mjs";
const CODEX_HOOK = "globals/harnesses/codex/hooks/protected-branch-push.mjs";
const identityProviders = providersWithCapability("agent-identity");

// A `const NAME = { ... }` object literal out of a hook's source, evaluated. The hooks run on load,
// so they cannot be imported; the table holds only data and functions that are never called here.
// The literal is found by matching braces; none of the tables' strings hold one.
function hookTable(source, name) {
  const start = source.indexOf(`const ${name} = {`);
  assert.ok(start >= 0, `${name} is defined`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}" && --depth === 0) return new Function(`return ${source.slice(open, i + 1)}`)();
  }
  throw new Error(`${name} is not closed`);
}

// The two push hook copies are one file.
const hookSource = read(CLAUDE_HOOK);
assert.equal(read(CODEX_HOOK), hookSource, "the Claude and Codex protected-branch-push hooks are byte-identical");

// HOST_CLIS mirrors every provider with an agent account.
const hostClis = hookTable(hookSource, "HOST_CLIS");
assert.deepEqual(Object.keys(hostClis).sort(), identityProviders.map((provider) => provider.id).sort(), "one HOST_CLIS entry per provider with an agent account");
for (const provider of identityProviders) {
  const entry = hostClis[provider.id];
  const { cli, agent, displayName } = provider.manifest;
  assert.deepEqual(
    { cli: entry.cli, identityVariables: entry.identityVariables, configDirVariable: entry.configDirVariable, tokenVariables: entry.tokenVariables, configSubfolder: entry.configSubfolder },
    { cli: cli.name, identityVariables: cli.identityVariables, configDirVariable: cli.configDirVariable, tokenVariables: cli.tokenVariables, configSubfolder: cli.configSubfolder },
    `${provider.id}: the hook entry's CLI fields equal the manifest's cli.*`,
  );
  assert.deepEqual({ packageId: entry.packageId, stateFolder: entry.stateFolder, displayName: entry.displayName }, { packageId: agent.packageId, stateFolder: agent.stateFolder, displayName }, `${provider.id}: the hook entry's agent fields equal the manifest's`);
  assert.equal(typeof entry.liftRefusal, "function", `${provider.id}: the hook entry says what still refuses a lifted command`);
}
console.log("✓ The push hooks' HOST_CLIS table equals each provider's manifest, and both copies are identical.");

// The Codex permission hook's package table.
assert.deepEqual(
  hookTable(read("globals/harnesses/codex/hooks/permission-check.mjs"), "AGENT_IDENTITY_PACKAGES"),
  Object.fromEntries(identityProviders.map((provider) => [provider.id, provider.manifest.agent.packageId])),
  "the Codex permission hook names each provider's package",
);
console.log("✓ The Codex permission hook's package table equals the manifests.");

// Each provider's commands under the shared `git` namespace, named by agent.commandNamespace.
const definitions = path.join(repoRoot, "manifests", "platform", "cli", "command-definitions", "git");
for (const provider of identityProviders) {
  const namespace = provider.manifest.agent.commandNamespace;
  const definition = (file) => JSON.parse(fs.readFileSync(path.join(definitions, file), "utf8"));
  assert.deepEqual(definition(`${namespace}.namespace.json`).path, ["git", namespace], `${provider.id}: its namespace is git ${namespace}`);
  for (const [command, exported, module] of [["setup", "forgeSetupCommand", "scripts/cli/forge-setup.mjs"], ["status", "forgeStatusCommand", "scripts/cli/forge-identity.mjs"]]) {
    const entry = definition(`${namespace}-${command}.command.json`);
    assert.deepEqual(entry.path, ["git", namespace, command], `${provider.id}: git ${namespace} ${command}`);
    assert.deepEqual(entry.execution, { adapter: "module", module, export: exported, prependArgs: [provider.id] }, `${provider.id}: ${command} calls the shared ${exported} with its id`);
  }
}
console.log("✓ Every provider's setup and status definitions sit under git and call the shared exports.");

// Every permission behavior's host tag names a registered provider.
const ids = new Set(listForgeProviders().map((provider) => provider.id));
const inventory = JSON.parse(read("manifests/inventory/agent-permissions.json"));
for (const behavior of inventory.behaviors) {
  if (behavior.host !== undefined) assert.ok(ids.has(behavior.host), `${behavior.id}: host ${JSON.stringify(behavior.host)} is a forge provider id`);
}
console.log("✓ Every permission host tag names a registered forge provider.");

// The hook with a second, fake entry: its variables change the identity too, in a command and in
// Codex's config.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-forge-parity-"));
try {
  const FAKE_ENTRY = `  fake: {
    cli: 'fakecli',
    displayName: 'Fake Forge',
    identityVariables: ['FAKE_FORGE_CONFIG_DIR', 'FAKE_FORGE_TOKEN'],
    configDirVariable: 'FAKE_FORGE_CONFIG_DIR',
    tokenVariables: ['FAKE_FORGE_TOKEN'],
    packageId: 'fake-forge-agent-identity',
    stateFolder: 'fake-forge-agent',
    configSubfolder: 'cli',
    valueOptions: [],
    denied: [['api']],
    allowedAsAgent: [['api']],
    liftRefusal: () => null,
  },
`;
  const marker = "const HOST_CLIS = {\n";
  const withFake = hookSource.replace(marker, `${marker}${FAKE_ENTRY}`);
  assert.notEqual(withFake, hookSource);
  const codexHome = path.join(tmp, ".codex");
  const hooks = { claude: path.join(tmp, "claude", "hooks", "protected-branch-push.mjs"), codex: path.join(codexHome, "hooks", "protected-branch-push.mjs") };
  for (const file of Object.values(hooks)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, withFake);
  }
  const stateRoot = path.join(tmp, "state");
  for (const packageId of ["github-agent-identity", "fake-forge-agent-identity"]) {
    const file = path.join(stateRoot, "package-runtime", packageId, "gitconfig");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");
  }
  const ghDir = path.join(stateRoot, "github-agent", "gh");
  const fakeDir = path.join(stateRoot, "fake-forge-agent", "cli");
  const codexConfig = (fakeToken) => fs.writeFileSync(path.join(codexHome, "config.toml"),
    `[shell_environment_policy.set]\nGH_CONFIG_DIR = "${ghDir}"\nGH_TOKEN = ""\nGITHUB_TOKEN = ""\nFAKE_FORGE_CONFIG_DIR = "${fakeDir}"\nFAKE_FORGE_TOKEN = "${fakeToken}"\n`);
  const baseEnv = { ...process.env, ROBOREPO_STATE_ROOT: stateRoot, CODEX_HOME: codexHome };
  for (const name of ["GH_CONFIG_DIR", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST", "FAKE_FORGE_CONFIG_DIR", "FAKE_FORGE_TOKEN"]) delete baseEnv[name];
  const decide = (command, { hook = "claude", env = {} } = {}) => {
    const codex = hook === "codex";
    const result = spawnSync(process.execPath, [hooks[hook]], {
      input: JSON.stringify({ cwd: tmp, hook_event_name: "PreToolUse", tool_name: codex ? "exec_command" : "Bash", tool_input: { [codex ? "cmd" : "command"]: command } }),
      encoding: "utf8",
      env: { ...baseEnv, ...env },
    });
    assert.equal(result.status, 0, `hook exited ${result.status}: ${result.stderr}`);
    return result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput.permissionDecision : "defer";
  };
  const asBots = { GH_CONFIG_DIR: ghDir, FAKE_FORGE_CONFIG_DIR: fakeDir };

  // Claude: each entry's bot lifts its own CLI's denial, and naming any entry's variable in the
  // command drops every lift.
  assert.equal(decide("fakecli api projects", { env: asBots }), "defer", "the fake bot lifts fakecli api");
  assert.equal(decide("gh api repos/o/r", { env: asBots }), "defer", "the GitHub bot still lifts gh api");
  assert.equal(decide("fakecli api projects", { env: { GH_CONFIG_DIR: ghDir } }), "deny", "fakecli api is denied while the fake's config dir is not the bot's");
  assert.equal(decide("FAKE_FORGE_TOKEN=x fakecli api projects", { env: asBots }), "deny", "a fake variable in the command drops the fake's lift");
  assert.equal(decide("FAKE_FORGE_TOKEN=x gh api repos/o/r", { env: asBots }), "deny", "a fake variable in the command drops GitHub's lift too");
  assert.equal(decide("env fakecli api projects", { env: asBots }), "deny", "the fake's CLI run through env drops the lift");
  assert.equal(decide("fakecli api projects", { env: { ...asBots, FAKE_FORGE_TOKEN: "inherited" } }), "deny", "an inherited fake token means the fake CLI is not the bot");
  console.log("✓ The hook's command checks read a second entry's variables and CLI.");

  // Codex: its config must give the shells each entry's bot.
  codexConfig("");
  assert.equal(decide("fakecli api projects", { hook: "codex" }), "defer", "Codex shells get the fake bot");
  codexConfig("abc");
  assert.equal(decide("fakecli api projects", { hook: "codex" }), "deny", "a fake token in Codex's config means its shells are not the fake bot");
  assert.equal(decide("gh api repos/o/r", { hook: "codex" }), "defer", "the fake's token does not touch GitHub's lift");
  console.log("✓ The hook's Codex config check reads a second entry's variables.");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
