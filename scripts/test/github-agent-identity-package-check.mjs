#!/usr/bin/env node
// Enabling github-agent-identity points agent shells at the bot's gh config directory under the
// state root, installs the git config include, opens the matching permissions, and disabling
// removes all of it. Runs the real CLI against a throwaway home.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = path.join(repoRoot, "scripts", "cli", "main.mjs");
const ID = "github-agent-identity";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-gh-identity-"));
// Not the default `~/.roborepo` of this HOME, so a path that ignores the state root shows up.
const stateRoot = path.join(home, "state");
// The modules read the state root once, when they load, so it is set before they are imported.
process.env.ROBOREPO_STATE_ROOT = stateRoot;
const { expandPackageRuntimeRefs } = await import("../cli/package-runtime-assets.mjs");
const { renderCodexConfig, resolveArbitraryCommands, resolveBehaviors } = await import("../harnesses/permissions-render.mjs");
const { mergeCodexConfig } = await import("../cli/root-config-merge.mjs");
const { AGENT_GITCONFIG_INCLUDE, agentGitRoutingGaps } = await import("../cli/agent-identity-package.mjs");
const { rootConfigBaseline } = await import("../cli/paths.mjs");
const { listHarnessProviders } = await import("../harnesses/registry.mjs");
const { resolveHarnessPath } = await import("../harnesses/paths.mjs");
fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
// The baseline's own Git pair (the hooks path) is already there, as after any install.
const baselineGitEnv = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "~/.claude/git-hooks" };
fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ env: baselineGitEnv }));
// A domains table the user already has: the package adds the GitHub hosts beside it and removes only those.
fs.writeFileSync(
  path.join(home, ".codex", "config.toml"),
  `${fs.readFileSync(path.join(repoRoot, "generated", "codex", "config.toml"), "utf8")}\n[permissions.managed-workspace.network.domains]\n"example.com" = "allow"\n`,
);
// The install step's identity-off baseline for Codex's prefix rules.
const baselineRules = fs.readFileSync(path.join(repoRoot, "generated", "codex", "rules", "roborepo.rules"), "utf8");
fs.mkdirSync(path.join(home, ".codex", "rules"), { recursive: true });
fs.writeFileSync(path.join(home, ".codex", "rules", "roborepo.rules"), baselineRules);
const env = { ...process.env, HOME: home, ROBOREPO_STATE_ROOT: stateRoot, SKIP_MCP: "1" };
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8", cwd: repoRoot });
const claudeSettings = () => JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
const codexConfig = () => fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
const codexRules = () => fs.readFileSync(path.join(home, ".codex", "rules", "roborepo.rules"), "utf8");
const domain = (text, host) => new RegExp(`^"?${host.replace(/\./g, "\\.")}"? = "allow"$`, "m").test(text);
const gitconfig = path.join(stateRoot, "package-runtime", ID, "gitconfig");
const ghDir = path.join(stateRoot, "github-agent", "gh");
const agentShellProviders = listHarnessProviders().filter((provider) => provider.adapters.agentShell);
// Each agent-shell harness's live config in this throwaway home, read through its own path.
const liveConfigs = () => {
  const realHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return Object.fromEntries(agentShellProviders.map((provider) => [provider.id, fs.readFileSync(resolveHarnessPath(provider.manifest, "rootConfig"), "utf8")]));
  } finally {
    process.env.HOME = realHome;
  }
};
const readFrom = (texts) => (provider) => {
  if (!(provider.id in texts)) throw new Error("missing");
  return texts[provider.id];
};
let configsOn = null;

