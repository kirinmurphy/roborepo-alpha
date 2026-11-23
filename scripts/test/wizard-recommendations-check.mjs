#!/usr/bin/env node
// The setup wizard never prompts about recommended packages: after it applies the user's toggles it
// prints one line naming the selected packages' recommendations that are still off. This drives the
// wizard's deferred applier (applyWizardChanges) with a plan-suite toggle in a temporary home, then
// checks the printed line and that nothing outside plan-suite's required closure was enabled.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);

if (process.env.WIZARD_RECOMMENDATIONS_CHILD) {
  // Imported only here, so the module-level state roots resolve against the temporary HOME.
  const { applyWizardChanges } = await import("../cli/presets.mjs");
  const step = (id) => ({
    title: "Development Workflows",
    items: [{ label: id, active: true, wasActive: false, toggleable: true, section: { category: "Development Workflows" }, item: { id, toggle: "package" } }],
  });
  // A recommendation the wizard turns off after enabling its parent is still named as off.
  const steps = [step("plan-suite")];
  if (process.env.WIZARD_DISABLE_AFTER) {
    steps.push({
      title: "Code Conventions",
      items: [{ label: "javascript-typescript", active: false, wasActive: true, toggleable: true, section: { category: "Code Conventions" }, item: { id: "javascript-typescript", toggle: "package" } }],
    });
  }
  const result = await applyWizardChanges(steps);
  console.log(`RESULT ${JSON.stringify(result)}`);
} else {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-wizard-recommendations-"));
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}");
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), "");
  const env = { ...process.env, HOME: home, ROBOREPO_STATE_ROOT: path.join(home, ".roborepo"), SKIP_MCP: "1", WIZARD_RECOMMENDATIONS_CHILD: "1" };
  try {
    // javascript-typescript starts on, so plan-suite's enable result leaves it out; the wizard then turns it off.
    const seed = spawnSync(process.execPath, [path.join(path.dirname(self), "../cli/main.mjs"), "package", "enable", "javascript-typescript"], { env: { ...env, WIZARD_RECOMMENDATIONS_CHILD: "" }, encoding: "utf8" });
    assert.equal(seed.status, 0, `seed enable should succeed\n${seed.stderr}`);
    const run = spawnSync(process.execPath, [self], { env: { ...env, WIZARD_DISABLE_AFTER: "1" }, encoding: "utf8" });
    assert.equal(run.status, 0, `wizard apply should succeed\n${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /enable plan-suite — ok/, "the plan-suite toggle applies");

    const lines = run.stdout.split("\n").filter((line) => line.startsWith("recommended (not enabled):"));
    assert.equal(lines.length, 1, `exactly one recommendation line\n${run.stdout}`);
    const named = lines[0].replace("recommended (not enabled): ", "").split(" — ")[0].split(", ");
    assert.deepEqual(named.sort(), ["feature-verification", "javascript-typescript"], "names plan-suite's recommendations that are off");
    assert.match(lines[0], /roborepo package enable <id>/, "names the command that enables one");

    const registry = JSON.parse(fs.readFileSync(path.join(home, ".roborepo", "enabled-packages.json"), "utf8"));
    assert.deepEqual(registry.packages, ["plan-suite"], "only the selected package is recorded as a root");
    assert.ok(registry.disabled.includes("javascript-typescript"), "the wizard's disable of javascript-typescript applied");
    const applied = JSON.parse(fs.readFileSync(path.join(home, ".roborepo", "applied-packages.json"), "utf8"));
    const appliedIds = (applied.packages || applied).slice().sort();
    assert.deepEqual(appliedIds, ["code-style", "implementation-review", "plan-suite", "technical-writing", "test-harness"], "applies plan-suite and its requirements, and no recommendation");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
  console.log("ok: setup wizard names recommendations still off and enables none of them");
}
