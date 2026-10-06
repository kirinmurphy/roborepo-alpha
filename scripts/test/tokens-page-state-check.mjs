#!/usr/bin/env node
import assert from "node:assert/strict";
import { pageState } from "../../portal/tokens/page-state.js";

// Strict cascade: the shown state is the FIRST failing rung (see page-state.js).
assert.equal(pageState({ telemetryOn: false, activeHarnessCount: 0, hasData: false }), "no-harness");
assert.equal(pageState({ telemetryOn: false, activeHarnessCount: 0, hasData: true }), "no-harness",
  "no harness wins over telemetry and stale data");
assert.equal(pageState({ telemetryOn: true, activeHarnessCount: 0, hasData: false }), "no-harness");
assert.equal(pageState({ telemetryOn: true, activeHarnessCount: 0, hasData: true }), "no-harness",
  "no-harness wins over stale data (harness removed, spool not yet trimmed)");
assert.equal(pageState({ telemetryOn: false, activeHarnessCount: 2, hasData: true }), "telemetry-off",
  "telemetry off follows the harness prerequisite");
assert.equal(pageState({ telemetryOn: true, activeHarnessCount: 1, hasData: false }), "no-data");
assert.equal(pageState({ telemetryOn: true, activeHarnessCount: 3, hasData: true }), "full");
console.log("tokens page state checks passed");
