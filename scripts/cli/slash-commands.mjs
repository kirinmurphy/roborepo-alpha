import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./paths.mjs";
import { loadPackageCatalog } from "./package-catalog.mjs";
import {
  GENERATED_COMMAND_MARKER,
  LEGACY_GENERATED_COMMAND_MARKER,
  packageOwnerMarker,
  slashCommandGenDir,
  slashCommandLiveDir,
  skillFilePath,
} from "./skill-command-config.mjs";
import { resolvesIntoRepo } from "./repo-links.mjs";

function readText(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), "utf8").replace(/\r\n/g, "\n");
}

function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

// Agent-facing description for a slash command. Single source of truth: the SKILL.md frontmatter
// (the skill's own file for skill-backed commands, the command source's frontmatter for standalone
// ones). The package config's entrypoint MAY override it, but when the entrypoint description is
// absent (or merely repeats the package description) the frontmatter wins — SKILL.md is what the
// agent actually reads, so a hand-synced copy in package.config.json can only drift.
function commandDescription(command) {
  if (command.description && command.description !== command.packageDescription) return command.description;
  if (command.skillSourceAbs) {
    const desc = frontmatterDescription(readIfExists(command.skillSourceAbs));
    if (desc) return desc;
  }
  if (command.sourceAbs) {
    const desc = frontmatterDescription(readIfExists(command.sourceAbs));
    if (desc) return desc;
  }
  return command.description || command.packageDescription;
}

function frontmatterDescription(source) {
  if (!source) return null;
  const frontmatter = source.match(/^---\n([\s\S]*?)\n---/)?.[1];
  if (!frontmatter) return null;
  const lines = frontmatter.split("\n");
  const start = lines.findIndex((line) => /^description:\s*(.*)$/.test(line));
  if (start === -1) return null;
  const first = lines[start].match(/^description:\s*(.*)$/)[1].trim();
  // YAML block scalars (">" / "|") put the value on indented continuation lines — fold them.
  if (!["", ">", "|", ">-", "|-"].includes(first)) return first;
  const folded = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (!/^\s/.test(lines[i])) break;
    folded.push(lines[i].trim());
  }
  return folded.join(" ").trim() || null;
}

