#!/usr/bin/env node
// With the GitHub agent identity on, permissions render differently: gh api and posting to GitHub
// open up, Codex's sandbox gets network access plus a CA bundle read grant, and nothing else about
// the credential or SSH boundaries moves. With it off the render is the shipped baseline.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  claudePermissions,
  renderCodexConfig,
  renderCodexRules,
  resolveArbitraryCommands,
  resolveBehaviors,
} from "../harnesses/permissions-render.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "manifests", "inventory", "agent-permissions.json"), "utf8"));
const commands = resolveArbitraryCommands(manifest);

const codexConfig = (agentIdentity, overrides = {}) =>
  renderCodexConfig("", resolveBehaviors(manifest, overrides, { agentIdentity }), commands, "config.toml", { agentIdentity });

// Codex: off.
const off = codexConfig(false);
assert.match(off, /\[permissions\.managed-workspace\.network\]\nenabled = false/, "off: Codex network stays off");
assert.doesNotMatch(off, /cert\.pem/, "off: no CA bundle grants");
assert.doesNotMatch(off, /github\.com/, "off: no GitHub domains");

// Codex: on.
const on = codexConfig(true);
assert.match(on, /\[permissions\.managed-workspace\.network\]\nenabled = true/, "on: Codex network is on");
assert.match(on, /^"\/etc\/ssl\/cert\.pem" = "read"$/m, "on: reads the CA bundle");
assert.match(on, /^"\/private\/etc\/ssl\/cert\.pem" = "read"$/m, "on: reads the macOS CA bundle");
assert.match(on, /^"~\/\.ssh\/\*\*" = "deny"$/m, "on: SSH keys stay denied");
assert.doesNotMatch(on, /allow_local_binding\s*=\s*true/, "on: no local binding");
assert.equal(codexConfig(true), on, "on: rendering is stable");

// The identity bucket applies before personal overrides, which still win.
const overridden = resolveBehaviors(manifest, { "read-and-reply-on-github": "deny" }, { agentIdentity: true });
assert.equal(overridden.find((b) => b.id === "read-and-reply-on-github").bucket, "deny", "a personal override beats the identity bucket");
assert.equal(resolveBehaviors(manifest, {}, { agentIdentity: true }).find((b) => b.id === "push-code").bucket, "allow");
assert.equal(resolveBehaviors(manifest).find((b) => b.id === "push-code").bucket, "ask", "default bucket without the identity");

// Codex rules: pushes stop prompting under the identity; setup stays forbidden and status allowed.
const rulesOff = renderCodexRules(manifest);
const rulesOn = renderCodexRules(manifest, {}, { agentIdentity: true });
const rule = (text, pattern) => text.split("\n").find((line) => line.startsWith(`prefix_rule(pattern=${pattern},`)) ?? "";
assert.match(rule(rulesOff, '["git", "push"]'), /decision="prompt"/);
assert.match(rule(rulesOn, '["git", "push"]'), /decision="allow"/);
assert.match(rule(rulesOn, '["git", "push", "--force"]'), /decision="forbidden"/, "force pushes stay forbidden");
for (const text of [rulesOff, rulesOn]) {
  assert.match(rule(text, '["roborepo", "github", "setup"]'), /decision="forbidden"/);
  assert.match(rule(text, '["roborepo", "github", "status"]'), /decision="allow"/);
  assert.match(rule(text, '["gh", "auth", "token"]'), /decision="forbidden"/);
}
assert.match(rule(rulesOff, '["gh", "api"]'), /decision="forbidden"/);
assert.match(rule(rulesOn, '["gh", "api"]'), /decision="allow"/);

// Claude.
const claudeOff = claudePermissions(manifest);
const claudeOn = claudePermissions(manifest, {}, { agentIdentity: true });
assert.ok(claudeOff.deny.includes("Bash(gh api:*)"), "off: gh api denied");
assert.ok(!claudeOff.allow.includes("Bash(gh api:*)"));
assert.ok(claudeOn.allow.includes("Bash(gh api:*)"), "on: gh api allowed");
assert.ok(!claudeOn.deny.includes("Bash(gh api:*)"));
assert.ok(claudeOff.ask.includes("Bash(gh pr comment:*)"), "off: posting to GitHub prompts");
assert.ok(claudeOn.allow.includes("Bash(gh pr comment:*)"), "on: posting to GitHub is allowed");
assert.ok(claudeOn.deny.includes("Bash(gh pr merge:*)"), "on: merging stays denied");
for (const [label, rules] of [["off", claudeOff], ["on", claudeOn]]) {
  assert.ok(rules.deny.includes("Bash(roborepo github setup:*)"), `${label}: setup denied`);
  assert.ok(rules.allow.includes("Bash(roborepo github status:*)"), `${label}: status allowed`);
  assert.ok(rules.deny.includes("Bash(gh auth token:*)"), `${label}: gh auth token denied`);
}
// Claude's push-code ask renders no rule (the hook asks); the identity moves it to a plain allow.
assert.ok(!claudeOff.ask.includes("Bash(git push:*)") && !claudeOff.allow.includes("Bash(git push:*)"));
assert.ok(claudeOn.allow.includes("Bash(git push:*)"));

// Every gh behavior is tagged with its host.
for (const behavior of manifest.behaviors) {
  const startsWithGh = (behavior.commands ?? []).some((c) => c[0] === "gh");
  if (startsWithGh) assert.equal(behavior.host, "github", `${behavior.id} names its host`);
}

console.log("github-agent-identity-render ok");
