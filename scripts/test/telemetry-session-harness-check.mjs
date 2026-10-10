#!/usr/bin/env node
import assert from "node:assert/strict";
import { telemetryRoutes } from "../cli/portal-routes-telemetry.mjs";
import { dispatchRoutes } from "../cli/portal-router.mjs";

// /api/session must reject a missing
// or unrecognized harness id instead of silently defaulting to Claude. Fakes just enough of
// req/res for send()'s writeHead/end contract — no real HTTP socket needed.

testMissingHarnessRejected();
testUnknownHarnessRejected();
testKnownHarnessReachesLoadSession();
console.log("telemetry session harness checks passed");

function fakeRes() {
  const res = { status: null, body: null };
  res.writeHead = (status) => { res.status = status; };
  res.end = (body) => { res.body = body; };
  return res;
}

function testMissingHarnessRejected() {
  const res = fakeRes();
  let called = false;
  dispatchRoutes([telemetryRoutes], { method: "GET" }, res, "/api/session", "id=abc123", { loadSession: () => { called = true; } });
  assert.equal(res.status, 400);
  assert.match(JSON.parse(res.body).error, /missing or unknown harness/);
  assert.equal(called, false, "loadSession must not run when harness is missing");
}

function testUnknownHarnessRejected() {
  const res = fakeRes();
  let called = false;
  dispatchRoutes([telemetryRoutes], { method: "GET" }, res, "/api/session", "id=abc123&harness=timetravel", { loadSession: () => { called = true; } });
  assert.equal(res.status, 400);
  assert.match(JSON.parse(res.body).error, /missing or unknown harness: timetravel/);
  assert.equal(called, false, "loadSession must not run for an unrecognized harness id");
}

function testKnownHarnessReachesLoadSession() {
  const res = fakeRes();
  let receivedHarness = null;
  dispatchRoutes([telemetryRoutes], { method: "GET" }, res, "/api/session", "id=abc123&harness=codex", {
    loadSession: (req) => { receivedHarness = req.harness; return { found: false }; },
  });
  assert.equal(res.status, 200);
  assert.equal(receivedHarness, "codex");
}
