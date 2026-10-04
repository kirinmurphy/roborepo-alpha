#!/usr/bin/env node
// Section-level bulk toggle (portal bulkToggle sections): one POST applies a section's packages
// as a unit — preflighted sequential mutations, exactly one reconcile pass, fresh snapshot back.
// Covers enable-all from off, disable-all, no-op diffing (no-change ids skipped), mixed->enable,
// the in-flight lock (409, deterministic same-tick invocation), 400 validation, and that the
// individual toggle path keeps working beside the batch endpoint.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startHermeticPortal } from "./lib/portal-cleanup.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repoRoot, "scripts/cli/main.mjs");

// Plan Suite section members (the manifest's bulkToggle: true section), which is also the list the
// Plans onboarding banner enables in one request. Cheap skill-only packages — fast to
// enable/disable, no MCP/service side effects on a bare fixture HOME.
const SECTION_IDS = ["plan-write", "plan-promote", "plan-start", "plan-close", "session-close"];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-config-bulk-"));
const home = tmp;
fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}");
fs.writeFileSync(path.join(home, ".codex", "config.toml"), "");
const env = {
  ...process.env,
  HOME: home,
  ROBOREPO_STATE_DIR: path.join(home, ".roborepo"),
  ROBOREPO_STATE_ROOT: path.join(home, ".roborepo"),
  SKIP_MCP: "1",
  ROBOREPO_PRESETS_ONBOARD: "skip",
};
for (const k of ["ROBOREPO_WORKSPACE_ROOT", "ROBOREPO_APP_ROOT"]) delete env[k];

function runNode(args, label) {
  const result = spawnSync(process.execPath, args, { env, cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, `${label} should succeed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

function registryIds() {
  const registryPath = path.join(home, ".roborepo", "enabled-packages.json");
  try {
    const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    return { packages: new Set(registry.packages || []), disabled: new Set(registry.disabled || []) };
  } catch {
    return { packages: new Set(), disabled: new Set() };
  }
}

// ── Hermetic portal boot (foreground child, stopped on every exit path) ──
const { port, stop: stopServer } = await startHermeticPortal({
  env,
  readyFile: path.join(tmp, "portal.ready"),
  logFile: path.join(tmp, "boot.log"),
});

const base = `http://127.0.0.1:${port}`;

// Mutations require the per-server token; it's embedded in every served page's HTML.
const pageHtml = await (await fetch(`${base}/config`)).text();
const token = pageHtml.match(/cli-portal-token" content="([^"]+)"/)?.[1];
assert.ok(token, "portal mutation token should be present in served HTML");

async function postBulk(ids, enabled) {
  const res = await fetch(`${base}/api/config/packages/bulk`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Cli-Portal-Token": token },
    body: JSON.stringify({ ids, enabled }),
  });
  return { status: res.status, body: await res.json() };
}

async function snapshotSection() {
  const snap = await (await fetch(`${base}/api/config`)).json();
  const section = (snap.behaviorView || []).find((s) => s.categoryId === "skills-dev-lifecycle");
  assert.ok(section, "skills-dev-lifecycle section should be in behaviorView");
  assert.equal(section.bulkToggle, true, "section should ship bulkToggle: true");
  assert.deepEqual(section.items.map((item) => item.id).sort(), [...SECTION_IDS].sort(),
    "the Plan Suite section holds exactly the five suite packages");
  const byId = new Map(section.items.map((item) => [item.id, item.active]));
  return { section, byId };
}

try {
  // ── enable-all from all-off ──
  let { byId } = await snapshotSection();
  for (const id of SECTION_IDS) assert.equal(byId.get(id), false, `${id} starts off in a fresh HOME`);

  let res = await postBulk(SECTION_IDS, true);
  assert.equal(res.status, 200, `bulk enable should succeed (status ${res.status}, ok=${res.body.ok})`);
  assert.equal(res.body.ok, true);
  byId = (await snapshotSection()).byId;
  for (const id of SECTION_IDS) assert.equal(byId.get(id), true, `${id} enabled by batch`);
  let reg = registryIds();
  for (const id of SECTION_IDS) assert.ok(reg.packages.has(id), `${id} in registry enabled set`);

  // ── no-op batch: every id already on -> all results "no change", still 200 ──
  res = await postBulk(SECTION_IDS, true);
  assert.equal(res.status, 200);
  assert.ok(res.body.results.every((r) => !r.changed), "no-op batch changes nothing");
  byId = (await snapshotSection()).byId;
  for (const id of SECTION_IDS) assert.equal(byId.get(id), true, `${id} still on after no-op batch`);

  // ── mixed -> enable-all: pre-disable one row individually, then batch-enable ──
  runNode([cli, "package", "disable", "plan-write"], "individual disable of one member");
  ({ byId } = await snapshotSection());
  assert.equal(byId.get("plan-write"), false, "plan-write off after individual toggle");
  assert.equal(byId.get("session-close"), true, "session-close untouched");

  res = await postBulk(SECTION_IDS, true);
  assert.equal(res.status, 200);
  byId = (await snapshotSection()).byId;
  for (const id of SECTION_IDS) assert.equal(byId.get(id), true, `${id} on after mixed->enable batch`);

  // ── disable-all ──
  res = await postBulk(SECTION_IDS, false);
  assert.equal(res.status, 200);
  byId = (await snapshotSection()).byId;
  for (const id of SECTION_IDS) assert.equal(byId.get(id), false, `${id} off after disable-all batch`);
  reg = registryIds();
  for (const id of SECTION_IDS) assert.ok(reg.disabled.has(id), `${id} recorded explicit-disabled`);

  // ── validation: bad body -> 400 ──
  const bad = await fetch(`${base}/api/config/packages/bulk`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Cli-Portal-Token": token },
    body: JSON.stringify({ ids: "plan-write", enabled: true }),
  });
  assert.equal(bad.status, 400, "malformed body rejected");

  // ── individual endpoint still works beside the batch one ──
  runNode([cli, "package", "enable", "plan-write"], "individual enable still works");
  ({ byId } = await snapshotSection());
  assert.equal(byId.get("plan-write"), true, "individual toggle path unaffected by bulk endpoint");

  // ── in-flight lock, deterministic: two same-tick invocations in-process. The first sets the
  // module flag synchronously before its first await, so the second must get 409. Runs under the
  // fixture env (set before import) against the same fixture state dir.
  process.env.HOME = home;
  process.env.ROBOREPO_STATE_DIR = path.join(home, ".roborepo");
  process.env.ROBOREPO_STATE_ROOT = path.join(home, ".roborepo");
  const bulk = await import(path.join(repoRoot, "scripts/cli/config-bulk.mjs"));
  // Start from all-off so the first batch has real work and stays in flight across the check.
  await bulk.applyBulkPackageChange(SECTION_IDS, false);
  const first = bulk.applyBulkPackageChange(SECTION_IDS, true); // NOT awaited
  const second = await bulk.applyBulkPackageChange(SECTION_IDS, true);
  assert.equal(second.status, 409, `overlapping batch must 409 (got ${second.status})`);
  assert.equal((await first).status, 200, "first batch completes once the lock frees");

  console.log("ok: section bulk toggle (enable/disable/no-op/mixed/lock/validation/individual coexistence)");
} finally {
  stopServer();
  fs.rmSync(tmp, { recursive: true, force: true });
}