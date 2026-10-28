#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { getHarnessProvider } from "../harnesses/registry.mjs";

const manifest = JSON.parse(fs.readFileSync(new URL("../../manifests/inventory/agent-permissions.json", import.meta.url)));
const provider = getHarnessProvider("codex");
const coverage = JSON.parse(fs.readFileSync(new URL("./fixtures/codex-credentials/coverage.json", import.meta.url)));
assert.equal(coverage.schemaVersion, 1);
assert.ok(coverage.observations.length);
for (const observation of coverage.observations) {
  for (const key of ["date", "executableSource", "version", "platform", "policySource", "surface", "result"]) assert.ok(observation[key], `missing coverage field ${key}`);
  assert.equal(observation.platform, "darwin", "other platforms require independent enforcement evidence");
  assert.equal(observation.surface, "native sandbox commands and descendants", "process probes cannot certify product tools");
  assert.equal(observation.result, "passed");
  assert.deepEqual(observation.profiles, ["managed-workspace", "managed-read-only"]);
  assert.ok(observation.controls.includes("missing-denies mutation"));
  assert.ok(observation.controls.includes("unrestricted reads and writes"));
}
assert.deepEqual(coverage.unverified, ["desktop session policy", "product structured-read tools", "browser", "MCP", "escalated processes", "Linux", "Windows"]);
assert.deepEqual(coverage.unsupported, ["Gemini credential path denial", "Codex path-specific ask"]);
assert.equal(getHarnessProvider("gemini").manifest.capabilities.includes("permissions"), true, "unsupported path protection must not make the provider unloadable");
const patterns = manifest.behaviors.find((b) => b.id === "read-secrets").paths;
assert.equal(patterns.length, 15, "all credential forms must have independent enforcement fixtures");
for (const write of ["allow", "deny", "ask"]) {
  for (const secrets of ["deny", "allow", "ask"]) {
    const overrides = { behaviors: { "write-files": write, "read-secrets": secrets } };
    const options = { workspaceRoots: ['/work/quoted"root', "~/work"] };
    const render = (current) => provider.adapters.permissions.render(current, manifest, overrides, "config.toml", options);
    const output = render("");
    for (const pattern of patterns) {
      const native = pattern.replace(/^\/\//, "/");
      assert.equal(output.includes(`${JSON.stringify(native)} = "deny"`), secrets === "deny", `${write}/${secrets}: ${pattern}`);
    }
    assert.doesNotMatch(output, /\.env\.\*"|\.env\.(example|sample)"/);
    assert.doesNotMatch(output, /\/Users\/|\/home\//, "portable output never embeds a build home");
    assert.match(output, /approval_policy = "on-request"/);
    if (write === "allow" || secrets === "deny") assert.match(output, /enabled = false/);
    if (write === "allow") {
      assert.match(output, /extends = ":workspace"/);
      assert.ok(output.includes('"/work/quoted\\"root" = true'));
    } else {
      assert.match(output, /(?:default_permissions|extends) = ":read-only"/);
      assert.doesNotMatch(output, /workspace_roots|= "write"/);
    }
    if (secrets === "ask") assert.match(output, /path-specific prompting.*unsupported/i);
    assert.equal(render(output), output, "reapply is stable");
  }
}
const readOnlyOnline = provider.adapters.permissions.render("", manifest, {
  behaviors: { "write-files": "deny", "go-online": "allow" },
}, "config.toml");
assert.match(readOnlyOnline, /enabled = false/, "named read-only retains the built-in profile's disabled network");
const escapingManifest = structuredClone(manifest);
escapingManifest.behaviors.find((b) => b.id === "read-secrets").paths = ['~/quoted"/key.pem', '//**/back\\slash.pem'];
const escaped = provider.adapters.permissions.render("", escapingManifest, {}, "config.toml");
assert.ok(escaped.includes(`${JSON.stringify('~/quoted"/key.pem')} = "deny"`));
assert.ok(escaped.includes(`${JSON.stringify('/**/back\\slash.pem')} = "deny"`));
assert.throws(() => provider.adapters.permissions.render("", {
  behaviors: [{ id: "read-secrets", bucket: "deny", paths: ["relative/key"] }],
}, {}, "config.toml"), /Unsupported Codex credential anchor/);
console.log("codex-credential-projection: ok (15 patterns, 9 intent/write combinations)");
