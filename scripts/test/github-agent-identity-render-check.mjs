#!/usr/bin/env node
// With the GitHub agent identity on, permissions render differently: gh api and posting to GitHub
// open up, Codex's sandbox gets network access, and nothing else about
// the credential or SSH boundaries moves. With it off the render is the shipped baseline.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  claudePermissions,
  renderCodexConfig,
  renderCodexRules,
  resolveArbitraryCommands,
  resolveBehaviors,
} from "../harnesses/permissions-render.mjs";

// CLI modules resolve the state root when they load, so an isolated one is set before importing them.
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-identity-render-"));
process.env.ROBOREPO_STATE_ROOT = stateRoot;
process.on("exit", () => fs.rmSync(stateRoot, { recursive: true, force: true }));
const { CODEX_RULES_HOME_SUB, previewPermissionRenders, renderPermissionsTo, writeCodexRulesFile } = await import("../cli/permissions-render.mjs");
const { effectivePermissions } = await import("../cli/config-mutate.mjs");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "manifests", "inventory", "agent-permissions.json"), "utf8"));
const commands = resolveArbitraryCommands(manifest);

const codexConfig = (agentIdentityProviders, overrides = {}) =>
  renderCodexConfig("", resolveBehaviors(manifest, overrides, { agentIdentityProviders }), commands, "config.toml", { agentIdentityProviders });

// Codex: off.
const off = codexConfig([]);
assert.match(off, /\[permissions\.managed-workspace\.network\]\nenabled = false/, "off: Codex network stays off");
assert.doesNotMatch(off, /cert\.pem/, "off: no CA bundle grants");
assert.doesNotMatch(off, /github\.com/, "off: no GitHub domains");

// Codex: on.
const on = codexConfig(["github"]);
assert.match(on, /\[permissions\.managed-workspace\.network\]\nenabled = true/, "on: Codex network is on");
assert.doesNotMatch(on, /cert\.pem/, "on: no CA bundle grants (setup copies the bundle instead)");
assert.match(on, /^"~\/\.ssh\/\*\*" = "deny"$/m, "on: SSH keys stay denied");
assert.doesNotMatch(on, /allow_local_binding\s*=\s*true/, "on: no local binding");
assert.equal(codexConfig(["github"]), on, "on: rendering is stable");

// The identity bucket applies before personal overrides, which still win.
const overridden = resolveBehaviors(manifest, { "read-and-reply-on-github": "deny" }, { agentIdentityProviders: ["github"] });
assert.equal(overridden.find((b) => b.id === "read-and-reply-on-github").bucket, "deny", "a personal override beats the identity bucket");
assert.equal(resolveBehaviors(manifest, {}, { agentIdentityProviders: ["github"] }).find((b) => b.id === "push-code").bucket, "allow");
assert.equal(resolveBehaviors(manifest).find((b) => b.id === "push-code").bucket, "ask", "default bucket without the identity");

// Codex rules: pushes stop prompting under the identity; setup stays forbidden and status allowed.
const rulesOff = renderCodexRules(manifest);
const rulesOn = renderCodexRules(manifest, {}, { agentIdentityProviders: ["github"] });
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
const claudeOn = claudePermissions(manifest, {}, { agentIdentityProviders: ["github"] });
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
// Claude's push-code ask renders no rule (the hook decides), and the identity leaves it that way:
// a hook-decided ask keeps its default bucket for Claude, while Codex's rule above becomes allow.
for (const [label, rules] of [["off", claudeOff], ["on", claudeOn]]) {
  for (const bucket of ["allow", "ask", "deny"]) {
    assert.ok(!rules[bucket].includes("Bash(git push:*)"), `${label}: Claude has no git push ${bucket} rule`);
  }
}
// A personal push-code override still renders for Claude under the identity.
assert.ok(claudePermissions(manifest, { behaviors: { "push-code": "deny" } }, { agentIdentityProviders: ["github"] }).deny.includes("Bash(git push:*)"));

