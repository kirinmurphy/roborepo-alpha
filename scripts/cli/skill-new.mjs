import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  initializeWorkspace,
  packageMode,
  repoRoot,
  sharedSkillsDir,
  workspaceCommandsDir,
  workspaceSkillsDir,
} from "./paths.mjs";
import { resolveNewOptions } from "./skill-new-options.mjs";
import { updateReadmeForCommand, updateReadmeForHelper } from "./skill-new-readme.mjs";
import { skillTemplate, skillBackedCommandTemplate, standaloneCommandTemplate } from "./skill-new-templates.mjs";
import { loadPackageCatalog } from "./package-catalog.mjs";
import { SKILL_TRIGGERS_FILE } from "./skill-trigger-fixtures.mjs";

const NATIVE_SKILL_CREATOR = path.join(
  os.homedir(), ".codex", "skills", ".system", "skill-creator", "scripts"
);
const NATIVE_INIT_SKILL = path.join(NATIVE_SKILL_CREATOR, "init_skill.py");
const NATIVE_GEN_YAML = path.join(NATIVE_SKILL_CREATOR, "generate_openai_yaml.py");
// Medium- and high-risk skills are the ones whose trigger wording needs a guard. No stub fixture is
// written: an empty one passes the check and would read as coverage that does not exist.
const TRIGGER_FIXTURE_RISKS = new Set(["medium", "high"]);

function runChecked(label, command, args, opts = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit", ...opts });
  if (result.error) throw new Error(`${label} failed to start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} failed with exit ${result.status}`);
}

