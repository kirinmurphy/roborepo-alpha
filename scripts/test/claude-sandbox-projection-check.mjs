#!/usr/bin/env node
// Pins the Claude provider's `sandbox` settings key for default and overridden behaviors.
// Projection only: scripts/test/claude-sandbox-enforcement-check.mjs is the runtime evidence, and
// the coverage fixture below records what it last observed.
import assert from "node:assert/strict";
import fs from "node:fs";
import { getHarnessProvider } from "../harnesses/registry.mjs";
import { CLAUDE_SANDBOX_EXCLUDED_COMMANDS } from "../harnesses/claude/sandbox-settings.mjs";

const manifest = JSON.parse(fs.readFileSync(new URL("../../manifests/inventory/agent-permissions.json", import.meta.url)));
const claude = getHarnessProvider("claude");
const render = (current, overrides = {}) => claude.adapters.permissions.render(current, manifest, overrides, "settings.json", {});
const sandboxOf = (overrides) => JSON.parse(render("{}", overrides)).sandbox;

const secrets = manifest.behaviors.find((b) => b.id === "read-secrets");
const hosts = manifest.behaviors.find((b) => b.id === "reach-allowed-hosts");

// Default: confined, prompt-free, CA bundles re-allowed, listed hosts reachable.
const defaults = sandboxOf();
assert.deepEqual(defaults, {
  enabled: true,
  autoAllowBashIfSandboxed: true,
  excludedCommands: [...CLAUDE_SANDBOX_EXCLUDED_COMMANDS],
  filesystem: { allowWrite: ["~/.npm"], allowRead: secrets.readableExceptions },
  network: { allowLocalBinding: false, allowedDomains: hosts.hosts },
});
assert.ok(secrets.paths.includes("//**/*.pem"), "the exceptions exist because *.pem is denied");
assert.ok(secrets.readableExceptions.every((p) => p.endsWith(".pem") && p.startsWith("/")), "exceptions are absolute CA bundle paths");
assert.ok(!("strictAllowlist" in defaults.network), "unlisted hosts prompt rather than fail");
assert.ok(!defaults.filesystem.allowWrite.some((p) => p.includes("repo_plans")), "the plans store stays unwritable from the sandbox");

// Writable temp folders and unreadable credentials reach the sandbox through the permission rules
// Claude merges into it, so the permissions key must keep carrying them.
const permissions = JSON.parse(render("{}")).permissions;
assert.ok(permissions.allow.includes("Edit(//tmp/**)"), "write-scope Edit allows feed the sandbox's writable paths");
assert.ok(permissions.deny.includes("Read(//**/*.pem)"), "read-secrets Read denies feed the sandbox's denied paths");

// Shell sandbox buckets.
assert.equal(sandboxOf({ behaviors: { "sandbox-shell": "ask" } }).autoAllowBashIfSandboxed, false, "ask keeps the sandbox but prompts");
assert.equal(sandboxOf({ behaviors: { "sandbox-shell": "ask" } }).enabled, true);
assert.deepEqual(sandboxOf({ behaviors: { "sandbox-shell": "deny" } }), { enabled: false }, "deny turns the sandbox off");

// Host list buckets.
assert.ok(!("allowedDomains" in sandboxOf({ behaviors: { "reach-allowed-hosts": "ask" } }).network), "ask leaves listed hosts to prompt");
assert.ok(!("deniedDomains" in sandboxOf({ behaviors: { "reach-allowed-hosts": "ask" } }).network));
const deniedHosts = sandboxOf({ behaviors: { "reach-allowed-hosts": "deny" } }).network;
assert.deepEqual(deniedHosts.deniedDomains, hosts.hosts, "deny refuses listed hosts");
assert.ok(!("allowedDomains" in deniedHosts));

// Without denied credentials there is nothing to carve the CA bundles out of.
for (const bucket of ["allow", "ask"]) {
  assert.ok(!("allowRead" in sandboxOf({ behaviors: { "read-secrets": bucket } }).filesystem), `read-secrets ${bucket}`);
}

// go-online stays Codex's switch: it never changes Claude's sandbox.
for (const bucket of ["allow", "ask", "deny"]) {
  assert.deepEqual(sandboxOf({ behaviors: { "go-online": bucket } }), defaults, `go-online ${bucket}`);
}

