#!/usr/bin/env node
// `roborepo browser` through the real CLI: the feature-verification gate, package independence from
// response-output, lazy availability (nothing installed or created until a run needs it), usage
// errors, evidence placement and retention, provider failures as results, and the agent allowlist.
//
// Runs drive the stub provider, so this check needs no browser. The provider contract is
// browser-contract-check.mjs, the app lifecycle browser-lifecycle-check.mjs, and real Chromium runs
// browser-playwright-check.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBrowserCliHome } from "./lib/browser-cli-home.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = createBrowserCliHome("roborepo-browser-cli-");
const { home, stateRoot, run, stub } = cli;
const evidenceDir = path.join(stateRoot, "browser", "evidence");
const fixtures = path.join(home, "fixtures");
const DAY = 24 * 60 * 60 * 1000;

fs.mkdirSync(fixtures, { recursive: true });
const passing = writeJson("passing.json", { checks: [{ name: "renders", status: "passed" }] });
const failing = writeJson("failing.json", { checks: [{ name: "renders", status: "failed" }] });

try {
  // ---- Gate: both commands refuse until feature-verification is enabled ----
  for (const args of [["browser", "probe"], ["browser", "run", "--scenario", passing]]) {
    const refused = run(args);
    assert.equal(refused.status, 1, `${args.join(" ")} exits non-zero without the package`);
    assert.match(refused.stderr, /roborepo package enable feature-verification/, "the refusal names the enable command");
  }

  // ---- Package independence, and enabling downloads nothing ----
  assert.equal(run(["package", "enable", "feature-verification"]).status, 0);
  assert.deepEqual(enabled(), ["feature-verification"], "enabling feature-verification enables nothing else");
  assert.ok(!fs.existsSync(path.join(stateRoot, "browser")), "enabling the package creates no tool or evidence directory");
  assert.equal(run(["package", "enable", "response-output"]).status, 0);
  assert.equal(run(["package", "disable", "feature-verification"]).status, 0);
  assert.deepEqual(enabled(), ["response-output"], "response-output stands alone");
  assert.equal(run(["package", "disable", "response-output"]).status, 0);
  assert.equal(run(["package", "enable", "feature-verification"]).status, 0);

  // ---- Probe with no Playwright reachable reports, installs nothing, launches nothing ----
  const bare = path.join(home, "no-playwright");
  fs.mkdirSync(bare);
  const probe = run(["browser", "probe", "--dir", bare, "--json"]);
  assert.equal(probe.status, 0, "an unavailable provider is a report, not an error");
  const probed = JSON.parse(probe.stdout);
  assert.equal(probed.available, false);
  assert.deepEqual(probed.capabilities, { screenshot: false, video: false, trace: false });
  assert.match(probed.limitations.join("\n"), /npm install --prefix .*browser.tools playwright@/, "the limitation carries the exact install command");
  assert.ok(!fs.existsSync(path.join(stateRoot, "browser")), "probe creates nothing under the state root");

  // An installed Playwright that fails to load is reported unavailable, not as a stack trace.
  const brokenInstall = path.join(home, "broken-playwright", "node_modules", "playwright");
  fs.mkdirSync(brokenInstall, { recursive: true });
  fs.writeFileSync(path.join(brokenInstall, "package.json"), JSON.stringify({ name: "playwright", version: "0.0.0", main: "index.js" }));
  fs.writeFileSync(path.join(brokenInstall, "index.js"), 'throw new Error("broken install");\n');
  const brokenProbe = run(["browser", "probe", "--dir", path.dirname(path.dirname(brokenInstall)), "--json"]);
  assert.equal(brokenProbe.status, 0);
  assert.match(JSON.parse(brokenProbe.stdout).limitations.join("\n"), /could not load: broken install/);

  // ---- Usage errors exit 2 ----
  assert.equal(run(["browser", "run"]).status, 2, "--scenario is required");
  assert.equal(run(["browser", "run", "--scenario", path.join(fixtures, "absent.mjs")]).status, 2, "a missing scenario is a usage error");
  assert.equal(stub(["--scenario", passing, "--capture", "gif"]).status, 2, "an unknown capture type is rejected");
  assert.equal(stub(["--scenario", passing, "--timeout", "3000000"]).status, 2, "a timeout beyond Node's timer range is rejected");
  const noStub = run(["browser", "run", "--provider", "stub", "--scenario", passing]);
  assert.equal(noStub.status, 2, "the stub provider is unavailable without its test switch");
  assert.match(noStub.stderr, /contract tests only/);

  // ---- A run works with response-output off; evidence lands flat in the registered store ----
  const stale = path.join(evidenceDir, "20260101T000000Z-aaaaaa-1-screenshot.png");
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(stale, "old");
  fs.utimesSync(stale, new Date(Date.now() - 30 * DAY), new Date(Date.now() - 30 * DAY));
  // The retention engine never empties a store, so a recent file sits beside the stale one.
  const recent = path.join(evidenceDir, "20261001T000000Z-bbbbbb-1-screenshot.png");
  fs.writeFileSync(recent, "recent");
  const passed = stub(["--scenario", passing, "--capture", "screenshot,trace", "--json"]);
  assert.equal(passed.status, 0, "a passing run exits 0");
  const result = JSON.parse(passed.stdout);
  assert.equal(result.status, "passed");
  assert.deepEqual(result.artifacts.map((artifact) => artifact.type), ["screenshot", "trace"]);
  for (const artifact of result.artifacts) {
    assert.equal(path.dirname(artifact.path), evidenceDir, "artifacts live in the evidence store");
    assert.match(path.basename(artifact.path), new RegExp(`^${result.runId}-\\d+-${artifact.type}\\.`), "artifact names are flat and per-run");
    assert.ok(fs.existsSync(artifact.path), "every reported artifact exists");
  }
  assert.ok(!fs.existsSync(stale), "evidence past its age bound is pruned when a run starts");
  assert.ok(fs.existsSync(recent), "evidence within its age bound is kept");

  // A scenario the provider cannot even load is a blocked result, not a stack trace.
  const broken = stub(["--scenario", writeRaw("broken.json", "{"), "--json"]);
  assert.equal(broken.status, 1);
  assert.equal(JSON.parse(broken.stdout).status, "blocked", "a provider failure is reported as blocked");

  const failed = stub(["--scenario", failing, "--json"]);
  assert.equal(failed.status, 1, "a non-passing run exits 1");
  assert.equal(JSON.parse(failed.stdout).status, "failed");

  // ---- `browser run` is never allowlisted for agents ----
  for (const file of [
    "manifests/inventory/agent-permissions.json",
    "generated/claude/settings.json",
    "generated/codex/config.toml",
    "generated/gemini/policies/generated-permissions.toml",
  ]) {
    const text = fs.readFileSync(path.join(repoRoot, file), "utf8");
    assert.ok(!/roborepo",\s*"browser"|roborepo browser/.test(text), `${file} does not allowlist roborepo browser`);
  }

  console.log("ok: browser CLI (gate, independence, lazy availability, evidence, failures, permissions)");
} finally {
  cli.cleanup();
}

function enabled() {
  return JSON.parse(fs.readFileSync(path.join(stateRoot, "enabled-packages.json"), "utf8")).packages.sort();
}

function writeJson(name, value) {
  return writeRaw(name, JSON.stringify(value));
}

function writeRaw(name, text) {
  const file = path.join(fixtures, name);
  fs.writeFileSync(file, text);
  return file;
}