try {
  // The placeholder expands to an absolute path under the state root and refuses to climb out.
  const pkg = { id: ID, resources: [] };
  assert.equal(expandPackageRuntimeRefs("${roborepo-state:github-agent/gh}", pkg).endsWith(path.join("github-agent", "gh")), true);
  assert.ok(path.isAbsolute(expandPackageRuntimeRefs("${roborepo-state:a/b}", pkg)));
  assert.throws(() => expandPackageRuntimeRefs("${roborepo-state:../escape}", pkg), /\.\./);
  assert.throws(() => expandPackageRuntimeRefs("${roborepo-state:a/../../escape}", pkg), /\.\./);

  const enabled = run("package", "enable", ID);
  assert.equal(enabled.status, 0, `enable failed\n${enabled.stdout}\n${enabled.stderr}`);

  assert.equal(claudeSettings().env.GH_CONFIG_DIR, ghDir, "Claude env points at the bot's gh directory");
  assert.ok(path.isAbsolute(claudeSettings().env.GH_CONFIG_DIR));
  // gh uses an exported GH_TOKEN or GITHUB_TOKEN ahead of the stored login and treats an empty one
  // as unset, so blanking them keeps a token from your shell from replacing the bot.
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN"]) assert.equal(claudeSettings().env[name], "", `Claude env blanks ${name}`);
  assert.ok(fs.existsSync(gitconfig), "the gitconfig asset is installed");
  assert.equal(fs.readFileSync(gitconfig, "utf8"), fs.readFileSync(path.join(repoRoot, "globals", "packages", ID, "gitconfig"), "utf8"));
  assert.ok(claudeSettings().permissions.allow.includes("Bash(gh api:*)"), "enable re-renders Claude permissions for the identity");
  // The package adds the pair that includes its gitconfig, after the baseline's, and counts it.
  assert.deepEqual(
    Object.fromEntries(Object.entries(claudeSettings().env).filter(([name]) => name.startsWith("GIT_CONFIG_"))),
    { ...baselineGitEnv, GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_1: "include.path", GIT_CONFIG_VALUE_1: AGENT_GITCONFIG_INCLUDE },
  );
  configsOn = liveConfigs();
  assert.deepEqual(agentGitRoutingGaps({ providers: agentShellProviders, read: readFrom(configsOn) }), [], "on: every agent shell includes the bot's Git settings");

  const codexOn = codexConfig();
  assert.ok(codexOn.includes(`GH_CONFIG_DIR = ${JSON.stringify(ghDir)}`), "Codex shell env points at the bot's gh directory");
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN"]) assert.ok(codexOn.includes(`${name} = ""`), `Codex shell env blanks ${name}`);
  assert.match(codexOn, /network_proxy = true/);
  assert.match(codexOn, /\[permissions\.managed-workspace\.network\.domains\]/);
  for (const host of ["github.com", "api.github.com", "example.com"]) assert.ok(domain(codexOn, host), `on: domains table allows ${host}`);
  assert.equal(codexOn.match(/^\[permissions\.managed-workspace\.network\.domains\]$/gm).length, 1, "on: one domains table");
  assert.match(codexOn, /\[permissions\.managed-workspace\.network\]\nenabled = true/, "Codex network is on");
  assert.doesNotMatch(codexOn, /cert\.pem/);
  assert.match(codexOn, /^GIT_CONFIG_COUNT = "2"$/m);
  assert.ok(codexOn.includes(`GIT_CONFIG_VALUE_1 = ${JSON.stringify(AGENT_GITCONFIG_INCLUDE)}`), "Codex shell env includes the bot's Git settings");
  assert.equal(AGENT_GITCONFIG_INCLUDE, gitconfig, "the rendered include names the installed file under the state root");
  // Git reads the bot's nested settings from the state root too: the include in the agent
  // environment names the installed file, and its own includes resolve from that file's folder.
  fs.mkdirSync(path.join(stateRoot, "github-agent"), { recursive: true });
  fs.writeFileSync(path.join(stateRoot, "github-agent", "gitconfig.local"), "[roborepo]\n\tca = 1\n");
  const codexValue = /^GIT_CONFIG_VALUE_1 = (".*")$/m.exec(codexOn)?.[1];
  for (const value of [claudeSettings().env.GIT_CONFIG_VALUE_1, codexValue && JSON.parse(codexValue)]) {
    const read = spawnSync("git", ["config", "--includes", "--get", "roborepo.ca"], {
      cwd: home, encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "include.path", GIT_CONFIG_VALUE_0: value },
    });
    assert.equal(read.stdout.trim(), "1", `the include ${value} reaches the setup-written CA config under the state root`);
  }

  // Codex's prefix rules follow the identity: enable rewrites the live rules file.
  const rulesOn = codexRules();
  assert.match(rulesOn, /pattern=\["gh", "api"\], decision="allow"/, "on: Codex rules allow gh api");
  assert.match(rulesOn, /pattern=\["git", "push"\], decision="allow"/, "on: Codex rules allow git push");
  assert.match(rulesOn, /pattern=\["gh", "pr", "comment"\], decision="allow"/, "on: Codex rules allow posting");
  assert.match(rulesOn, /pattern=\["git", "push", "--force"\], decision="forbidden"/, "on: force pushes stay forbidden");

  // The domains table is not part of the generated block, so every later render keeps it, including
  // the render `roborepo update` does after merging the shipped template into the live file.
  const template = fs.readFileSync(path.join(repoRoot, "generated", "codex", "config.toml"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "manifests", "inventory", "agent-permissions.json"), "utf8"));
  const rerender = (text) => renderCodexConfig(text, resolveBehaviors(manifest, {}, { agentIdentity: true }), resolveArbitraryCommands(manifest), "config.toml", { agentIdentity: true });
  const updated = rerender(mergeCodexConfig(template, codexOn));
  assert.match(updated, /\[permissions\.managed-workspace\.network\.domains\]/, "an update render keeps the GitHub domains");
  assert.match(updated, /network_proxy = true/);
  assert.ok(updated.includes(`GH_CONFIG_DIR = ${JSON.stringify(ghDir)}`));
  assert.match(updated, /^GIT_CONFIG_COUNT = "2"$/m, "an update keeps the package's pair counted");
  assert.ok(updated.includes(`GIT_CONFIG_VALUE_1 = ${JSON.stringify(AGENT_GITCONFIG_INCLUDE)}`));

  // An install rendered by an earlier release carries the `~/` include, which the package owns, so
  // re-applying the package moves it to the path under the state root.
  const settingsFile = path.join(home, ".claude", "settings.json");
  const legacySettings = claudeSettings();
  legacySettings.env.GIT_CONFIG_VALUE_1 = "~/.roborepo/package-runtime/github-agent-identity/gitconfig";
  fs.writeFileSync(settingsFile, JSON.stringify(legacySettings, null, 2));
  const reapplied = run("package", "enable", ID);
  assert.equal(reapplied.status, 0, `re-enable failed\n${reapplied.stdout}\n${reapplied.stderr}`);
  assert.equal(claudeSettings().env.GIT_CONFIG_VALUE_1, gitconfig, "re-applying rewrites the earlier `~/` include");

  const disabled = run("package", "disable", ID);
  assert.equal(disabled.status, 0, `disable failed\n${disabled.stdout}\n${disabled.stderr}`);
  assert.equal(claudeSettings().env?.GH_CONFIG_DIR, undefined, "Claude env no longer names the bot directory");
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN"]) assert.equal(claudeSettings().env?.[name], undefined, `Claude env no longer blanks ${name}`);
  assert.ok(!fs.existsSync(gitconfig), "the gitconfig asset is removed");
  assert.ok(claudeSettings().permissions.deny.includes("Bash(gh api:*)"), "disable restores the baseline Claude permissions");
  // Disable takes the pair back out, so nothing points at the removed gitconfig.
  assert.deepEqual(Object.fromEntries(Object.entries(claudeSettings().env || {}).filter(([name]) => name.startsWith("GIT_CONFIG_"))), baselineGitEnv);
  const codexOff = codexConfig();
  assert.doesNotMatch(codexOff, /GH_CONFIG_DIR|GH_TOKEN|GITHUB_TOKEN|network_proxy|github\.com|GIT_CONFIG_(KEY|VALUE)_1|package-runtime\/github-agent-identity/, "Codex config is clean after disable");
  assert.match(codexOff, /^GIT_CONFIG_COUNT = "1"$/m);
  assert.ok(domain(codexOff, "example.com"), "off: the user's own domain stays");
  assert.equal(codexRules(), baselineRules, "off: Codex rules return to the identity-off baseline");
  assert.match(codexOff, /\[permissions\.managed-workspace\.network\]\nenabled = false/);
  assert.doesNotMatch(codexOff, /cert\.pem/);

  // The package gitconfig clears inherited credential helpers for github.com only, so the bot's gh
  // helper answers there and another host keeps the user's helper. A stub `gh` stands in for the bot.
  const creds = path.join(home, "creds");
  fs.mkdirSync(path.join(creds, "bin"), { recursive: true });
  const stub = (file, user) => fs.writeFileSync(file, `#!/bin/sh\necho username=${user}\necho password=x\n`, { mode: 0o755 });
  stub(path.join(creds, "bin", "gh"), "bot");
  stub(path.join(creds, "user-helper"), "user");
  fs.writeFileSync(path.join(creds, "global"), `[credential]\n\thelper = ${path.join(creds, "user-helper")}\n`);
  const fill = (host) => spawnSync("git", ["credential", "fill"], {
    input: `protocol=https\nhost=${host}\n\n`,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${path.join(creds, "bin")}${path.delimiter}${process.env.PATH}`,
      GIT_CONFIG_GLOBAL: path.join(creds, "global"),
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "include.path",
      GIT_CONFIG_VALUE_0: path.join(repoRoot, "globals", "packages", ID, "gitconfig"),
    },
  }).stdout.match(/^username=(.*)$/m)?.[1];
  assert.equal(fill("github.com"), "bot", "github.com asks the bot's gh helper, not the user's");
  assert.equal(fill("gitlab.example.com"), "user", "another host keeps the user's credential helper");
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

// The card's "Agents use the bot" check: which live configs leave agents' Git without the bot's
// settings. Every provider with an agent shell is checked through its own adapter, so this test
// names no harness: the configs the package turned on include the pair; the install baselines
// (package off), or a pair outside the count or outside the agent shell's environment, do not.
{
  const providers = agentShellProviders;
  assert.ok(providers.length > 0, "at least one harness gives agents a RoboRepo-rendered shell environment");
  const byId = readFrom;
  const names = providers.map((provider) => provider.manifest.displayName);
  const shipped = Object.fromEntries(providers.map((provider) => [provider.id, fs.readFileSync(rootConfigBaseline[provider.id], "utf8")]));
  assert.deepEqual(agentGitRoutingGaps({ providers, read: byId(shipped) }), names, "the install baselines leave the pair to the package");
  const baselines = configsOn;

  // Edits the baselines as text, so the test needs no harness's config layout or format.
  const edited = (change) => Object.fromEntries(Object.entries(baselines).map(([id, text]) => {
    const next = change(text);
    assert.notEqual(next, text, `${id}: the edit applies`);
    return [id, next];
  }));
  const withoutInclude = edited((text) => text.replaceAll(AGENT_GITCONFIG_INCLUDE, "~/elsewhere"));
  assert.deepEqual(agentGitRoutingGaps({ providers, read: byId(withoutInclude) }), names, "configs without the include are reported");
  const countOfOne = edited((text) => text.replace(/(GIT_CONFIG_COUNT"?\s*[:=]\s*)"2"/, '$1"1"'));
  assert.deepEqual(agentGitRoutingGaps({ providers, read: byId(countOfOne) }), names, "an include beyond GIT_CONFIG_COUNT does not count");
  const [first] = providers;
  const [, ...others] = providers;
  const onlyFirst = byId({ [first.id]: baselines[first.id] });
  assert.deepEqual(agentGitRoutingGaps({ providers, read: onlyFirst }), others.map((provider) => provider.manifest.displayName), "a harness whose config cannot be read is a gap, never healthy");
}

// The `~/` include earlier releases rendered names the bot's file only under the default state root:
// there it still counts until `roborepo update` re-renders it; under another state root it is a gap.
{
  const legacy = "~/.roborepo/package-runtime/github-agent-identity/gitconfig";
  const module = JSON.stringify(path.join(repoRoot, "scripts", "cli", "agent-identity-package.mjs"));
  const includes = (value, stateEnv) => {
    const script = `import { includesAgentGitConfig } from ${module};
      const pairs = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "include.path", GIT_CONFIG_VALUE_0: ${JSON.stringify(value)} };
      console.log(includesAgentGitConfig((name) => pairs[name]));`;
    const childEnv = { ...process.env, HOME: home, ...stateEnv };
    if (!stateEnv.ROBOREPO_STATE_ROOT) delete childEnv.ROBOREPO_STATE_ROOT;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: childEnv, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim() === "true";
  };
  const defaultFile = path.join(home, ".roborepo", "package-runtime", ID, "gitconfig");
  assert.equal(includes(legacy, {}), true, "the `~/` include counts under the default state root");
  assert.equal(includes(defaultFile, {}), true, "the absolute include counts under the default state root");
  assert.equal(includes(legacy, { ROBOREPO_STATE_ROOT: stateRoot }), false, "the `~/` include misses the bot's file under another state root");
  assert.equal(includes(gitconfig, { ROBOREPO_STATE_ROOT: stateRoot }), true, "the include under the state root counts");
}

console.log("github-agent-identity-package ok");
