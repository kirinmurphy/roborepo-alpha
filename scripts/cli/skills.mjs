// roborepo `skill` subcommands: link this repo's .codex/skills into existing .claude, and
// export the shared harness skills into a consumer repo (+ a shareable zip).

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  listSourceSkills,
  resolveClientSkillDirs,
  copyDir,
  timestamp,
  makePrompter,
  confirmYesNo,
  askOverrideSkip,
  writeZip,
  linkLocalSkills,
} from "./skill-lib.mjs";
import { initializeWorkspace, packageMode, repoRoot, sharedSkillsDir, workspaceSkillsDir } from "./paths.mjs";
import { formatSkillInspection, inspectSkill } from "./skill-inventory.mjs";
import { loadPackageCatalog } from "./package-catalog.mjs";
import { listHarnessProviders } from "../harnesses/registry.mjs";
import { resolveHarnessPath } from "../harnesses/paths.mjs";

// Every registered provider's skills directory, not a fixed Codex/Claude pair — a provider without
// the skills capability (or a future one whose skills path isn't home-relative) is simply skipped.
function harnessSkillDirs() {
  return listHarnessProviders()
    .filter((provider) => provider.manifest.capabilities.includes("skills"))
    .map((provider) => resolveHarnessPath(provider.manifest, "skills"));
}

function runChecked(label, command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit" });
  if (result.error) throw new Error(`${label} failed to start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} failed with exit ${result.status}`);
}

const NATIVE_HELP_TIMEOUT_MS = 10000;
const USE_COLOR =
  (Boolean(process.stdout.isTTY) || Boolean(process.env.FORCE_COLOR)) &&
  !process.env.NO_COLOR &&
  !process.env.ROBOREPO_NO_COLOR;
const COLOR = USE_COLOR
  ? {
      reset: "\x1b[0m",
      bold: "\x1b[1m",
      dim: "\x1b[2m",
      cyan: "\x1b[36m",
      green: "\x1b[32m",
      yellow: "\x1b[33m",
    }
  : { reset: "", bold: "", dim: "", cyan: "", green: "", yellow: "" };

function nativeHelp(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: NATIVE_HELP_TIMEOUT_MS,
    maxBuffer: 1024 * 256,
  });

  if (result.error || result.status !== 0) {
    const detail = nativeHelpFailure(command, args, result);
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
    return { ok: false, detail, output };
  }

  return { ok: true, text: (result.stdout || result.stderr || "").trim() };
}

function nativeHelpFailure(command, args, result) {
  if (result.error?.code === "ENOENT") return `${command} not found on PATH`;
  if (result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM") {
    return `${command} ${args.join(" ")} timed out after ${NATIVE_HELP_TIMEOUT_MS / 1000}s`;
  }
  const status = result.status === null ? "unknown status" : `exit ${result.status}`;
  return `${command} ${args.join(" ")} failed (${status})`;
}

function printNativeFullHelp(title, command, args, fallbackCommands) {
  console.log("");
  console.log(section(title));
  const result = nativeHelp(command, args);
  if (result.ok) {
    console.log(result.text);
    return;
  }
  console.log(`${result.detail}.`);
  if (result.output) console.log(indentBlock(result.output));
  console.log(`Fallback examples: ${fallbackCommands.join(", ")}`);
}

function indentBlock(text) {
  return text.split("\n").map((line) => `  ${line}`).join("\n");
}

function section(title) {
  return `${COLOR.bold}${COLOR.cyan}${title}${COLOR.reset}`;
}

function command(text) {
  return `${COLOR.green}${text}${COLOR.reset}`;
}

function note(text) {
  return `${COLOR.dim}${text}${COLOR.reset}`;
}

function label(text) {
  return `${COLOR.bold}${text}${COLOR.reset}`;
}

