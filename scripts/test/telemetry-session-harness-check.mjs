#!/usr/bin/env node
import assert from "node:assert/strict";
import { telemetryRoutes } from "../cli/portal-routes-telemetry.mjs";
import { dispatchRoutes } from "../cli/portal-router.mjs";
import { fakeResponse } from "./lib/fake-response.mjs";

// Phase 6 of discoverable-harness-provider-architecture-plan.md: /api/session must reject a missing
// or unrecognized harness id instead of silently defaulting to Claude. Fakes just enough of
// req/res for send()'s writeHead/end contract — no real HTTP socket needed.

testMissingHarnessRejected();
testUnknownHarnessRejected();
testKnownHarnessReachesLoadSession();
console.log("telemetry session harness checks passed");

function testMissingHarnessRejected() {
  const res = fakeResponse();
  let called = false;
  dispatchRoutes([telemetryRoutes], { method: "GET" }, res, "/api/session", "id=abc123", { loadSession: () => { called = true; } });
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /missing or unknown harness/);
  assert.equal(called, false, "loadSession must not run when harness is missing");
}

function testUnknownHarnessRejected() {
  const res = fakeResponse();
  let called = false;
  dispatchRoutes([telemetryRoutes], { method: "GET" }, res, "/api/session", "id=abc123&harness=timetravel", { loadSession: () => { called = true; } });
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /missing or unknown harness: timetravel/);
  assert.equal(called, false, "loadSession must not run for an unrecognized harness id");
}

function testKnownHarnessReachesLoadSession() {
  const res = fakeResponse();
  let receivedHarness = null;
  dispatchRoutes([telemetryRoutes], { method: "GET" }, res, "/api/session", "id=abc123&harness=codex", {
    loadSession: (req) => { receivedHarness = req.harness; return { found: false }; },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(receivedHarness, "codex");
}
