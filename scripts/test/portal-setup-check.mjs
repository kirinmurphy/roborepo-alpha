#!/usr/bin/env node
import assert from "node:assert/strict";
import { buildSetupState, loadSetupState } from "../cli/portal-setup.mjs";
import { defaultRegistry, hideRepository, upsertRepository } from "../../modules/repositories/index.mjs";
import { defaultSources } from "../../modules/repositories/index.mjs";

const registry = defaultRegistry();
upsertRepository(registry, { id: "git:github.com/acme/visible", kind: "git", displayName: "Visible" });
upsertRepository(registry, { id: "git:github.com/acme/hidden", kind: "git", displayName: "Hidden" });
upsertRepository(registry, { id: "git:github.com/example/demo-fixture", kind: "git", displayName: "Fixture" });
hideRepository(registry, "git:github.com/acme/hidden", { hidden: true });

const sources = defaultSources();
sources.sources.push({
  id: "src-abc123",
  kind: "directory",
  path: "/Users/alice/private/projects",
  enabled: true,
  createdAt: new Date(0).toISOString(),
  status: { state: "healthy", refreshedAt: new Date(0).toISOString(), repositoryCount: 1, message: null },
});

const setup = buildSetupState({
  registry,
  sources,
  supported: [{ id: "codex", displayName: "Codex" }, { id: "claude", displayName: "Claude Code" }],
  detected: [
    { id: "codex", displayName: "Codex", confidence: "confirmed", enabled: true },
    { id: "claude", displayName: "Claude Code", confidence: "confirmed", enabled: false },
  ],
  telemetry: { enabled: true },
});

assert.deepEqual(setup.repositories, {
  knownCount: 2,
  visibleCount: 1,
  autoDiscoveryEnabled: false,
  hasConfiguredSources: true,
});
assert.deepEqual(setup.harnesses.active, [{ id: "codex", displayName: "Codex", confidence: "confirmed", enabled: true }]);
assert.equal(setup.telemetry.captureAvailable, true);
assert.equal(JSON.stringify(setup).includes("/Users/alice"), false, "setup state must not leak source paths");
assert.equal(JSON.stringify(setup).includes("private/projects"), false, "setup state must be recursively path-free");

const injected = loadSetupState({
  loadRepositories: () => ({ registry: defaultRegistry(), sources: defaultSources() }),
  loadHarnesses: () => ({ supported: [{ id: "gemini", displayName: "Gemini CLI" }], detected: [] }),
  loadTelemetry: () => ({ enabled: false }),
});
assert.equal(injected.harnesses.supported[0].id, "gemini");
assert.equal(injected.telemetry.captureAvailable, false);
console.log("portal setup-state checks passed");
