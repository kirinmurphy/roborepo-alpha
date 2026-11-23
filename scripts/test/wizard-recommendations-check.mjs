#!/usr/bin/env node
// The setup wizard never prompts about recommended packages: after it applies the user's toggles it
// prints one line naming the selected packages' recommendations that are still off. This drives the
// wizard's deferred applier (applyWizardChanges) with a session-close toggle in a temporary home,
// then checks the printed line and that nothing outside session-close's included closure was enabled.
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
  const steps = [step("session-close")];
  if (process.env.WIZARD_DISABLE_AFTER) {
    steps.push({
      title: "Code Conventions",
      items: [{ label: "test-harness", active: false, wasActive: true, toggleable: true, section: { category: "Code Conventions" }, item: { id: "test-harness", toggle: "package" } }],
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
    // test-harness starts on, so session-close's enable result leaves it out; the wizard then turns it off.
    const seed = spawnSync(process.execPath, [path.join(path.dirname(self), "../cli/main.mjs"), "package", "enable", "test-harness"], { env: { ...env, WIZARD_RECOMMENDATIONS_CHILD: "" }, encoding: "utf8" });
    assert.equal(seed.status, 0, `seed enable should succeed\n${seed.stderr}`);
    const run = spawnSync(process.execPath, [self], { env: { ...env, WIZARD_DISABLE_AFTER: "1" }, encoding: "utf8" });
    assert.equal(run.status, 0, `wizard apply should succeed\n${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /enable session-close — ok/, "the session-close toggle applies");

    const lines = run.stdout.split("\n").filter((line) => line.startsWith("recommended (not enabled):"));
    assert.equal(lines.length, 1, `exactly one recommendation line\n${run.stdout}`);
    const named = lines[0].replace("recommended (not enabled): ", "").split(" — ")[0].split(", ");
    assert.deepEqual(named.sort(), ["code-style", "plan-suite", "test-harness"], "names session-close's recommendations that are off, including those of what it includes");
    assert.match(lines[0], /roborepo package enable <id>/, "names the command that enables one");

    const registry = JSON.parse(fs.readFileSync(path.join(home, ".roborepo", "enabled-packages.json"), "utf8"));
    assert.deepEqual(registry.packages, ["session-close"], "only the selected package is recorded as a root");
    assert.ok(registry.disabled.includes("test-harness"), "the wizard's disable of test-harness applied");
    const applied = JSON.parse(fs.readFileSync(path.join(home, ".roborepo", "applied-packages.json"), "utf8"));
    const appliedIds = (applied.packages || applied).slice().sort();
    assert.deepEqual(appliedIds, ["implementation-review", "session-close"], "applies session-close and what it includes, and no recommendation");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
  console.log("ok: setup wizard names recommendations still off and enables none of them");
}
