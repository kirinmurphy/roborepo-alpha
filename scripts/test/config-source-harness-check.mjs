#!/usr/bin/env node
import assert from "node:assert/strict";
import { configRoutes } from "../cli/portal-routes-config.mjs";
import { dispatchRoutes } from "../cli/portal-router.mjs";
import { loadConfigSource, readConfigSnapshot } from "../cli/config.mjs";
import { fakeResponse } from "./lib/fake-response.mjs";

// Phase 7 of discoverable-harness-provider-architecture-plan.md: /api/config/source must reject a
// missing or unrecognized harness id for harness-scoped kinds (live-rules, harness-hooks,
// globals-rules, command, command-skill) instead of silently defaulting to Claude — same fix
// telemetry's /api/session got in Phase 6. Kinds that resolve the harness from `id` itself
// (config-file, skill) must keep working with no harness param at all.

testMissingHarnessRejectedForScopedKind();
testUnknownHarnessRejectedForScopedKind();
testKnownHarnessReachesLoadConfigSource();
testConfigFileKindIgnoresMissingHarness();
testSnapshotHarnessesListMatchesRegistry();
console.log("config source harness checks passed");

function testMissingHarnessRejectedForScopedKind() {
  const result = loadConfigSource({ kind: "live-rules", id: "agent-rules", harness: null });
  assert.equal(result.ok, false);
  assert.match(result.error, /missing or unknown harness/);
}

function testUnknownHarnessRejectedForScopedKind() {
  const result = loadConfigSource({ kind: "harness-hooks", id: "hooks", harness: "timetravel" });
  assert.equal(result.ok, false);
  assert.match(result.error, /missing or unknown harness: timetravel/);
}

// A registered harness id must get PAST the harness-id gate. It may still fail further in for an
// environment reason — live-rules reads ~/.codex/AGENTS.md, which exists on a developer machine
// with an installed harness but never on a bare CI runner. Asserting ok===true here would couple
// this id-validation test to harness installation; assert only that the id was accepted.
function testKnownHarnessReachesLoadConfigSource() {
  const result = loadConfigSource({ kind: "live-rules", id: "agent-rules", harness: "codex" });
  if (!result.ok) {
    assert.doesNotMatch(result.error, /missing or unknown harness/, "registered harness id must pass the id gate");
  }
}

// config-file resolves its harness from `id`, so omitting the harness param must never trip the
// harness-id gate. Like live-rules above, the read itself targets a real home-dir file
// (~/.claude/settings.json) that a bare CI runner does not have — so assert the request was not
// rejected FOR A HARNESS REASON rather than asserting the file was readable.
function testConfigFileKindIgnoresMissingHarness() {
  const res = fakeResponse();
  dispatchRoutes([configRoutes], { method: "GET" }, res, "/api/config/source", "kind=config-file&id=claude-settings", { loadConfigSource });
  const body = JSON.parse(res.body);
  if (!body.ok) {
    assert.doesNotMatch(body.error, /missing or unknown harness/, "config-file kind must not require a harness param");
  }
}

// Grid/defaults-menu column count must track whatever the registry actually has registered, not a
// hardcoded two — this is the one/two/synthetic-three-provider Config UI check's server-side half.
function testSnapshotHarnessesListMatchesRegistry() {
  const snap = readConfigSnapshot();
  assert.ok(Array.isArray(snap.harnesses));
  assert.ok(snap.harnesses.length >= 2, "expected at least claude+codex registered in this repo");
  for (const harness of snap.harnesses) {
    assert.equal(typeof harness.id, "string");
    assert.equal(typeof harness.displayName, "string");
    assert.equal(typeof harness.rulesFile, "string");
    assert.equal(typeof harness.settingsFile, "string");
    assert.equal(typeof harness.hooksFile, "string");
  }
}
