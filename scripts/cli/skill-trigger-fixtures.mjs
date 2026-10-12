// Skill trigger fixtures are owned by the package that declares the skill. Each package may carry
// one optional skill-triggers.json at its root, beside package.config.json. The package root, not
// skills/<id>/, because skill directories are copied whole into harness homes and exported
// projects, and test data there would ship to agents.
import fs from "node:fs";
import path from "node:path";
import { loadPackageCatalog } from "./package-catalog.mjs";

export const SKILL_TRIGGERS_FILE = "skill-triggers.json";

// Returns every package's fixtures in catalog order, each tagged with its packageId. Unknown keys
// pass through untouched so richer fixture shapes (e.g. live-eval prompts) still load here.
// Disabled and pending packages are included: their trigger policy is source, not live state.
export function loadSkillTriggerFixtures() {
  const fixtures = [];
  for (const pkg of loadPackageCatalog({ includeUnavailable: true })) {
    fixtures.push(...packageFixtures(pkg));
  }
  return fixtures;
}

function packageFixtures(pkg) {
  const file = path.join(pkg.sourceRoot, SKILL_TRIGGERS_FILE);
  if (!fs.existsSync(file)) return [];
  const tests = readTests(file);
  const declared = new Set((pkg.resources || []).filter((r) => r.type === "skill").map((r) => r.id));
  return tests.map((test) => {
    // One package must not hold fixtures for another package's skill; that would bring back the
    // cross-package edits this file layout exists to remove.
    if (!declared.has(test.skill)) {
      throw new Error(`${file}: fixture names skill '${test.skill}', which package '${pkg.id}' does not declare`);
    }
    return { packageId: pkg.id, ...test };
  });
}

function readTests(file) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file}: invalid JSON: ${error.message}`);
  }
  if (!data || !Array.isArray(data.tests)) throw new Error(`${file}: expected { "tests": [...] }`);
  return data.tests;
}
