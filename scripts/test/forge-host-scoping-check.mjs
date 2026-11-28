#!/usr/bin/env node
// Each forge provider's agent account acts only on that provider's hosts. For every shipped provider
// with an agent account: every section of its package gitconfig and of the Git files its setup writes
// names only its `hosts` (a plain include only reaches its own state folder), its config patches set
// only its CLI's identity variables and its own network domains, and in a fixture repo whose remote is
// on another host Git uses neither the bot's credential helper nor the bot as the commit author.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isolateGitConfig } from "./lib/git-config.mjs";
import { providersWithCapability } from "../../modules/forge/registry.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-forge-scoping-"));
isolateGitConfig(root);

// Git config sections as `{ name, subsection, keys: [[key, value]] }`, from the plain format the
// package files use (no continuation lines).
function gitconfigSections(text) {
  const sections = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s+/, "");
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[([A-Za-z0-9.-]+)(?:\s+"([^"]*)")?\]$/.exec(line);
    if (header) {
      sections.push({ name: header[1].toLowerCase(), subsection: header[2] ?? null, keys: [] });
      continue;
    }
    const entry = /^([A-Za-z0-9-]+)\s*=\s*(.*)$/.exec(line);
    assert.ok(entry && sections.length > 0, `readable gitconfig line: ${raw}`);
    sections.at(-1).keys.push([entry[1].toLowerCase(), entry[2]]);
  }
  return sections;
}

// The host a URL or remote-URL pattern names: `https://github.com/`, `git@github.com:*/**`,
// `ssh://git@github.com/`, `https://*@github.com/**`.
function hostOf(value) {
  const match = /^(?:[a-z]+:\/\/)?(?:[^@/]*@)?([^/:]+)(?:[/:]|$)/.exec(value);
  assert.ok(match, `a host in ${value}`);
  return match[1];
}

// The sections that route Git per host. `user` (the author file) and `include` are checked apart.
function checkSections(sections, provider, label) {
  const { hosts, agent } = provider.manifest;
  for (const section of sections) {
    if (["credential", "http"].includes(section.name)) {
      assert.ok(section.subsection && hosts.includes(hostOf(section.subsection)), `${label}: [${section.name} "${section.subsection}"] names only ${hosts.join(", ")}`);
    } else if (section.name === "url") {
      assert.ok(hosts.includes(hostOf(section.subsection)), `${label}: [url "${section.subsection}"] rewrites to ${hosts.join(", ")}`);
      for (const [key, value] of section.keys) {
        assert.equal(key, "insteadof", `${label}: url sections only rewrite`);
        assert.ok(hosts.includes(hostOf(value)), `${label}: insteadOf ${value} rewrites only ${hosts.join(", ")}`);
      }
    } else if (section.name === "includeif") {
      const condition = /^hasconfig:remote\.\*\.url:(.+)$/.exec(section.subsection || "");
      assert.ok(condition && hosts.includes(hostOf(condition[1])), `${label}: [includeIf "${section.subsection}"] applies only to remotes on ${hosts.join(", ")}`);
    } else if (section.name === "include") {
      for (const [, value] of section.keys) {
        assert.ok(value.startsWith(`../../${agent.stateFolder}/`), `${label}: a plain include reaches only ${agent.stateFolder}/ (got ${value})`);
      }
    } else if (section.name !== "user") {
      assert.fail(`${label}: unexpected section [${section.name}]`);
    }
  }
}

// An author or committer from the caller's environment would outrank the config under test.
const AUTHOR_VARIABLES = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"];
function git(cwd, args, env = {}) {
  const merged = { ...process.env, ...env };
  for (const name of AUTHOR_VARIABLES) delete merged[name];
  return spawnSync("git", args, { cwd, encoding: "utf8", env: merged });
}

