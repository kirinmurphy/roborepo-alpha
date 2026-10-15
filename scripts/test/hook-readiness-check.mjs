#!/usr/bin/env node
// Hook readiness end to end below the CLI: the Codex hooks.read adapter against a fake app-server
// that answers `hooks/list` in the shape Codex 0.155 returns, the Claude hooks.read against a
// settings file, and the shared comparison over core hooks plus enabled packages' hooks resources.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getHarnessProvider } from "../harnesses/registry.mjs";
import { codexHookRecord } from "../harnesses/codex/hooks-read.mjs";
import { compareHookReadiness, readHookReadiness, readinessSupported } from "../harnesses/hook-readiness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeServer = path.join(here, "fixtures", "hook-readiness", "fake-codex-app-server.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-hook-readiness-"));
const hooksPath = path.join(tmp, ".codex", "hooks.json");
const hooksListFile = path.join(tmp, "hooks-list.json");

// `codex` stand-in: the adapter spawns `<executable> --no-daemon app-server --stdio`.
const executable = path.join(tmp, "codex");
fs.writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "${fakeServer}" "$@"\n`, { mode: 0o755 });

const telemetryCommand = (event) => `roborepo telemetry capture --harness codex --event ${event}`;
const observerCommand = 'node "$HOME/.codex/hooks/skill-reference-observer.mjs"';
const fixturePackages = [
  fixturePackage("token-telemetry-fixture", "Token telemetry fixture", {
    SessionStart: [group(telemetryCommand("SessionStart"))],
    PostToolUse: [group(telemetryCommand("PostToolUse"))],
  }),
  fixturePackage("observer-fixture", "Observer fixture", { PostToolUse: [group(observerCommand)] }),
];
const coreHooks = Object.entries(getHarnessProvider("codex").adapters.hooks.core())
  .flatMap(([event, groups]) => groups.flatMap((g) => g.hooks.map((h) => ({ event, command: h.command }))));

// One `hooks/list` record with every field Codex 0.155 reports, so the fixture pins the real shape.
function liveRecord({ event, command }, overrides = {}) {
  const eventName = event.charAt(0).toLowerCase() + event.slice(1);
  return {
    key: `${hooksPath}:${eventName}:0:0`, eventName, handlerType: "command", command, async: false,
    matcher: "", timeoutSec: 600, statusMessage: null, additionalContextLimit: null,
    sourcePath: hooksPath, source: "user", pluginId: null, displayOrder: 0, enabled: true,
    isManaged: false, currentHash: "sha256:fixture", trustStatus: "trusted", ...overrides,
  };
}

const allExpected = [
  ...coreHooks,
  { event: "SessionStart", command: telemetryCommand("SessionStart") },
  { event: "PostToolUse", command: telemetryCommand("PostToolUse") },
  { event: "PostToolUse", command: observerCommand },
];

async function codexReadiness(records, { mode = "respond", readOptions = {} } = {}) {
  fs.writeFileSync(hooksListFile, JSON.stringify(records));
  process.env.FAKE_CODEX_HOOKS_FILE = hooksListFile;
  process.env.FAKE_CODEX_MODE = mode;
  return readHookReadiness("codex", {
    packages: fixturePackages, repoRoot: tmp, hooksPath, cwd: tmp,
    readOptions: { executable, timeoutMs: 3000, ...readOptions },
  });
}

const groupState = (result, owner) => result.groups.find((g) => g.owner === owner)?.state;

try {
  // --- record mapping: camelCase events, managed hooks, unrecognized trust ---
  {
    const base = liveRecord({ event: "PostToolUse", command: observerCommand });
    assert.deepEqual(codexHookRecord(base), {
      event: "PostToolUse", command: observerCommand, sourcePath: hooksPath, trust: "trusted", enabled: true,
    });
    assert.equal(codexHookRecord({ ...base, isManaged: true, trustStatus: "untrusted" }).trust, "managed");
    assert.equal(codexHookRecord({ ...base, trustStatus: "something-new" }).trust, "unknown");
  }

  // --- active: core hooks and every package hook trusted and enabled ---
  {
    const result = await codexReadiness(allExpected.map((hook) => liveRecord(hook)));
    assert.equal(result.supported, true);
    assert.equal(result.state, "active");
    assert.deepEqual(result.groups.map((g) => g.owner), ["core", "token-telemetry-fixture", "observer-fixture"]);
    assert.ok(result.groups.every((g) => g.state === "active"));
  }

  // --- managed hooks count as active without a trust hash ---
  {
    const result = await codexReadiness(allExpected.map((hook) => liveRecord(hook, { isManaged: true, trustStatus: "untrusted" })));
    assert.equal(result.state, "active");
  }

  // --- review_required: a package other than telemetry, and only that package ---
  {
    const records = allExpected.map((hook) => liveRecord(hook, hook.command === observerCommand ? { trustStatus: "modified" } : {}));
    const result = await codexReadiness(records);
    assert.equal(result.state, "review_required");
    assert.equal(groupState(result, "observer-fixture"), "review_required");
    assert.equal(groupState(result, "token-telemetry-fixture"), "active");
    assert.equal(groupState(result, "core"), "active");
  }

  // --- untrusted counts as review_required the same way ---
  {
    const records = allExpected.map((hook) => liveRecord(hook, hook.command === telemetryCommand("PostToolUse") ? { trustStatus: "untrusted" } : {}));
    const result = await codexReadiness(records);
    const hook = result.groups.find((g) => g.owner === "token-telemetry-fixture").hooks.find((h) => h.event === "PostToolUse");
    assert.equal(hook.state, "review_required");
    assert.equal(hook.trust, "untrusted");
  }

  // --- inactive: trusted but disabled in Codex ---
  {
    const records = allExpected.map((hook) => liveRecord(hook, hook.command === telemetryCommand("SessionStart") ? { enabled: false } : {}));
    const result = await codexReadiness(records);
    assert.equal(result.state, "inactive");
    assert.equal(groupState(result, "token-telemetry-fixture"), "inactive");
  }

  // --- missing: the core hooks absent from the hook file ---
  {
    const records = allExpected.filter((hook) => !coreHooks.includes(hook)).map((hook) => liveRecord(hook));
    const result = await codexReadiness(records);
    assert.equal(result.state, "missing");
    assert.equal(groupState(result, "core"), "missing");
    assert.equal(groupState(result, "observer-fixture"), "active");
  }

  // --- another sourcePath never satisfies an expected hook ---
  {
    const projectHooks = path.join(tmp, "project", ".codex", "hooks.json");
    const records = allExpected.map((hook) => liveRecord(hook, hook.command === observerCommand ? { sourcePath: projectHooks } : {}));
    const result = await codexReadiness(records);
    assert.equal(groupState(result, "observer-fixture"), "missing");
  }

  // --- unknown: the runtime times out, is too old for hooks/list, or is absent. The installed
  // entries still come from hooks.json, so an absent hook is still reported missing. ---
  {
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
    const installed = allExpected.filter((hook) => !coreHooks.includes(hook));
    const fileHooks = {};
    for (const hook of installed) (fileHooks[hook.event] ||= []).push(group(hook.command));
    fs.writeFileSync(hooksPath, JSON.stringify({ hooks: fileHooks }));

    const started = Date.now();
    const timedOut = await codexReadiness([], { mode: "silent", readOptions: { timeoutMs: 300 } });
    assert.ok(Date.now() - started < 2500, "a silent runtime is abandoned at the timeout");
    assert.equal(groupState(timedOut, "token-telemetry-fixture"), "unknown");
    assert.equal(groupState(timedOut, "core"), "missing");

    const tooOld = await codexReadiness([], { mode: "no-method" });
    assert.equal(groupState(tooOld, "observer-fixture"), "unknown");

    const absent = await codexReadiness([], { readOptions: { executable: null } });
    assert.equal(groupState(absent, "observer-fixture"), "unknown");
  }

  // --- Claude: installed means active; trust is not required ---
  {
    const settingsPath = path.join(tmp, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const coreFragment = getHarnessProvider("claude").adapters.hooks.core();
    fs.writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: [] }, hooks: coreFragment }));
    const records = await getHarnessProvider("claude").adapters.hooks.read({ hooksPath: settingsPath });
    assert.ok(records.length > 0);
    assert.ok(records.every((record) => record.trust === "not-required" && record.sourcePath === settingsPath));
    const result = await readHookReadiness("claude", { packages: [], repoRoot: tmp, hooksPath: settingsPath });
    assert.equal(result.state, "active");
    assert.equal(groupState(result, "core"), "active");
  }

  // --- Gemini keeps its hooks.read stub, and readiness skips it ---
  {
    assert.equal(readinessSupported("gemini"), false);
    const result = await readHookReadiness("gemini", { packages: [], repoRoot: tmp });
    assert.equal(result.supported, false);
    assert.deepEqual(result.groups, []);
  }

  // --- comparison: a group with nothing expected is dropped, worst state wins ---
  {
    const result = compareHookReadiness([
      { owner: "a", label: "A", hooks: [{ event: "Stop", command: "x" }, { event: "Stop", command: "y" }] },
    ], [
      { event: "Stop", command: "x", sourcePath: null, trust: "unknown", enabled: true },
      { event: "Stop", command: "y", sourcePath: null, trust: "modified", enabled: false },
    ]);
    assert.equal(result.state, "review_required");
  }

  console.log("ok: hook readiness reports every state for core and package hooks across providers");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

function group(command) {
  return { matcher: "", hooks: [{ type: "command", command }] };
}

function fixturePackage(id, label, fragment) {
  const source = `${id}-hooks-codex.json`;
  fs.writeFileSync(path.join(tmp, source), JSON.stringify(fragment));
  return { id, label, components: [{ type: "hooks", harness: "codex", source }] };
}