// Unrelated settings and hooks survive; a hand-edited sandbox is replaced; a second render is stable.
const current = JSON.stringify({
  theme: "dark",
  env: { KEEP: "1" },
  hooks: { Stop: [{ hooks: [{ type: "command", command: "echo user-hook" }] }] },
  sandbox: { enabled: false, excludedCommands: ["make *"], network: { allowLocalBinding: true } },
});
const first = render(current);
const parsed = JSON.parse(first);
assert.equal(parsed.theme, "dark");
assert.deepEqual(parsed.env, { KEEP: "1" });
assert.ok(parsed.hooks.Stop.some((entry) => entry.hooks.some((hook) => hook.command === "echo user-hook")), "user hooks are kept");
assert.ok(parsed.hooks.PreToolUse?.length, "core hooks are still merged");
assert.deepEqual(parsed.sandbox, defaults, "RoboRepo owns the sandbox key and replaces it whole");
assert.equal(render(first), first, "re-render is stable");

// A manifest with no shell-sandbox intent leaves the key as it found it.
const withoutSandbox = structuredClone(manifest);
withoutSandbox.behaviors = withoutSandbox.behaviors.filter((b) => b.kind !== "shell-sandbox");
const untouched = JSON.parse(claude.adapters.permissions.render(current, withoutSandbox, {}, "settings.json", {}));
assert.deepEqual(untouched.sandbox, JSON.parse(current).sandbox);

// The new kinds are Claude's alone: neither Codex nor Gemini output mentions them.
const codex = getHarnessProvider("codex").adapters.permissions.render("", manifest, {}, "config.toml", {});
const gemini = getHarnessProvider("gemini").adapters.permissions.render("", manifest, {}, "policy.toml", {});
for (const [name, output] of [["codex", codex], ["gemini", gemini]]) {
  for (const host of hosts.hosts) assert.ok(!output.includes(host), `${name} ignores the allowed-host list`);
  for (const bundle of secrets.readableExceptions) assert.ok(!output.includes(bundle), `${name} ignores the CA exceptions`);
}
assert.ok(!permissions.allow.some((rule) => hosts.hosts.some((host) => rule.includes(host))), "hosts are not permission rules");

// No bucket of a Claude-only behavior changes Codex or Gemini output, starting from a baseline
// with no ask anywhere (Codex's approval policy turns on any ask).
const noAsk = Object.fromEntries(manifest.behaviors.filter((b) => b.bucket === "ask").map((b) => [b.id, "allow"]));
const otherOutputs = (behaviors) => ["codex", "gemini"].map((id) => getHarnessProvider(id).adapters.permissions.render("", manifest, { behaviors }, "out", {}));
const baseline = otherOutputs(noAsk);
assert.match(baseline[0], /approval_policy = "never"/, "the baseline has no ask");
for (const b of manifest.behaviors.filter((behavior) => behavior.claudeOnly)) {
  for (const bucket of ["allow", "ask", "deny"]) {
    assert.deepEqual(otherOutputs({ ...noAsk, [b.id]: bucket }), baseline, `${b.id} ${bucket} leaves Codex and Gemini unchanged`);
  }
}

// The enforcement runner's last recorded observation.
const coverage = JSON.parse(fs.readFileSync(new URL("./fixtures/claude-sandbox/coverage.json", import.meta.url)));
assert.equal(coverage.schemaVersion, 1);
assert.ok(coverage.observations.length);
for (const observation of coverage.observations) {
  for (const key of ["date", "version", "platform", "policySource", "surface", "result", "controls"]) assert.ok(observation[key], `missing coverage field ${key}`);
  assert.equal(observation.platform, "darwin", "other platforms require independent enforcement evidence");
  assert.equal(observation.result, "passed");
  for (const control of ["temp write", "workspace write", "home write refused", "credential read refused", "CA bundle read", "allowed host connects", "excluded command unsandboxed", "missing-sandbox mutation"]) {
    assert.ok(observation.controls.includes(control), `coverage records ${control}`);
  }
}
assert.deepEqual(coverage.unverified, ["desktop app", "piped excluded commands", "unlisted hosts", "sandbox-shell ask", "reach-allowed-hosts ask and deny", "Linux", "Windows"]);

console.log("claude-sandbox-projection: ok");