try {
  const providers = providersWithCapability("agent-identity");
  assert.ok(providers.length > 0, "at least one provider has an agent account");
  for (const provider of providers) {
    const { hosts, cli, agent } = provider.manifest;
    const packageDir = path.join(repoRoot, "globals", "packages", agent.packageId);
    const packageGitconfig = fs.readFileSync(path.join(packageDir, "gitconfig"), "utf8");
    checkSections(gitconfigSections(packageGitconfig), provider, `${agent.packageId}/gitconfig`);

    // The files setup writes beside the token.
    const stateDir = path.join(root, provider.id, "state");
    const systemCa = path.join(root, provider.id, "system-ca.pem");
    fs.mkdirSync(path.dirname(systemCa), { recursive: true });
    fs.writeFileSync(systemCa, "fixture bundle\n");
    process.env.ROBOREPO_SYSTEM_CA_BUNDLE = systemCa;
    provider.adapters.agentIdentity.refreshLocalFiles(stateDir);
    const written = fs.readdirSync(path.join(stateDir, agent.stateFolder)).filter((name) => name.startsWith("gitconfig"));
    assert.ok(written.length > 0, `${provider.id}: setup writes a Git file`);
    for (const name of written) checkSections(gitconfigSections(fs.readFileSync(path.join(stateDir, agent.stateFolder, name), "utf8")), provider, `${agent.stateFolder}/${name}`);

    // Config patches: only the CLI's identity variables beside the one include pair, and only the
    // provider's own network domains, every one of them.
    const config = JSON.parse(fs.readFileSync(path.join(packageDir, "package.config.json"), "utf8"));
    const patches = config.resources.filter((resource) => resource.type === "config-patch").flatMap((resource) => resource.patches);
    const domains = new Set();
    for (const patch of patches) {
      const [first, second, third] = patch.path;
      const variable = first === "env" ? second : first === "shell_environment_policy" && second === "set" ? third : null;
      if (variable !== null) {
        if (["GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_1"].includes(variable)) continue;
        assert.ok(cli.identityVariables.includes(variable), `${agent.packageId}: patch sets ${variable}, one of ${provider.id}'s identity variables`);
        continue;
      }
      if (first === "permissions" && patch.path.includes("domains")) {
        domains.add(patch.path.at(-1));
        continue;
      }
      assert.deepEqual(patch.path, ["features", "network_proxy"], `${agent.packageId}: no other setting is patched (${patch.path.join(".")})`);
    }
    assert.deepEqual([...domains].sort(), [...agent.networkDomains].sort(), `${agent.packageId}: network domains equal agent.networkDomains`);

    // A fixture repo per host: the bot's helper and author reach only the provider's hosts.
    const runtime = path.join(stateDir, "package-runtime", agent.packageId);
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(runtime, "gitconfig"), packageGitconfig);
    fs.writeFileSync(path.join(stateDir, agent.stateFolder, "gitconfig.author"), "[user]\n\tname = fixture-bot\n\temail = bot@example.invalid\n");
    const routed = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "include.path", GIT_CONFIG_VALUE_0: path.join(runtime, "gitconfig") };
    const repo = (name, url) => {
      const dir = path.join(root, provider.id, name);
      assert.equal(git(root, ["init", "-q", dir]).status, 0);
      assert.equal(git(dir, ["remote", "add", "origin", url]).status, 0);
      assert.equal(git(dir, ["config", "user.name", "Person"]).status, 0);
      assert.equal(git(dir, ["config", "user.email", "person@example.invalid"]).status, 0);
      return dir;
    };
    const own = repo("own", `https://${hosts[0]}/example/project.git`);
    const other = repo("other", "https://gitlab.example.invalid/example/project.git");
    const helperFor = (dir, url) => git(dir, ["config", "--get-urlmatch", "credential.helper", url], routed).stdout.trim();
    assert.notEqual(helperFor(own, `https://${hosts[0]}/example/project.git`), "", `${provider.id}: control: its own host gets the bot's helper`);
    assert.equal(helperFor(other, "https://gitlab.example.invalid/example/project.git"), "", `${provider.id}: another host gets no helper from the bot's settings`);
    const authorIn = (dir) => git(dir, ["var", "GIT_AUTHOR_IDENT"], routed).stdout;
    assert.match(authorIn(own), /^fixture-bot <bot@example\.invalid>/, `${provider.id}: control: its own host's commits are the bot's`);
    assert.match(authorIn(other), /^Person <person@example\.invalid>/, `${provider.id}: another host's commits keep the person's author`);
    console.log(`✓ ${provider.manifest.displayName}: Git routing, setup files, and patches name only ${hosts.join(", ")}; other hosts keep your helper and author.`);
  }
} finally {
  delete process.env.ROBOREPO_SYSTEM_CA_BUNDLE;
  fs.rmSync(root, { recursive: true, force: true });
}
