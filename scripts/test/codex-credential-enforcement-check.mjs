#!/usr/bin/env node
// Explicit native verification, intentionally excluded from deterministic CI groups. Unavailable
// runtimes exit 2; a missing native sandbox must never turn a coverage claim green.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getHarnessProvider } from "../harnesses/registry.mjs";
import { detectHarnessProvider, selectedHarnessExecutable } from "../harnesses/discovery.mjs";

const provider = getHarnessProvider("codex");
const detection = detectHarnessProvider(provider.manifest);
const executable = selectedHarnessExecutable(provider.manifest);
const coverage = { platform: process.platform, executable, runtimes: detection.evidence.filter((item) => item.kind === "executable"), policySource: "fresh synthetic CODEX_HOME/config.toml", surface: "native sandbox commands and descendant processes", unverified: ["desktop session policy", "product structured-read tools", "browser", "MCP", "escalated processes", "Linux", "Windows"] };
if (!executable || process.platform !== "darwin") {
  console.error(JSON.stringify({ ...coverage, status: "unavailable", reason: !executable ? "Codex binary missing" : "platform enforcement not verified" }, null, 2));
  process.exit(2);
}
const manifest = JSON.parse(fs.readFileSync(new URL("../../manifests/inventory/agent-permissions.json", import.meta.url)));
const probe = fs.readFileSync(new URL("./fixtures/codex-credentials/probe.mjs", import.meta.url), "utf8");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-credentials-")));
try {
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.mkdirSync(workspace);
  // Independent examples pin every current manifest pattern; adding a pattern requires a new
  // example rather than letting renderer and fixture share the same translation mistake.
  const examples = [
    ["~/.ssh/**", "home/.ssh/key"], ["~/.aws/**", "home/.aws/credentials"],
    ["~/.gnupg/**", "home/.gnupg/key"], ["~/.config/gcloud/**", "home/.config/gcloud/key"],
    ["~/Library/Keychains/**", "home/Library/Keychains/key"],
    ["//**/.env", "workspace/.env"], ["//**/.env.local", "workspace/.env.local"],
    ["//**/.env.*.local", "workspace/.env.preview.local"],
    ["//**/.env.development", "workspace/.env.development"], ["//**/.env.production", "workspace/.env.production"],
    ["//**/.env.staging", "workspace/.env.staging"], ["//**/.env.test", "workspace/.env.test"],
    ["//**/*.pem", "workspace/key.pem"], ["//**/id_rsa", "workspace/id_rsa"],
    ["//**/id_ed25519", "workspace/id_ed25519"],
  ];
  assert.deepEqual(examples.map(([pattern]) => pattern), manifest.behaviors.find((b) => b.id === "read-secrets").paths);
  const fixtures = [];
  for (const [, example] of examples) {
    const directory = path.dirname(example);
    for (const file of [example, `${directory}/deep/a/b/c/d/e/f/g/h/i/j/${path.basename(example)}`]) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), "synthetic-credential-canary");
      fixtures.push(file);
    }
  }
  fs.symlinkSync(path.join(workspace, ".env"), path.join(workspace, "innocent-link"));
  fixtures.push("workspace/innocent-link");
  fs.writeFileSync(path.join(root, "fixtures.json"), JSON.stringify(fixtures));
  fs.writeFileSync(path.join(root, "probe.mjs"), probe);
  fs.writeFileSync(path.join(root, "public.txt"), "public");
  for (const template of [".env.example", ".env.sample", "other.config"]) fs.writeFileSync(path.join(workspace, template), "template");
  const configPath = path.join(home, ".codex", "config.toml");
  const env = { ...process.env, HOME: home, CODEX_HOME: path.dirname(configPath) };
  const run = (command, args) => spawnSync(command, args, { cwd: workspace, env, encoding: "utf8", timeout: 30000 });
  const unrestricted = run(process.execPath, [path.join(root, "probe.mjs"), root, "allow", "workspace-write"]);
  assert.equal(unrestricted.status, 0, `unrestricted positive control failed: ${unrestricted.stderr}`);
  const results = [];
  for (const write of ["allow", "deny"]) {
    const profile = write === "allow" ? "managed-workspace" : "managed-read-only";
    const config = provider.adapters.permissions.render("", manifest, { behaviors: { "write-files": write } }, configPath, { workspaceRoots: [root] });
    fs.writeFileSync(configPath, config);
    const result = run(executable, ["sandbox", "--include-managed-config", "-P", profile, "-C", workspace, "--", process.execPath, path.join(root, "probe.mjs"), root, "deny", write === "allow" ? "workspace-write" : "read-only"]);
    if ((result.error || /sandbox_apply: Operation not permitted|unsupported|not supported|error loading configuration|failed to parse|unknown field/i.test(result.stderr)) && !result.stdout) {
      console.error(JSON.stringify({ ...coverage, status: "unavailable", profile, reason: result.stderr.trim() || result.error?.message }, null, 2));
      process.exitCode = 2;
      break;
    }
    assert.equal(result.status, 0, `${profile}: ${result.stderr || result.error?.message}`);
    results.push({ profile, status: "passed", files: fixtures.length, output: result.stdout.trim() });
    if (write === "allow") {
      // Removing the projection must make the SAME negative controls fail, proving they can see
      // a leak rather than merely observing unrelated read-only restrictions or a broken sandbox.
      fs.writeFileSync(configPath, config.replace(/^".*" = "deny"\n/gm, ""));
      const mutation = run(executable, ["sandbox", "--include-managed-config", "-P", profile, "-C", workspace, "--", process.execPath, path.join(root, "probe.mjs"), root, "deny", "workspace-write"]);
      assert.notEqual(mutation.status, 0);
      assert.match(mutation.stderr, /credential readable/);
    }
  }
  if (!process.exitCode) console.log(JSON.stringify({ ...coverage, status: "passed", controls: "unrestricted reads/writes, missing-denies mutation, public/template reads, write boundaries, links, deep and new paths", results }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