// Doctor's preview renders what the live render writes, identity included, so an identity-on
// install does not read as drift that `roborepo update` would not change.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-identity-preview-"));
  try {
    const codexConfigFile = path.join(tmp, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(codexConfigFile), { recursive: true });
    fs.writeFileSync(codexConfigFile, "");
    for (const agentIdentityProviders of [["github"], []]) {
      renderPermissionsTo(tmp, { manifest, agentIdentityProviders });
      const preview = previewPermissionRenders(tmp, { manifest, agentIdentityProviders }).find((entry) => entry.file === codexConfigFile);
      assert.ok(preview, "the Codex config is previewed");
      assert.equal(preview.render(), fs.readFileSync(codexConfigFile, "utf8"), `identity ${agentIdentityProviders.length ? "on" : "off"}: the preview matches the live render`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// The live Codex rules file follows the identity, never writes through a rules folder linked into
// the checkout, and returns to the shipped baseline when the identity is off. The link cases point
// at the real checkout, since that is what the guard compares against; should the guard regress,
// `finally` puts the shipped rules back and removes any folder made there.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-codex-rules-"));
  const shippedFile = path.join(repoRoot, "generated", "codex", "rules", "roborepo.rules");
  const shippedRules = fs.readFileSync(shippedFile, "utf8");
  const strayRules = path.join(repoRoot, "generated", "rules");
  const strayExisted = fs.existsSync(strayRules);
  try {
    const codexHome = path.join(tmp, ".codex");
    const file = path.join(codexHome, CODEX_RULES_HOME_SUB);
    assert.equal(writeCodexRulesFile(codexHome, { manifest, agentIdentityProviders: ["github"] }), true);
    assert.equal(fs.readFileSync(file, "utf8"), rulesOn);
    assert.equal(writeCodexRulesFile(codexHome, { manifest, agentIdentityProviders: ["github"] }), false, "an unchanged render writes nothing");
    assert.equal(writeCodexRulesFile(codexHome, { manifest, agentIdentityProviders: [] }), true);
    assert.equal(fs.readFileSync(file, "utf8"), fs.readFileSync(path.join(repoRoot, "generated", "codex", "rules", "roborepo.rules"), "utf8"));

    // A rules folder linked into the checkout is never written through.
    const checkoutRules = path.join(repoRoot, "generated", "codex", "rules");
    const shipped = fs.readFileSync(path.join(checkoutRules, "roborepo.rules"), "utf8");
    const linkedHome = path.join(tmp, "linked");
    fs.mkdirSync(linkedHome);
    fs.symlinkSync(checkoutRules, path.join(linkedHome, "rules"));
    assert.equal(writeCodexRulesFile(linkedHome, { manifest, agentIdentityProviders: ["github"] }), false);
    assert.equal(fs.readFileSync(path.join(checkoutRules, "roborepo.rules"), "utf8"), shipped, "a rules folder linked into the checkout is left alone");

    // A Codex home linked into the checkout is never written through either, whether the rules
    // folder below it exists or would be made.
    const checkoutCodex = path.join(repoRoot, "generated", "codex");
    fs.symlinkSync(checkoutCodex, path.join(tmp, "linked-home"));
    assert.equal(writeCodexRulesFile(path.join(tmp, "linked-home"), { manifest, agentIdentityProviders: ["github"] }), false);
    assert.equal(fs.readFileSync(path.join(checkoutRules, "roborepo.rules"), "utf8"), shipped, "a rules folder below a linked home is left alone");
    const noRules = path.join(repoRoot, "generated");
    assert.ok(!fs.existsSync(path.join(noRules, "rules")));
    fs.symlinkSync(noRules, path.join(tmp, "linked-bare-home"));
    assert.equal(writeCodexRulesFile(path.join(tmp, "linked-bare-home"), { manifest, agentIdentityProviders: ["github"] }), false);
    assert.ok(!fs.existsSync(path.join(noRules, "rules")), "no rules folder is made inside the checkout");

    // A rules folder linked anywhere else (a dotfiles folder) gets the file, like a real folder.
    const dotfilesHome = path.join(tmp, "dotfiles-home");
    const dotfilesRules = path.join(tmp, "dotfiles", "codex-rules");
    fs.mkdirSync(dotfilesRules, { recursive: true });
    fs.mkdirSync(dotfilesHome);
    fs.symlinkSync(dotfilesRules, path.join(dotfilesHome, "rules"));
    assert.equal(writeCodexRulesFile(dotfilesHome, { manifest, agentIdentityProviders: ["github"] }), true);
    assert.equal(fs.readFileSync(path.join(dotfilesRules, "roborepo.rules"), "utf8"), rulesOn, "a rules folder linked outside the checkout is written through");
    // So does a home linked to a dotfiles folder, with its rules folder made there.
    const dotfilesCodex = path.join(tmp, "dotfiles", "codex");
    fs.mkdirSync(dotfilesCodex);
    fs.symlinkSync(dotfilesCodex, path.join(tmp, "dotfiles-linked-home"));
    assert.equal(writeCodexRulesFile(path.join(tmp, "dotfiles-linked-home"), { manifest, agentIdentityProviders: ["github"] }), true);
    assert.equal(fs.readFileSync(path.join(dotfilesCodex, "rules", "roborepo.rules"), "utf8"), rulesOn);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (fs.readFileSync(shippedFile, "utf8") !== shippedRules) fs.writeFileSync(shippedFile, shippedRules);
    if (!strayExisted) fs.rmSync(strayRules, { recursive: true, force: true });
  }
}

// The config panel and `config status` read effectivePermissions, which must show the buckets the
// render writes: the identity's buckets when it is on, personal overrides on top.
{
  fs.writeFileSync(path.join(stateRoot, "command-overrides.json"), JSON.stringify({ behaviors: { "post-to-github": "deny" }, commands: {} }));
  const byId = (agentIdentityProviders) => new Map(effectivePermissions({ agentIdentityProviders }).behaviors.map((b) => [b.id, b]));
  const on = byId(["github"]);
  const off = byId([]);
  assert.equal(on.get("read-and-reply-on-github").bucket, "allow", "on: gh api shows allow");
  assert.equal(on.get("read-and-reply-on-github").defaultBucket, "allow", "on: its default is the identity bucket");
  assert.equal(on.get("push-code").bucket, "allow");
  assert.equal(off.get("read-and-reply-on-github").bucket, "deny", "off: gh api shows deny");
  assert.equal(off.get("push-code").bucket, "ask");
  assert.equal(on.get("post-to-github").bucket, "deny", "a personal override beats the identity bucket");
  assert.equal(on.get("post-to-github").overridden, true);
  assert.equal(on.get("post-to-github").defaultBucket, "allow");
  assert.equal(off.get("post-to-github").defaultBucket, "ask");
}

// Every gh behavior is tagged with its host.
for (const behavior of manifest.behaviors) {
  const startsWithGh = (behavior.commands ?? []).some((c) => c[0] === "gh");
  if (startsWithGh) assert.equal(behavior.host, "github", `${behavior.id} names its host`);
}

console.log("github-agent-identity-render ok");
