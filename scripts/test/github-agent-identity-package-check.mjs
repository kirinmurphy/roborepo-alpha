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
import { expandPackageRuntimeRefs } from "../cli/package-runtime-assets.mjs";
import { renderCodexConfig, resolveArbitraryCommands, resolveBehaviors } from "../harnesses/permissions-render.mjs";
import { mergeCodexConfig } from "../cli/root-config-merge.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = path.join(repoRoot, "scripts", "cli", "main.mjs");
const ID = "github-agent-identity";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-gh-identity-"));
const stateRoot = path.join(home, ".roborepo");
fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}");
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
  assert.ok(fs.existsSync(gitconfig), "the gitconfig asset is installed");
  assert.equal(fs.readFileSync(gitconfig, "utf8"), fs.readFileSync(path.join(repoRoot, "globals", "packages", ID, "gitconfig"), "utf8"));
  assert.ok(claudeSettings().permissions.allow.includes("Bash(gh api:*)"), "enable re-renders Claude permissions for the identity");

  const codexOn = codexConfig();
  assert.ok(codexOn.includes(`GH_CONFIG_DIR = ${JSON.stringify(ghDir)}`), "Codex shell env points at the bot's gh directory");
  assert.match(codexOn, /network_proxy = true/);
  assert.match(codexOn, /\[permissions\.managed-workspace\.network\.domains\]/);
  for (const host of ["github.com", "api.github.com", "example.com"]) assert.ok(domain(codexOn, host), `on: domains table allows ${host}`);
  assert.equal(codexOn.match(/^\[permissions\.managed-workspace\.network\.domains\]$/gm).length, 1, "on: one domains table");
  assert.match(codexOn, /\[permissions\.managed-workspace\.network\]\nenabled = true/, "Codex network is on");
  assert.doesNotMatch(codexOn, /cert\.pem/);
  assert.match(fs.readFileSync(gitconfig, "utf8"), /^\[include\]\n\tpath = ~\/\.roborepo\/github-agent\/gitconfig\.local$/m, "the gitconfig includes the setup-written CA config");

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

  const disabled = run("package", "disable", ID);
  assert.equal(disabled.status, 0, `disable failed\n${disabled.stdout}\n${disabled.stderr}`);
  assert.equal(claudeSettings().env?.GH_CONFIG_DIR, undefined, "Claude env no longer names the bot directory");
  assert.ok(!fs.existsSync(gitconfig), "the gitconfig asset is removed");
  assert.ok(claudeSettings().permissions.deny.includes("Bash(gh api:*)"), "disable restores the baseline Claude permissions");
  const codexOff = codexConfig();
  assert.doesNotMatch(codexOff, /GH_CONFIG_DIR|network_proxy|github\.com/, "Codex config is clean after disable");
  assert.ok(domain(codexOff, "example.com"), "off: the user's own domain stays");
  assert.equal(codexRules(), baselineRules, "off: Codex rules return to the identity-off baseline");
  assert.match(codexOff, /\[permissions\.managed-workspace\.network\]\nenabled = false/);
  assert.doesNotMatch(codexOff, /cert\.pem/);
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("github-agent-identity-package ok");