export function skillAdopt(args) {
  const name = args[0];
  if (!name) {
    console.error("usage: roborepo skill adopt <name>");
    process.exit(2);
  }

  const candidateDirs = harnessSkillDirs();
  let src;
  for (const skillsDir of candidateDirs) {
    const candidate = path.join(skillsDir, name);
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isDirectory() && !stat.isSymbolicLink()) { src = candidate; break; }
    } catch { /* not found */ }
  }

  if (!src) {
    console.error(`no unmanaged skill '${name}' found in ${candidateDirs.join(" or ")}`);
    console.error("only real directories (not managed symlinks) can be adopted");
    process.exit(1);
  }

  if (packageMode) initializeWorkspace();
  if (packageMode && fs.existsSync(path.join(sharedSkillsDir, name))) {
    console.error(`built-in skill exists: ${name}; workspace skill overrides are not supported`);
    process.exit(1);
  }
  const packageDir = path.join(repoRoot, "globals", "packages", name);
  const dest = path.join(packageMode ? workspaceSkillsDir : path.join(packageDir, "skills"), name);
  if (fs.existsSync(dest)) {
    console.error(`${path.relative(packageMode ? path.dirname(workspaceSkillsDir) : repoRoot, dest)} already exists — skill already adopted or name collision`);
    process.exit(1);
  }

  if (!fs.existsSync(path.join(src, "SKILL.md"))) {
    console.error(`${src} has no SKILL.md — not a valid skill directory`);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  copyDir(src, dest);
  console.log(`adopted: ${src} -> ${dest}`);

  fs.rmSync(src, { recursive: true, force: true });

  if (packageMode) {
    console.log("package mode: recorded custom skill in workspace; built-in manifests were not modified.");
    return;
  }

  fs.writeFileSync(path.join(packageDir, "package.config.json"), `${JSON.stringify({
    schemaVersion: 1,
    id: name,
    label: name.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" "),
    description: "Adopted skill.",
    lifecycle: "optional",
    presentation: { category: "code-conventions", order: 100 },
    resources: [
      { type: "skill", id: name, source: `skills/${name}`, invocation: "auto", risk: "low" },
    ],
  }, null, 2)}\n`);

  runChecked("skill link-globals", "bash", [path.join(repoRoot, "scripts", "build", "link-global-skills.sh")]);
  runChecked("slash command render", process.execPath, [
    path.join(repoRoot, "scripts", "build", "render-slash-commands.mjs"),
    "--quiet",
  ]);

  console.log("");
  console.log(`skill '${name}' adopted into globals/packages/${name}`);
  console.log("next: review SKILL.md and package.config.json, then:");
  console.log("  scripts/doctor.sh --quiet");
}

export function skillNative(args) {
  const full = args.includes("--full");
  const invalid = args.filter((arg) => arg !== "--full");
  if (invalid.length > 0) {
    console.error("usage: roborepo skill native [--full]");
    process.exit(2);
  }

  console.log(section("roborepo skill native"));
  console.log(note("Native skill/plugin escape hatch. Roborepo stays parity-focused; native CLIs own harness-specific plugin lifecycle."));
  console.log("");
  console.log(section("Roborepo Parity Actions"));
  console.log(`  ${command("roborepo package dev create")}       scaffold a package with a skill or command`);
  console.log(`  ${command("roborepo package dev add-skill")}    add a skill to an existing package`);
  console.log(`  ${command("roborepo skill adopt <name>")}       bring a native skill under roborepo management`);
  console.log(`  ${command("roborepo skill sync-global")}        refresh shared skill cache + harness links`);
  console.log(`  ${command("roborepo skill export-to-project")}  copy shared skills into this project`);
  console.log(`  ${command("roborepo skill link-project")}       link project .codex/skills into .claude/skills`);
  console.log(`  ${command("roborepo skill render-commands")}    render generated slash commands`);
  console.log("");
  console.log(section("Decision Rule"));
  console.log(`  ${label("Use roborepo")} when behavior should become shared, version-controlled, and available in every supporting harness.`);
  console.log(`  ${label("Use native CLIs")} for harness-specific marketplaces, installs, updates, enable/disable state, validation, and troubleshooting.`);
  console.log(`  ${label("Promote native -> roborepo")} with ${command("roborepo skill adopt <name>")}.`);

  const claudeFallback = ["claude plugin list", "claude plugin install <plugin>", "claude plugin marketplace ..."];
  const codexFallback = ["codex plugin list", "codex plugin add <plugin[@marketplace]>", "codex plugin remove <plugin>"];
  const codexMarketplaceFallback = [
    "codex plugin marketplace add <source>",
    "codex plugin marketplace list",
    "codex plugin marketplace upgrade",
    "codex plugin marketplace remove <name>",
  ];

  console.log("");
  console.log(section("Native CLI Summary"));
  console.log(`  ${label("Claude plugins")}              list, install, enable/disable, update, uninstall, marketplace, validate, details, init`);
  console.log(`  ${label("Codex plugins")}               list, add, remove, marketplace`);
  console.log(`  ${label("Codex plugin marketplaces")}   add, list, upgrade, remove`);
  console.log("");
  console.log(section("Full Native Help"));
  console.log(`  ${command("claude plugin --help")}`);
  console.log(`  ${command("codex plugin --help")}`);
  console.log(`  ${command("codex plugin marketplace --help")}`);
  console.log(`  ${command("roborepo skill native --full")}`);

  if (!full) return;

  printNativeFullHelp(
    "Claude native plugin help (from installed claude CLI)",
    "claude",
    ["plugin", "--help"],
    claudeFallback
  );

  printNativeFullHelp(
    "Codex native plugin help (from installed codex CLI)",
    "codex",
    ["plugin", "--help"],
    codexFallback
  );

  printNativeFullHelp(
    "Codex native plugin marketplace help (from installed codex CLI)",
    "codex",
    ["plugin", "marketplace", "--help"],
    codexMarketplaceFallback
  );
}