// Serialize a command description as a valid single-line YAML scalar for generated command
// frontmatter. Plain when unambiguous; double-quoted (escaped) when the text contains ": " / " #",
// a leading indicator char, tabs, or leading/trailing whitespace — anything that would make the
// frontmatter misparse (e.g. "Trigger: /case-study, ..." folding into a nested mapping).
function yamlDescription(value) {
  const s = String(value);
  const needsQuotes =
    /^\s/.test(s) ||
    /^[\-?:,[\]{}#&*!|>'"%@`]/.test(s) ||
    /(: | #|:\s*$)/.test(s) ||
    /\s$/.test(s) ||
    /\t/.test(s);
  if (!needsQuotes) return s;
  return `"${s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\x00-\x1f]/g, (c) =>
      c === "\t" ? "\\t" : c === "\n" ? "\\n" : `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`)}"`;
}

// Minimal YAML parser for exactly the `description: <scalar>` line we generate — enough to prove
// the serialization round-trips (quoting/escaping is correct). Returns the parsed value, or null
// for any line that isn't a well-formed single-line scalar.
function parseYamlScalar(text) {
  if (!text.length) return null;
  if (text.startsWith('"')) {
    if (!text.endsWith('"') || text.length < 2) return null;
    let out = "";
    for (let i = 1; i < text.length - 1; i++) {
      const ch = text[i];
      if (ch !== "\\") { out += ch; continue; }
      const next = text[i + 1];
      if (next === '"' || next === "\\") { out += next; i++; continue; }
      if (next === "t") { out += "\t"; i++; continue; }
      if (next === "n") { out += "\n"; i++; continue; }
      if (next === "x") {
        const hex = text.slice(i + 2, i + 4);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 3;
        continue;
      }
      return null; // unsupported escape — yamlDescription must never emit one
    }
    return out;
  }
  // Plain scalar: no leading indicator/whitespace, no ": " / " #" sequences, no trailing colon.
  if (/^\s/.test(text) || /^[\-?:,[\]{}#&*!|>'"%@`]/.test(text)) return null;
  if (/(: | #|:\s*$)/.test(text) || /\s$/.test(text) || /\t/.test(text)) return null;
  return text;
}

function commandTarget(name) {
  return `${name}.md`;
}

function withGeneratedMarker(content, packageId) {
  const marker = `<!-- ${GENERATED_COMMAND_MARKER} -->`;
  const ownerMarker = `<!-- ${packageOwnerMarker(packageId)} -->`;
  if (content.includes(marker)) {
    const withOwner = content.includes(ownerMarker) ? content : `${content.replace(/\n*$/, "")}\n${ownerMarker}\n`;
    return withOwner.endsWith("\n") ? withOwner : `${withOwner}\n`;
  }

  const lines = content.split("\n");
  if (lines[0] === "---") {
    const end = lines.findIndex((line, index) => index > 0 && line === "---");
    if (end > 0) {
      lines.splice(end + 1, 0, "", marker, ownerMarker);
      return `${lines.join("\n").replace(/\n*$/, "")}\n`;
    }
  }
  return `${marker}\n${ownerMarker}\n\n${content.replace(/\n*$/, "")}\n`;
}

function skillBackedCommand(command, harnessName) {
  const description = yamlDescription(command.description);
  // Round-trip assertion — runs in BOTH render and --check paths (expectedCommands feeds both), so
  // a description that would misparse as nested YAML fails loudly instead of shipping broken
  // frontmatter. The case-study trigger ("Trigger: /case-study, ...") needs the quoted form.
  if (parseYamlScalar(description) !== command.description) {
    throw new Error(
      `${command.packageId}: /${command.name} description does not serialize as a valid YAML scalar: ${JSON.stringify(command.description)}`,
    );
  }
  return withGeneratedMarker(`---
description: ${description}
---

# /${command.name}

Use the \`${command.skill}\` skill for this request.

Read \`${skillFilePath(harnessName, command.skill)}\`, then follow its workflow.

Keep the skill as the source of truth; this command is only the explicit entry
point.
`, command.packageId);
}

function standaloneCommand(command) {
  return withGeneratedMarker(fs.readFileSync(command.sourceAbs, "utf8").replace(/\r\n/g, "\n"), command.packageId);
}

// Keyed by "<harness>::<packageId>" so apply/prune act on exactly one package's wrappers in one
// harness's generated tree, never touching another package's or the user's own native commands.
function expectedCommands(commands) {
  const byKey = new Map();

  for (const command of commands) {
    for (const harnessName of command.harnesses) {
      const content = command.kind === "skill-backed" ? skillBackedCommand(command, harnessName) : standaloneCommand(command);
      const key = `${harnessName}::${command.packageId}`;
      if (!byKey.has(key)) byKey.set(key, new Map());
      byKey.get(key).set(commandTarget(command.name), content);
    }
  }

  return byKey;
}

function hasGeneratedMarker(filePath) {
  const content = readIfExists(filePath);
  return content !== null && (content.includes(GENERATED_COMMAND_MARKER) || content.includes(LEGACY_GENERATED_COMMAND_MARKER));
}

function renderPackageHarness(harnessName, packageId, expected, { checkOnly = false, quiet = false } = {}) {
  const relDir = slashCommandGenDir(packageId, harnessName);
  const outDir = path.join(repoRoot, relDir);
  let changed = 0;
  let failed = 0;

  if (!checkOnly) fs.mkdirSync(outDir, { recursive: true });

  for (const [fileName, content] of expected) {
    const filePath = path.join(outDir, fileName);
    const existing = readIfExists(filePath);
    if (existing !== null && existing !== content && !hasGeneratedMarker(filePath)) {
      console.error(`fail: ${relDir}/${fileName} exists and is not generated`);
      failed++;
      continue;
    }
    if (existing === content) continue;
    if (checkOnly) {
      console.error(`stale: ${relDir}/${fileName}`);
      failed++;
      continue;
    }
    fs.writeFileSync(filePath, content);
    changed++;
    if (!quiet) console.log(`render: ${relDir}/${fileName}`);
  }

  if (fs.existsSync(outDir)) {
    for (const fileName of fs.readdirSync(outDir)) {
      if (!fileName.endsWith(".md") || expected.has(fileName)) continue;
      const filePath = path.join(outDir, fileName);
      if (!hasGeneratedMarker(filePath)) continue;
      if (checkOnly) {
        console.error(`stale generated command: ${relDir}/${fileName}`);
        failed++;
        continue;
      }
      fs.unlinkSync(filePath);
      changed++;
      if (!quiet) console.log(`prune: ${relDir}/${fileName}`);
    }
  }

  return { changed, failed };
}

export function loadSlashCommandPlan() {
  const commands = slashCommandsFromPackages(loadPackageCatalog({ includeUnavailable: true }));
  return { commands, expected: expectedCommands(commands) };
}

function slashCommandsFromPackages(packages) {
  const commands = [];
  const seen = new Set();
  for (const pkg of packages) {
    for (const resource of pkg.resources || []) {
      if (resource.type === "skill") {
        for (const entrypoint of resource.entrypoints || []) {
          const command = {
            name: entrypoint.name,
            kind: "skill-backed",
            description: entrypoint.description,
            packageDescription: pkg.description,
            skill: resource.id,
            skillSourceAbs: path.join(pkg.sourceRoot, resource.source, "SKILL.md"),
            harnesses: entrypoint.harnesses,
            packageId: pkg.id,
          };
          addCommand(commands, seen, command, pkg.id);
        }
        continue;
      }
      if (resource.type === "slash-command") {
        addCommand(commands, seen, {
          name: resource.name,
          kind: "standalone",
          description: resource.description,
          packageDescription: pkg.description,
          sourceAbs: path.join(pkg.sourceRoot, resource.source),
          harnesses: resource.harnesses,
          packageId: pkg.id,
        }, pkg.id);
      }
    }
  }
  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

function addCommand(commands, seen, command, packageId) {
  if (seen.has(command.name)) throw new Error(`duplicate slash command from packages: ${command.name}`);
  seen.add(command.name);
  // Resolve the agent-facing description here (after source paths exist): SKILL.md frontmatter is
  // the single source of truth unless the entrypoint carries a genuinely different override.
  command.description = commandDescription(command);
  if (!command.description || command.description.includes("\n")) {
    throw new Error(`${packageId}: /${command.name} needs a one-line description`);
  }
  commands.push(command);
}

function checkCommandCollisions(commands) {
  const reservedPath = path.join(repoRoot, "manifests", "inventory", "reserved-commands.json");
  let reserved;
  try {
    reserved = new Set(JSON.parse(fs.readFileSync(reservedPath, "utf8")).reserved);
  } catch {
    return;
  }
  for (const command of commands) {
    if (reserved.has(command.name)) {
      console.warn(`warn: command /${command.name} collides with a reserved native/plugin command`);
    }
  }
}

export function renderSlashCommands({ checkOnly = false, quiet = false } = {}) {
  const { commands, expected } = loadSlashCommandPlan();
  checkCommandCollisions(commands);
  let changed = 0;
  let failed = 0;

  for (const [key, keyExpected] of expected) {
    const [harnessName, packageId] = key.split("::");
    const result = renderPackageHarness(harnessName, packageId, keyExpected, { checkOnly, quiet });
    changed += result.changed;
    failed += result.failed;
  }

  return { commands: commands.length, changed, failed };
}

// --------------------------------------------------------------------------- live install/removal
//
// Install-time composition: only an ENABLED package's generated wrapper is copied into the live
// harness commands dir (~/.claude/commands, ~/.codex/commands) — never the whole generated tree.
// Reuses the same "refuse to overwrite a non-generated file" safety property as renderPackageHarness.

function liveCommandsDir(harnessHome, harnessName) {
  return path.join(harnessHome, slashCommandLiveDir(harnessName));
}

// Package commands this package declares for a given harness, i.e. the file names it owns there.
function packageCommandNamesForHarness(pkg, harnessName) {
  const names = [];
  for (const resource of pkg.resources || []) {
    if (resource.type === "skill") {
      for (const entrypoint of resource.entrypoints || []) {
        if (entrypoint.type === "slash-command" && (entrypoint.harnesses || []).includes(harnessName)) {
          names.push(entrypoint.name);
        }
      }
    } else if (resource.type === "slash-command" && (resource.harnesses || []).includes(harnessName)) {
      names.push(resource.name);
    }
  }
  return names;
}

export function installPackageCommands(pkg, harnessHome, harnessName, { dryRun = false } = {}) {
  const names = packageCommandNamesForHarness(pkg, harnessName);
  if (names.length === 0) return;
  const genDir = path.join(repoRoot, slashCommandGenDir(pkg.id, harnessName));
  const destDir = liveCommandsDir(harnessHome, harnessName);
  if (!dryRun && resolvesIntoRepo(destDir, repoRoot)) {
    console.error(`  refusing to install commands: ${destDir} resolves into the repo tree (stale legacy symlink?)`);
    return;
  }
  for (const name of names) {
    const fileName = commandTarget(name);
    const src = path.join(genDir, fileName);
    if (!fs.existsSync(src)) {
      console.error(`  missing generated command: ${src} (run render-slash-commands.mjs)`);
      continue;
    }
    const dest = path.join(destDir, fileName);
    if (dryRun) {
      console.log(`  [dry-run] install command ${fileName} → ${dest}`);
      continue;
    }
    const existing = readIfExists(dest);
    if (existing !== null && !hasGeneratedMarker(dest)) {
      console.error(`  refusing to overwrite non-generated command: ${dest}`);
      continue;
    }
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(src, dest);
    console.log(`  installed command: ${dest}`);
  }
}

export function removePackageCommands(pkg, harnessHome, harnessName, { dryRun = false } = {}) {
  const names = packageCommandNamesForHarness(pkg, harnessName);
  if (names.length === 0) return;
  const destDir = liveCommandsDir(harnessHome, harnessName);
  if (!dryRun && resolvesIntoRepo(destDir, repoRoot)) {
    console.error(`  refusing to remove commands: ${destDir} resolves into the repo tree (stale legacy symlink?)`);
    return;
  }
  for (const name of names) {
    const dest = path.join(destDir, commandTarget(name));
    if (!fs.existsSync(dest)) continue;
    if (!hasGeneratedMarker(dest)) {
      console.error(`  refusing to remove non-generated command: ${dest}`);
      continue;
    }
    if (dryRun) {
      console.log(`  [dry-run] remove command ${dest}`);
      continue;
    }
    fs.unlinkSync(dest);
    console.log(`  removed command: ${dest}`);
  }
}
