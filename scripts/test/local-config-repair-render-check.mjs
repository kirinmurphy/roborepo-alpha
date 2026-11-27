#!/usr/bin/env node
// The local-config repair compares against what `roborepo update` would leave in place, so the
// permission rules the render owns never read as lost settings. With the GitHub agent identity on,
// the render lifts `gh api` and the posting commands out of deny/ask; an older backup and the
// identity-off generated baseline still carry them, and the repair must not propose putting them
// back. A setting only the backup has is still recovered.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Paths resolve the home and state root when the CLI modules load, so both are isolated first.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-local-config-repair-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
const home = path.join(tmp, "home");
process.env.HOME = home;
process.env.ROBOREPO_STATE_ROOT = path.join(tmp, "state");
fs.mkdirSync(path.join(home, ".claude"), { recursive: true });

const { renderPermissionsTo, loadPermissionManifest } = await import("../cli/permissions-render.mjs");
const { buildLocalConfigRepairPlans } = await import("../cli/local-config-repair.mjs");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const baselineText = fs.readFileSync(path.join(repoRoot, "generated", "claude", "settings.json"), "utf8");
const settingsPath = path.join(home, ".claude", "settings.json");
const backupPath = path.join(home, ".claude", "settings_original_20990101-000000.json");
const manifest = loadPermissionManifest();

// The installed settings as update leaves them: the generated baseline, then the permission render.
function installActive(agentIdentity) {
  fs.writeFileSync(settingsPath, baselineText);
  renderPermissionsTo(home, { manifest, agentIdentity });
  return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
}

// A backup newer than the baseline, so the repair does not skip it as stale.
function writeBackup(settings) {
  fs.writeFileSync(backupPath, `${JSON.stringify(settings, null, 2)}\n`);
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(backupPath, future, future);
}

const claudePlan = (agentIdentity) => buildLocalConfigRepairPlans({ agentIdentity }).find((plan) => plan.harness === "claude");

// Identity on, nothing lost: the lifted rules are not a repair candidate.
{
  const active = installActive(true);
  assert.ok(active.permissions.allow.includes("Bash(gh api:*)"), "precondition: identity render allows gh api");
  assert.ok(!active.permissions.deny.includes("Bash(gh api:*)"), "precondition: identity render does not deny gh api");
  writeBackup(active);
  const plan = claudePlan(true);
  assert.equal(plan, undefined, `identity on: no repair proposed, got ${JSON.stringify(plan?.keyDiff)}`);
}

// Identity on, the backup predates the identity (identity-off permissions) and holds one setting the
// active file lost: only that setting is proposed, and the repaired file keeps the lifted rules.
{
  const offRender = installActive(false);
  installActive(true);
  writeBackup({ ...offRender, userOnlySetting: "keep-me" });
  const plan = claudePlan(true);
  assert.ok(plan, "identity on: the lost setting is still recovered");
  const keys = [...plan.keyDiff.added, ...plan.keyDiff.changed].map((entry) => entry.key);
  assert.deepEqual(keys, ["userOnlySetting"], `only the lost setting is proposed, got ${keys.join(", ")}`);
  const repaired = JSON.parse(plan.repaired);
  assert.equal(repaired.userOnlySetting, "keep-me");
  assert.ok(repaired.permissions.allow.includes("Bash(gh api:*)"), "repair keeps gh api allowed");
  assert.ok(!repaired.permissions.deny.includes("Bash(gh api:*)"), "repair does not restore the gh api deny");
  assert.ok(!(repaired.permissions.ask ?? []).some((rule) => rule.startsWith("Bash(gh pr comment")), "repair does not restore the gh pr comment ask");
}

// Identity off, nothing lost: still quiet.
{
  writeBackup(installActive(false));
  assert.equal(claudePlan(false), undefined, "identity off: no repair proposed");
}

console.log("ok: local-config repair ignores rules the permission render owns");