export function skillInspect(args) {
  const name = args[0];
  const invalid = args.slice(1);
  if (!name || invalid.length > 0) {
    console.error("usage: roborepo skill inspect <name>");
    process.exit(2);
  }
  const item = inspectSkill(name);
  const installed = item.source.exists || Object.values(item.harnesses).some((state) => state.installed);
  if (!installed) {
    console.error(`skill not found: ${name}`);
    process.exit(1);
  }
  console.log(formatSkillInspection(item));
}

async function resolveSkillInstallTargets(repo, { dryRun = false, uninstall = false } = {}) {
  // Skills live in .codex/skills/<name>/ (Codex reads there directly).
  // Only .claude/skills/<name> needs a symlink; .codex is the source, not a link target.
  const targets = [
    { name: "Claude", root: path.join(repo, ".claude") },
  ];
  const existing = targets.filter((target) => fs.existsSync(target.root));
  const missing = targets.filter((target) => !fs.existsSync(target.root));

  if (missing.length === 0 || uninstall) return existing.map((target) => target.root);

  const prompter = makePrompter();
  if (!prompter.ask) return existing.map((target) => target.root);

  const selected = [...existing];
  for (const target of missing) {
    const include = await confirmYesNo(prompter, `Symlink skills to ${target.name}?`, true);
    if (include) selected.push(target);
  }
  prompter.close();

  if (!dryRun) {
    for (const target of selected) fs.mkdirSync(target.root, { recursive: true });
  }
  return selected.map((target) => target.root);
}

export async function skillLink(flags, commandName = "skill link-project") {
  for (const f of flags) {
    if (f === "--dry-run" || f === "--uninstall") continue;
    console.error(`unknown flag for "${commandName}": ${f}`);
    process.exit(2);
  }

  const dryRun = flags.has("--dry-run");
  const uninstall = flags.has("--uninstall");
  const repo = process.cwd();
  const codexRoot = path.join(repo, ".codex");
  const srcDir = path.join(repo, ".codex", "skills");

  if (!fs.existsSync(codexRoot)) {
    console.error(`no .codex directory found at ${codexRoot}`);
    console.error(`move repo skills into .codex/skills/<skill-name>/SKILL.md first, then run:`);
    console.error(`  roborepo ${commandName}`);
    process.exit(1);
  }

  if (!fs.existsSync(srcDir)) {
    console.error(`no .codex/skills directory found at ${srcDir}`);
    console.error(`move repo skills into .codex/skills/<skill-name>/SKILL.md first, then run:`);
    console.error(`  roborepo ${commandName}`);
    process.exit(1);
  }

  const targetRoots = await resolveSkillInstallTargets(repo, { dryRun, uninstall });
  const t = linkLocalSkills(repo, { dryRun, uninstall, targetRoots });
  const dry = dryRun ? " (dry-run)" : "";
  console.log("");
  if (t.targetDirs === 0) {
    console.log(`0 existing target folder(s) found (.claude); no skill links installed${dry}.`);
    console.log(`Create .claude/ first, then re-run (Codex reads .codex/skills/ directly):`);
    console.log(`  roborepo ${commandName}`);
    return;
  }
  if (uninstall) {
    console.log(`${t.unlinked} link(s) removed${dry}, ${t.pruned} pruned, ${t.conflicts} conflict(s).`);
  } else {
    let line =
      `${t.skills} skill(s): ${t.linked} linked${dry}, ${t.ok} already ok, ` +
      `${t.pruned} pruned, ${t.conflicts} conflict(s)`;
    if (t.denied > 0) line += `, ${t.denied} denied (OS refused symlink)`;
    console.log(`${line}.`);
    console.log("");
    console.log("Reminder: added a skill to .codex/skills/<name>/SKILL.md? Re-run");
    console.log(`  roborepo ${commandName}`);
    console.log("so existing Claude skill links pick it up.");
  }
}