function writeNewFile(filePath, content) {
  if (fs.existsSync(filePath)) throw new Error(`refusing to overwrite existing file: ${path.relative(repoRoot, filePath)}`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function assertPathAvailable(filePath) {
  if (fs.existsSync(filePath)) throw new Error(`refusing to overwrite existing file: ${path.relative(repoRoot, filePath)}`);
}

function assertPathMissing(filePath) {
  if (fs.existsSync(filePath)) throw new Error(`refusing to write into existing path: ${path.relative(repoRoot, filePath)}`);
}

function hasNativeInitSkill() {
  return fs.existsSync(NATIVE_INIT_SKILL);
}

function scaffoldWithNative(name) {
  runChecked(
    "native init_skill.py",
    "python3",
    [NATIVE_INIT_SKILL, name, "--path", sharedSkillsDir],
    { env: { ...process.env, PYTHONPATH: NATIVE_SKILL_CREATOR } }
  );
}

function skillRoot() {
  return packageMode ? workspaceSkillsDir : sharedSkillsDir;
}

function builtInPackageRoot(id) {
  return path.join(repoRoot, "globals", "packages", id);
}

function formatDisplayName(name) {
  const ACRONYMS = new Set(["GH", "MCP", "API", "CI", "CLI", "LLM", "PDF", "PR", "UI", "URL", "SQL"]);
  const BRANDS = { openai: "OpenAI", openapi: "OpenAPI", github: "GitHub", sqlite: "SQLite", fastapi: "FastAPI" };
  const SMALL_WORDS = new Set(["and", "or", "to", "up", "with"]);
  return name.split("-").filter(Boolean).map((word, i) => {
    const up = word.toUpperCase();
    const lo = word.toLowerCase();
    if (ACRONYMS.has(up)) return up;
    if (BRANDS[lo]) return BRANDS[lo];
    if (i > 0 && SMALL_WORDS.has(lo)) return lo;
    return word.charAt(0).toUpperCase() + word.slice(1);
  }).join(" ");
}

function generateShortDescription(displayName) {
  let desc = `Help with ${displayName} tasks`;
  if (desc.length < 25) desc = `Help with ${displayName} tasks and workflows`;
  if (desc.length > 64) desc = `Help with ${displayName}`;
  if (desc.length > 64) desc = `${displayName} helper`;
  return desc.slice(0, 64);
}

function ensureOpenAIYaml(skillDir, name) {
  const yamlPath = path.join(skillDir, "agents", "openai.yaml");
  if (fs.existsSync(yamlPath)) return;

  if (fs.existsSync(NATIVE_GEN_YAML)) {
    runChecked(
      "generate_openai_yaml.py",
      "python3",
      [NATIVE_GEN_YAML, skillDir, "--name", name],
      { env: { ...process.env, PYTHONPATH: NATIVE_SKILL_CREATOR } }
    );
    return;
  }

  const displayName = formatDisplayName(name);
  const shortDescription = generateShortDescription(displayName);
  const yaml = `interface:\n  display_name: "${displayName}"\n  short_description: "${shortDescription}"\n`;
  fs.mkdirSync(path.dirname(yamlPath), { recursive: true });
  fs.writeFileSync(yamlPath, yaml);
  console.log("[OK] Created agents/openai.yaml");
}

function preflightSkillNew(opts) {
  if (packageMode) {
    initializeWorkspace();
    if (opts.kind === "auto" || opts.kind === "skill-command") {
      assertPathMissing(path.join(sharedSkillsDir, opts.name));
      assertPathMissing(path.join(skillRoot(), opts.name));
    }
    if (opts.kind === "standalone") {
      assertPathAvailable(path.join(repoRoot, "generated", "claude", "commands", `${opts.command}.md`));
      assertPathAvailable(path.join(repoRoot, "generated", "codex", "commands", `${opts.command}.md`));
      assertPathAvailable(path.join(workspaceCommandsDir, `${opts.command}.md`));
    }
    return;
  }

  if (opts.kind === "auto" || opts.kind === "skill-command") {
    assertPathMissing(path.join(skillRoot(), opts.name));
    assertPathMissing(builtInPackageRoot(opts.name));
  }

  if (opts.kind === "skill-command" || opts.kind === "standalone") {
    assertPathMissing(builtInPackageRoot(opts.kind === "standalone" ? opts.command : opts.name));
    if (packageCommandExists(opts.command)) throw new Error(`slash command already exists: ${opts.command}`);
  }

  if (opts.kind === "standalone") {
    assertPathAvailable(path.join(builtInPackageRoot(opts.command), "commands", `${opts.command}.md`));
  }
}

function packageCommandExists(commandName) {
  try {
    return loadPackageCatalog({ includeUnavailable: true }).some((pkg) =>
      (pkg.resources || []).some((resource) => {
        if (resource.type === "slash-command") return resource.name === commandName;
        if (resource.type === "skill") return (resource.entrypoints || []).some((entrypoint) => entrypoint.type === "slash-command" && entrypoint.name === commandName);
        return false;
      })
    );
  } catch {
    return false;
  }
}

export async function skillNew(args) {
  const opts = await resolveNewOptions(args);
  preflightSkillNew(opts);

  if (opts.kind === "auto" || opts.kind === "skill-command") {
    const packageDir = packageMode ? null : builtInPackageRoot(opts.name);
    const skillDir = packageMode ? path.join(skillRoot(), opts.name) : path.join(packageDir, "skills", opts.name);
    if (!packageMode && hasNativeInitSkill()) {
      writeNewFile(path.join(skillDir, "SKILL.md"), skillTemplate(opts.name, opts.description));
    } else {
      writeNewFile(path.join(skillDir, "SKILL.md"), skillTemplate(opts.name, opts.description));
    }
    ensureOpenAIYaml(skillDir, opts.name);
    if (packageMode) {
      console.log(`package mode: custom skill written to ${skillDir}`);
    } else {
      writePackageConfig(packageDir, packageConfigForSkill(opts));
    }
    if (opts.kind === "auto") {
      if (!packageMode) updateReadmeForHelper({ name: opts.name, description: opts.description, category: opts.category });
    }
  }

  if (opts.kind === "skill-command") {
    if (packageMode) {
      writeNewFile(
        path.join(workspaceCommandsDir, `${opts.command}.md`),
        skillBackedCommandTemplate(opts.command, opts.name, opts.description),
      );
    }
    if (!packageMode) updateReadmeForCommand({ name: opts.command, description: opts.description });
  }

  if (opts.kind === "standalone") {
    const sourceRel = packageMode
      ? path.join("commands", `${opts.command}.md`)
      : path.join("commands", `${opts.command}.md`);
    const packageDir = packageMode ? null : builtInPackageRoot(opts.command);
    const sourceAbs = packageMode ? path.join(workspaceCommandsDir, `${opts.command}.md`) : path.join(packageDir, sourceRel);
    writeNewFile(sourceAbs, standaloneCommandTemplate(opts.command, opts.description));
    if (!packageMode) writePackageConfig(packageDir, packageConfigForStandalone(opts));
    if (!packageMode) updateReadmeForCommand({ name: opts.command, description: opts.description });
  }

  if (packageMode) {
    console.log("");
    console.log(`created ${opts.kind}: ${opts.kind === "standalone" ? `/${opts.command}` : opts.name}`);
    console.log("workspace custom content is portable and app built-ins were not modified.");
    return;
  }

  runChecked("skill link-internal", "bash", [path.join(repoRoot, "scripts", "build", "link-skills.sh"), "--quiet"]);
  runChecked("skill link-globals", "bash", [path.join(repoRoot, "scripts", "build", "link-global-skills.sh")]);
  runChecked("slash command render", process.execPath, [
    path.join(repoRoot, "scripts", "build", "render-slash-commands.mjs"),
    "--quiet",
  ]);

  console.log("");
  console.log(`created ${opts.kind}: ${opts.kind === "standalone" ? `/${opts.command}` : opts.name}`);
  console.log("next: edit the generated body, then run:");
  console.log("  scripts/doctor.sh --quiet");
  if (opts.kind !== "standalone" && TRIGGER_FIXTURE_RISKS.has(opts.risk)) {
    const fixturePath = path.relative(repoRoot, path.join(builtInPackageRoot(opts.name), SKILL_TRIGGERS_FILE));
    console.log(`then add trigger fixtures to ${fixturePath} and run:`);
    console.log("  roborepo skill triggers --check");
  }
}

function writePackageConfig(packageDir, config) {
  writeNewFile(path.join(packageDir, "package.config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

function packageConfigBase(id, description, category) {
  return {
    schemaVersion: 1,
    id,
    label: formatDisplayName(id),
    description,
    lifecycle: "optional",
    presentation: { category, order: 100 },
    resources: [],
  };
}

function packageConfigForSkill(opts) {
  // "commands" was removed as a presentation category; scaffolding it produced a package the
  // catalog validator rejects, so `skill new --kind=skill-command` failed at the slash-command
  // render step. Command-shaped skills sit under the skill lifecycle category instead.
  const config = packageConfigBase(
    opts.name,
    opts.description,
    opts.kind === "skill-command" ? "skills-dev-lifecycle" : "code-conventions",
  );
  const resource = {
    type: "skill",
    id: opts.name,
    source: `skills/${opts.name}`,
    invocation: opts.kind === "skill-command" ? "manual" : "auto",
    risk: opts.risk,
  };
  if (opts.kind === "skill-command") {
    resource.entrypoints = [
      {
        type: "slash-command",
        name: opts.command,
        description: opts.description,
        harnesses: opts.harnesses,
      },
    ];
  }
  config.resources.push(resource);
  return config;
}

function packageConfigForStandalone(opts) {
  const config = packageConfigBase(opts.command, opts.description, "skills-dev-lifecycle");
  config.resources.push({
    type: "slash-command",
    id: opts.command,
    name: opts.command,
    source: `commands/${opts.command}.md`,
    description: opts.description,
    harnesses: opts.harnesses,
  });
  return config;
}
