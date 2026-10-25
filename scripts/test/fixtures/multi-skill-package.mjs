// A workspace package holding two skills and a rules fragment, for checks that a package with
// several skill resources validates, enables, reports, and costs as one unit. `duo-lead` is a
// manual skill with a slash command; `duo-helper` is an auto skill without one.
import fs from "node:fs";
import path from "node:path";

export const MULTI_SKILL_PACKAGE_ID = "duo-suite";
export const MULTI_SKILL_IDS = ["duo-lead", "duo-helper"];
export const MULTI_SKILL_COMMAND = "duo-lead";

export function writeMultiSkillPackage(packagesDir) {
  const packageDir = path.join(packagesDir, MULTI_SKILL_PACKAGE_ID);
  fs.mkdirSync(packageDir, { recursive: true });
  for (const id of MULTI_SKILL_IDS) {
    const skillDir = path.join(packageDir, "skills", id);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      `---\nname: ${id}\ndescription: Fixture skill ${id} that only works beside its sibling.\n---\n\n# ${id}\n\nHand off to the other duo skill when done.\n`,
    );
  }
  fs.writeFileSync(path.join(packageDir, "rules.md"), "## Duo Suite\n\nKeep the duo skills in step.\n");
  fs.writeFileSync(path.join(packageDir, "package.config.json"), `${JSON.stringify({
    schemaVersion: 1,
    id: MULTI_SKILL_PACKAGE_ID,
    label: "Duo Suite",
    description: "Two fixture skills that hand off to each other.",
    lifecycle: "optional",
    presentation: { category: "skills-dev-lifecycle", order: 200 },
    resources: [
      {
        type: "skill",
        id: "duo-lead",
        source: "skills/duo-lead",
        invocation: "manual",
        risk: "low",
        entrypoints: [{ type: "slash-command", name: MULTI_SKILL_COMMAND, description: "Run the duo lead.", harnesses: ["claude", "codex"] }],
      },
      { type: "skill", id: "duo-helper", source: "skills/duo-helper", invocation: "auto", risk: "low" },
      { type: "rules", source: "rules.md", harness: "both" },
    ],
  }, null, 2)}\n`);
  return packageDir;
}