export async function skillExport(flags, commandName = "skill export-to-project") {
  const assumeYes = flags.has("--yes");
  let onConflict = "skip";
  for (const f of flags) {
    if (f === "--yes") continue;
    if (f.startsWith("--on-conflict=")) {
      onConflict = f.slice("--on-conflict=".length);
      continue;
    }
    console.error(`unknown flag for "${commandName}": ${f}`);
    process.exit(2);
  }
  if (!["skip", "override"].includes(onConflict)) {
    console.error(`--on-conflict must be skip or override`);
    process.exit(2);
  }

  const cwd = process.cwd();

  // Guard: never run the exporter from inside the roborepo source repo itself — it
  // would copy the shared skills back over their own source and drop a zip in the repo root.
  if (path.resolve(cwd) === path.resolve(repoRoot)) {
    console.error(`refusing to export into the roborepo source repo (${cwd}).`);
    console.error(`cd into the TARGET repo first, then run: roborepo ${commandName}`);
    process.exit(1);
  }

  const prompter = makePrompter();
  const interactive = Boolean(prompter.ask);
  if (!interactive && !assumeYes) {
    console.error(`non-interactive: pass --yes and optionally --on-conflict=skip|override`);
    prompter.close();
    process.exit(2);
  }

  const proceed = assumeYes
    ? true
    : await confirmYesNo(prompter, `Download skills into the current folder (${cwd})?`, true);
  if (!proceed) {
    console.log("");
    console.log("Re-run this command from the ROOT of the target repo:");
    console.log(`  cd /path/to/your/repo && roborepo ${commandName}`);
    prompter.close();
    return;
  }

  const dests = resolveClientSkillDirs(cwd, { create: true });
  console.log(`destinations: ${dests.map((d) => path.relative(cwd, d) || d).join(", ")}`);

  const skills = packageSkillSources();
  if (skills.length === 0) {
    console.error(`no package-owned skills found`);
    prompter.close();
    process.exit(1);
  }
  const ts = timestamp();
  const bundleName = `global_agent_skills_${ts}`;
  const zipPath = path.join(cwd, `${bundleName}.zip`);
  writeZip(
    zipPath,
    skills.map((skill) => ({ srcDir: skill.source, nameInZip: `${bundleName}/${skill.name}` })),
  );
  console.log(`bundled ${skills.length} skill(s) -> ${path.basename(zipPath)} (shareable artifact)`);

  let copied = 0;
  let skipped = 0;
  let overridden = 0;

  for (const dest of dests) {
    fs.mkdirSync(dest, { recursive: true });
    for (const skill of skills) {
      const { name, source: src } = skill;
      const target = path.join(dest, name);

      if (!fs.existsSync(target)) {
        copyDir(src, target);
        console.log(`copy: ${path.relative(cwd, target)}`);
        copied++;
        continue;
      }

      const choice = interactive ? await askOverrideSkip(prompter, name) : onConflict;
      if (choice === "override") {
        const archiveDir = path.join(dest, "archived");
        fs.mkdirSync(archiveDir, { recursive: true });
        const backup = path.join(archiveDir, `${name}_backup_${ts}`);
        fs.renameSync(target, backup);
        copyDir(src, target);
        console.log(`override: ${path.relative(cwd, target)} (old -> ${path.relative(cwd, backup)})`);
        overridden++;
      } else {
        console.log(`skip: ${path.relative(cwd, target)} (kept existing)`);
        skipped++;
      }
    }
  }

  prompter.close();
  console.log("");
  console.log(`done: ${copied} copied, ${overridden} overridden, ${skipped} skipped.`);
  console.log(`shareable bundle left at: ${path.basename(zipPath)}`);
}

function packageSkillSources() {
  return loadPackageCatalog({ includeUnavailable: true })
    .flatMap((pkg) => (pkg.resources || [])
      .filter((resource) => resource.type === "skill")
      .map((resource) => ({ name: resource.id, source: path.join(pkg.sourceRoot, resource.source) })))
    .sort((a, b) => a.name.localeCompare(b.name));
}
