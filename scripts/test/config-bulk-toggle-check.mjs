#!/usr/bin/env node
// Section-level bulk toggle (portal bulkToggle sections): one POST applies a section's packages
// as a unit — preflighted sequential mutations, exactly one reconcile pass, fresh snapshot back.
// Covers enable-all from off, disable-all, no-op diffing (no-change ids skipped), mixed->enable,
// the in-flight lock (409, deterministic same-tick invocation), 400 validation, that the
// individual toggle path keeps working beside the batch endpoint, and that dependency-only
// packages are skipped while every changed member returns per-package outcomes.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startHermeticPortal } from "./lib/portal-cleanup.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repoRoot, "scripts/cli/main.mjs");

// The packages the Plans onboarding banner enables in one request: plan-suite and session-close,
// the members of the Development Workflows section. That section has no Select All switch, so the
// banner is the endpoint's caller; the endpoint itself takes any package ids. Cheap skill-only
// packages — fast to enable/disable, no MCP/service side effects on a bare fixture HOME.
const SECTION_IDS = ["plan-suite", "session-close"];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-config-bulk-"));
const home = tmp;
fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}");
fs.writeFileSync(path.join(home, ".codex", "config.toml"), "");
const env = {
  ...process.env,
  HOME: home,
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
const pageHtml = await (await fetch(`${base}/agents`)).text();
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
  assert.equal(section.bulkToggle, false, "Development Workflows ships no Select All switch");
  assert.deepEqual(section.items.map((item) => item.id).sort(), [...SECTION_IDS].sort(),
    "the Development Workflows section holds exactly the onboarding banner's packages");
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
  runNode([cli, "package", "disable", "plan-suite"], "individual disable of one member");
  ({ byId } = await snapshotSection());
  assert.equal(byId.get("plan-suite"), false, "plan-suite off after individual toggle");
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
    body: JSON.stringify({ ids: "plan-suite", enabled: true }),
  });
  assert.equal(bad.status, 400, "malformed body rejected");

  // ── individual endpoint still works beside the batch one ──
  runNode([cli, "package", "enable", "plan-suite"], "individual enable still works");
  ({ byId } = await snapshotSection());
  assert.equal(byId.get("plan-suite"), true, "individual toggle path unaffected by bulk endpoint");

  // ── in-flight lock, deterministic: two same-tick invocations in-process. The first sets the
  // module flag synchronously before its first await, so the second must get 409. Runs under the
  // fixture env (set before import) against the same fixture state dir.
  process.env.HOME = home;
  process.env.ROBOREPO_STATE_ROOT = path.join(home, ".roborepo");
  process.env.ROBOREPO_STATE_ROOT = path.join(home, ".roborepo");
  // Workspace fixtures for the dependency cases below: a selectable parent that requires a
  // dependency-only package. Set before the import, which resolves the workspace root once.
  const workspace = path.join(tmp, "workspace");
  process.env.ROBOREPO_WORKSPACE_ROOT = workspace;
  for (const [id, extra] of [
    ["bulk-parent", { requires: ["bulk-dep-only"] }],
    ["bulk-dep-only", { selectable: false, presentation: { category: "integrations", visibility: "dependency" } }],
    ["bulk-shared-parent", { requires: ["bulk-shared"] }],
    ["bulk-shared", {}],
  ]) {
    const dir = path.join(workspace, "packages", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "rules.md"), `## Bulk fixture ${id}\n`);
    fs.writeFileSync(path.join(dir, "package.config.json"), JSON.stringify({
      schemaVersion: 1, id, label: id, description: "Bulk dependency fixture", presentation: { category: "integrations" },
      resources: [{ type: "rules", harness: "claude", source: "rules.md" }], ...extra,
    }));
  }
  const bulk = await import(path.join(repoRoot, "scripts/cli/config-bulk.mjs"));
  // Start from all-off so the first batch has real work and stays in flight across the check.
  await bulk.applyBulkPackageChange(SECTION_IDS, false);
  const first = bulk.applyBulkPackageChange(SECTION_IDS, true); // NOT awaited
  const second = await bulk.applyBulkPackageChange(SECTION_IDS, true);
  assert.equal(second.status, 409, `overlapping batch must 409 (got ${second.status})`);
  assert.equal((await first).status, 200, "first batch completes once the lock frees");

  // ── dependency rows: a bulk switch acts on selectable packages only, and each changed member
  // carries the probed outcome of every package it applied.
  const on = await bulk.applyBulkPackageChange(["bulk-dep-only", "bulk-parent"], true);
  assert.equal(on.status, 200, `dependency batch enable: ${on.message}`);
  const onById = new Map(on.results.map((r) => [r.id, r]));
  assert.equal(onById.get("bulk-dep-only").skipped, true, "a dependency-only package is skipped by bulk enable");
  assert.equal(onById.get("bulk-dep-only").changed, false);
  assert.deepEqual(
    onById.get("bulk-parent").outcomes.map((o) => [o.id, o.outcome]),
    [["bulk-dep-only", "enabled"], ["bulk-parent", "enabled"]],
    "the parent's result lists one probed outcome per applied package, dependency first",
  );
  assert.ok(!registryIds().packages.has("bulk-dep-only"), "the dependency is never recorded as a root");
  const off = await bulk.applyBulkPackageChange(["bulk-dep-only", "bulk-parent"], false);
  const offById = new Map(off.results.map((r) => [r.id, r]));
  assert.equal(offById.get("bulk-dep-only").skipped, true, "a dependency-only package is skipped by bulk disable");
  assert.deepEqual(
    offById.get("bulk-parent").outcomes.map((o) => [o.id, o.outcome]).sort(),
    [["bulk-dep-only", "disabled"], ["bulk-parent", "disabled"]],
    "disabling the parent turns its dependency off with it",
  );

  // A selectable member that is on only because another member requires it has no root to remove:
  // bulk disable skips it instead of refusing the batch, and it turns off with its parent.
  const sharedOn = await bulk.applyBulkPackageChange(["bulk-shared-parent"], true);
  assert.equal(sharedOn.status, 200, `required-only fixture enable: ${sharedOn.message}`);
  assert.ok(!registryIds().packages.has("bulk-shared"), "the selectable dependency is not recorded as a root");
  const sharedOff = await bulk.applyBulkPackageChange(["bulk-shared", "bulk-shared-parent"], false);
  assert.equal(sharedOff.status, 200, `required-only batch disable: ${sharedOff.message}`);
  const sharedOffById = new Map(sharedOff.results.map((r) => [r.id, r]));
  assert.equal(sharedOffById.get("bulk-shared").skipped, true, "a required-only selectable member is skipped by bulk disable");
  assert.equal(sharedOffById.get("bulk-shared").message, "required by another selected package");
  assert.deepEqual(
    sharedOffById.get("bulk-shared-parent").outcomes.map((o) => [o.id, o.outcome]).sort(),
    [["bulk-shared", "disabled"], ["bulk-shared-parent", "disabled"]],
    "the required-only member turns off with its parent",
  );

  console.log("ok: section bulk toggle (enable/disable/no-op/mixed/lock/validation/individual coexistence/dependencies)");
} finally {
  stopServer();
  fs.rmSync(tmp, { recursive: true, force: true });
}
