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
  loadHookReadiness: async (harness) => {
    if (harness === "unknown") throw new Error("unsupported harness: unknown");
    if (harness === "claude") throw new Error("hook file unreadable");
    return { harness, state: "review_required", groups: [] };
  },
  refreshHarnesses: () => ({ detected: ["codex"], state: { providers: { codex: { evidence: [{ value: "/secret" }] } } } }),
  setHarnessEnabled(id, enabled) {
    if (id === "unknown") throw new Error("unsupported harness: unknown");
    return { id, enabled };
  },
};

let res = response();
dispatchRoutes([configRoutes], { method: "POST", ...request({}) }, res, "/api/config/harnesses/refresh", "", handlers);
await new Promise(setImmediate);
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

res = response();
dispatchRoutes([configRoutes], { method: "GET" }, res, "/api/config/hooks/codex/status", "", handlers);
await new Promise(setImmediate);
assert.equal(res.status, 200);
assert.deepEqual(JSON.parse(res.body), { harness: "codex", state: "review_required", groups: [] });

res = response();
dispatchRoutes([configRoutes], { method: "GET" }, res, "/api/config/hooks/unknown/status", "", handlers);
await new Promise(setImmediate);
assert.equal(res.status, 404, "an unregistered harness has no hook readiness");

res = response();
dispatchRoutes([configRoutes], { method: "GET" }, res, "/api/config/hooks/claude/status", "", handlers);
await new Promise(setImmediate);
assert.equal(res.status, 200);
assert.deepEqual(JSON.parse(res.body), { harness: "claude", state: "unknown", groups: [] }, "a failed read reports unknown, never an error page");

// Package and skill toggles: a disable that selected packages block answers 409 with the packages
// that include it; `cascade` reaches the package mutation only, and must be a boolean.
const toggleCalls = [];
const toggleHandlers = {
  loadConfig: () => ({ ok: "config" }),
  mutatePackage: async (id, enabled, options) => {
    toggleCalls.push({ route: "packages", id, enabled, options });
    if (!options.cascade && id === "leaf") {
      return { ok: false, message: "cannot disable leaf", includedBy: [{ id: "parent", label: "Parent" }] };
    }
    return { ok: true, message: `disabled: ${id}` };
  },
  mutateSkill: async (id, enabled, options) => {
    toggleCalls.push({ route: "skills", id, enabled, options });
    return { ok: true, message: `unlinked: ${id}` };
  },
};
async function toggle(path, body) {
  const out = response();
  dispatchRoutes([configRoutes], { method: "POST", ...request(body) }, out, path, "", toggleHandlers);
  for (let i = 0; i < 5 && out.status === null; i++) await new Promise(setImmediate);
  return { status: out.status, body: JSON.parse(out.body) };
}
let toggled = await toggle("/api/config/packages", { id: "leaf", enabled: false });
assert.equal(toggled.status, 409, "a disable that selected packages block is a conflict");
assert.equal(toggled.body.error.code, "INCLUDED_IN_SELECTED");
assert.deepEqual(toggled.body.error.details.includedBy, [{ id: "parent", label: "Parent" }]);
assert.deepEqual(toggled.body.config, { ok: "config" }, "the conflict still returns the fresh snapshot");
toggled = await toggle("/api/config/packages", { id: "leaf", enabled: false, cascade: true });
assert.equal(toggled.status, 200, "cascade lets the disable through");
assert.deepEqual(toggleCalls.at(-1), { route: "packages", id: "leaf", enabled: false, options: { cascade: true } });
toggled = await toggle("/api/config/packages", { id: "leaf", enabled: false, cascade: "yes" });
assert.equal(toggled.status, 400, "cascade must be a boolean");
toggled = await toggle("/api/config/skills", { id: "some-skill", enabled: false, cascade: true });
assert.equal(toggled.status, 200);
assert.deepEqual(toggleCalls.at(-1), { route: "skills", id: "some-skill", enabled: false, options: undefined },
  "cascade never reaches a skill toggle");

console.log("portal harness API checks passed");
