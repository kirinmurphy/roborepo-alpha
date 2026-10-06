#!/usr/bin/env node
import assert from "node:assert/strict";
import { configRoutes } from "../cli/portal-routes-config.mjs";
import { dispatchRoutes } from "../cli/portal-router.mjs";

function response() {
  return { status: null, body: null, writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
}

function request(body) {
  return { on(event, callback) { if (event === "data" && body) callback(JSON.stringify(body)); if (event === "end") callback(); } };
}

const handlers = {
  loadConfig: () => ({ machineHarnesses: [{ id: "codex", enabled: true }] }),
  refreshHarnesses: () => ({ detected: ["codex"], state: { providers: { codex: { evidence: [{ value: "/secret" }] } } } }),
  setHarnessEnabled(id, enabled) {
    if (id === "unknown") throw new Error("unsupported harness: unknown");
    return { id, enabled };
  },
};

let res = response();
dispatchRoutes([configRoutes], { method: "POST", ...request({}) }, res, "/api/config/harnesses/refresh", "", handlers);
assert.equal(res.status, 200);
const refreshed = JSON.parse(res.body);
assert.deepEqual(refreshed.detected, ["codex"]);
assert.equal(res.body.includes("/secret"), false, "refresh route must not return discovery evidence");

res = response();
dispatchRoutes([configRoutes], { method: "POST", ...request({ enabled: false }) }, res, "/api/config/harnesses/codex/enabled", "", handlers);
assert.equal(res.status, 200);
assert.equal(JSON.parse(res.body).config.machineHarnesses[0].id, "codex");

res = response();
dispatchRoutes([configRoutes], { method: "POST", ...request({ enabled: true }) }, res, "/api/config/harnesses/unknown/enabled", "", handlers);
assert.equal(res.status, 400);
assert.match(JSON.parse(res.body).error, /unsupported harness/);

console.log("portal harness API checks passed");
