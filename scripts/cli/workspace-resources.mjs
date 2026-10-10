import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appRoot,
  initializeWorkspace,
  stateRoot,
  workspaceCommandsDir,
  workspaceMcpServersPath,
  workspaceOverridesDir,
  workspacePackagesDir,
  workspaceRoot,
  workspaceSkillsDir,
} from "./paths.mjs";
import { isMainModule } from "./roots.mjs";
import { hasHarnessProvider, listHarnessProviders } from "../harnesses/registry.mjs";
import { resolveHarnessPath } from "../harnesses/paths.mjs";

// Providers that declare a capability, paired with the path that capability writes to. Workspace
// resource delivery iterates these rather than a fixed id list, so registering a new provider
// delivers its workspace skills/commands without editing this file. Resolving the path through the
// manifest (not `~/.${id}`) keeps it correct for providers whose home dir is not named after their
// id.
function providersWith(capability, pathKey) {
  const targets = [];
  for (const provider of listHarnessProviders()) {
    if (!provider.manifest.capabilities.includes(capability)) continue;
    let resolved = null;
    try {
      resolved = resolveHarnessPath(provider.manifest, pathKey);
    } catch {
      resolved = null;
    }
    if (resolved) targets.push({ id: provider.id, path: resolved });
  }
  return targets;
}

const OVERRIDES_FILE = path.join(workspaceOverridesDir, "resources.json");
const WORKSPACE_COMMAND_MARKER = "<!-- managed-workspace-command -->";
const MANAGED_MARKER = ".builtin-managed";
const SUPPORTED_REPLACE_TYPES = new Set(["package", "mcp-server"]);

export function readWorkspaceOverrides() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(OVERRIDES_FILE, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw new Error(`invalid workspace override file: ${OVERRIDES_FILE}: ${err.message}`);
  }
  if (data.schemaVersion !== 1 || !Array.isArray(data.overrides)) {
    throw new Error("overrides/resources.json must contain { schemaVersion: 1, overrides: [...] }");
  }
  return data.overrides.map((entry, index) => normalizeOverride(entry, index));
}

function normalizeOverride(entry, index) {
  if (!entry || typeof entry !== "object") throw new Error(`override ${index + 1} must be an object`);
  const type = String(entry.type || "");
  const id = String(entry.id || entry.name || "");
  const mode = String(entry.mode || "");
  if (!SUPPORTED_REPLACE_TYPES.has(type)) {
    throw new Error(`override ${index + 1} has unsupported type: ${type || "(missing)"}`);
  }
  if (mode !== "replace") throw new Error(`override ${index + 1} must use mode "replace"`);
  if (!isSlug(id)) throw new Error(`override ${index + 1} has invalid id/name: ${id || "(missing)"}`);
  return { type, id, mode };
}

export function hasReplaceOverride(type, id, overrides = readWorkspaceOverrides()) {
  return overrides.some((entry) => entry.type === type && entry.id === id && entry.mode === "replace");
}

export function loadWorkspacePackages({ builtInIds = new Set(), overrides = readWorkspaceOverrides() } = {}) {
  const packages = [];
  const seen = new Set();
  for (const file of packageConfigFiles(workspacePackagesDir)) {
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    validatePackage(pkg, file);
    if (seen.has(pkg.id)) throw new Error(`duplicate workspace package id: ${pkg.id}`);
    if (builtInIds.has(pkg.id) && !hasReplaceOverride("package", pkg.id, overrides)) {
      throw new Error(`workspace package '${pkg.id}' conflicts with a built-in package; add a typed package replace override to overrides/resources.json`);
    }
    seen.add(pkg.id);
    packages.push(pkg);
  }
  return packages;
}

export function loadWorkspaceMcpServers({ builtInNames = new Set(), overrides = readWorkspaceOverrides() } = {}) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(workspaceMcpServersPath, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw new Error(`invalid workspace MCP file: ${workspaceMcpServersPath}: ${err.message}`);
  }
  if (!Array.isArray(data.servers)) throw new Error("workspace mcp/servers.json must contain a servers array");
  const seen = new Set();
  const servers = [];
  for (const server of data.servers) {
    validateMcpServer(server, workspaceMcpServersPath);
    if (seen.has(server.name)) throw new Error(`duplicate workspace MCP server: ${server.name}`);
    if (builtInNames.has(server.name) && !hasReplaceOverride("mcp-server", server.name, overrides)) {
      throw new Error(`workspace MCP server '${server.name}' conflicts with a built-in server; add a typed mcp-server replace override to overrides/resources.json`);
    }
    seen.add(server.name);
    servers.push(server);
  }
  return servers;
}

// `dryRun` only reaches the scaffold step: validation itself reads. It defaults to false so the
// setup path (workspace.mjs) keeps creating the workspace as before — the flag exists so a caller
// previewing changes does not materialize a workspace as a side effect of validating one.
export function validateWorkspace({
  builtInPackageIds = new Set(readBuiltInPackages().map((pkg) => pkg.id)),
  builtInMcpNames = new Set(readBuiltInMcpServers().map((server) => server.name)),
  dryRun = false,
} = {}) {
  initializeWorkspace({ dryRun });
  const overrides = readWorkspaceOverrides();
  validateWorkspaceSkills();
  validateWorkspaceCommands();
  loadWorkspacePackages({ builtInIds: builtInPackageIds, overrides });
  loadWorkspaceMcpServers({ builtInNames: builtInMcpNames, overrides });
  return { ok: true };
}

export function applyWorkspaceAssets({ dryRun = false } = {}) {
  validateWorkspace({ dryRun });
  const applied = {
    skills: applyWorkspaceSkills({ dryRun }),
    commands: applyWorkspaceCommands({ dryRun }),
  };
  console.log(`workspace apply: ${applied.skills} skill(s), ${applied.commands} command(s)`);
  return applied;
}

export function importLegacyWorkspace(sourceRoot, { dryRun = false } = {}) {
  const source = path.resolve(sourceRoot);
  if (!fs.existsSync(source)) throw new Error(`import source not found: ${source}`);
  initializeWorkspace({ dryRun });

  const report = {
    importedSkills: 0,
    importedCommands: 0,
    importedPackages: 0,
    importedMcpServers: 0,
    changedBuiltIns: [],
  };

  importSkillDirs(path.join(source, "globals", "agents", "skills"), report, dryRun);
  importCommandFiles(path.join(source, "globals", "commands"), report, dryRun);
  importPackageConfigs(path.join(source, "globals", "packages"), report, dryRun);
  importMcpManifest(path.join(source, "manifests", "inventory", "mcp-servers.json"), report, dryRun);
  printImportReport(report, dryRun);
  return report;
}

function validateWorkspaceSkills() {
  for (const name of sourceSkillNames(workspaceSkillsDir)) {
    if (builtInSkillSource(name)) {
      throw new Error(`workspace skill '${name}' conflicts with a built-in skill; skill overrides are not supported`);
    }
  }
}

function validateWorkspaceCommands() {
  for (const file of markdownFiles(workspaceCommandsDir)) {
    const name = path.basename(file, ".md");
    if (!isSlug(name)) throw new Error(`workspace command file has invalid name: ${path.basename(file)}`);
    for (const { id } of providersWith("slash-commands", "commands")) {
      const builtIn = path.join(appRoot, "globals", id, "commands", `${name}.md`);
      if (fs.existsSync(builtIn)) {
        throw new Error(`workspace command '${name}' conflicts with a built-in ${id} command; command overrides are not supported`);
      }
    }
  }
}

function applyWorkspaceSkills({ dryRun }) {
  let count = 0;
  for (const name of sourceSkillNames(workspaceSkillsDir)) {
    const src = path.join(workspaceSkillsDir, name);
    const cache = path.join(stateRoot, "skills", name);
    if (!dryRun) {
      fs.rmSync(cache, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(cache), { recursive: true });
      fs.cpSync(src, cache, { recursive: true, dereference: true });
      fs.closeSync(fs.openSync(path.join(cache, MANAGED_MARKER), "w"));
    }
    for (const { id } of providersWith("skills", "skills")) {
      linkHarnessSkill(id, name, cache, dryRun);
    }
    count += 1;
  }
  return count;
}

function linkHarnessSkill(harness, name, cache, dryRun) {
  const skillsDir = path.join(os.homedir(), `.${harness}`, "skills");
  if (!fs.existsSync(path.dirname(skillsDir))) return;
  const target = path.join(skillsDir, name);
  const current = readlinkSafe(target);
  if (current === cache) return;
  if (current !== null || fs.existsSync(target)) {
    if (fs.existsSync(path.join(target, MANAGED_MARKER)) || current?.startsWith(path.join(stateRoot, "skills"))) {
      if (!dryRun) fs.rmSync(target, { recursive: true, force: true });
    } else {
      console.log(`skip (native skill): ${target}`);
      return;
    }
  }
  if (!dryRun) {
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.symlinkSync(cache, target);
  }
}

function applyWorkspaceCommands({ dryRun }) {
  let count = 0;
  for (const file of markdownFiles(workspaceCommandsDir)) {
    const name = path.basename(file);
    const text = fs.readFileSync(file, "utf8");
    const rendered = `${WORKSPACE_COMMAND_MARKER}\n${text.trimEnd()}\n`;
    for (const { path: commandDir } of providersWith("slash-commands", "commands")) {
      if (!fs.existsSync(path.dirname(commandDir))) continue;
      const target = path.join(commandDir, name);
      writeManagedCommand(target, rendered, dryRun);
    }
    count += 1;
  }
  return count;
}

function writeManagedCommand(target, content, dryRun) {
  let existing = "";
  try {
    existing = fs.readFileSync(target, "utf8");
  } catch {}
  if (existing && !existing.startsWith(WORKSPACE_COMMAND_MARKER)) {
    console.log(`skip (user command): ${target}`);
    return;
  }
  if (!dryRun) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

function importSkillDirs(srcDir, report, dryRun) {
  for (const name of sourceSkillNames(srcDir)) {
    const src = path.join(srcDir, name);
    const builtIn = builtInSkillSource(name);
    if (builtIn) {
      if (!sameTree(src, builtIn)) report.changedBuiltIns.push(`skill:${name}`);
      continue;
    }
    const dest = path.join(workspaceSkillsDir, name);
    if (fs.existsSync(dest)) continue;
    if (!dryRun) fs.cpSync(src, dest, { recursive: true, dereference: true });
    report.importedSkills += 1;
  }
}

function importCommandFiles(srcDir, report, dryRun) {
  for (const file of markdownFiles(srcDir)) {
    const name = path.basename(file);
    const builtIns = providersWith("slash-commands", "commands").map(({ id }) => path.join(appRoot, "globals", id, "commands", name));
    if (builtIns.some((candidate) => fs.existsSync(candidate))) {
      if (!builtIns.some((candidate) => fs.existsSync(candidate) && sameFile(file, candidate))) {
        report.changedBuiltIns.push(`command:${name}`);
      }
      continue;
    }
    const dest = path.join(workspaceCommandsDir, name);
    if (fs.existsSync(dest)) continue;
    if (!dryRun) fs.copyFileSync(file, dest);
    report.importedCommands += 1;
  }
}

function importPackageConfigs(srcDir, report, dryRun) {
  const builtIn = new Map(readBuiltInPackages().map((pkg) => [pkg.id, pkg]));
  for (const file of packageConfigFiles(srcDir)) {
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    validatePackage(pkg, file);
    if (builtIn.has(pkg.id)) {
      if (JSON.stringify(builtIn.get(pkg.id)) !== JSON.stringify(pkg)) report.changedBuiltIns.push(`package:${pkg.id}`);
      continue;
    }
    const dest = path.join(workspacePackagesDir, pkg.id, "package.config.json");
    if (fs.existsSync(dest)) continue;
    if (!dryRun) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, `${JSON.stringify(pkg, null, 2)}\n`);
    }
    report.importedPackages += 1;
  }
}

function importMcpManifest(file, report, dryRun) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return;
  }
  const builtIn = new Map(readBuiltInMcpServers().map((server) => [server.name, server]));
  const existing = readWorkspaceMcpFile();
  const servers = existing.servers || [];
  for (const server of data.servers || []) {
    validateMcpServer(server, file);
    if (builtIn.has(server.name)) {
      if (JSON.stringify(builtIn.get(server.name)) !== JSON.stringify(server)) report.changedBuiltIns.push(`mcp-server:${server.name}`);
      continue;
    }
    if (!servers.some((item) => item.name === server.name)) servers.push(server);
    report.importedMcpServers += 1;
  }
  if (!dryRun) fs.writeFileSync(workspaceMcpServersPath, `${JSON.stringify({ servers }, null, 2)}\n`);
}

function printImportReport(report, dryRun) {
  const prefix = dryRun ? "would import" : "imported";
  console.log(`${prefix}: ${report.importedSkills} skill(s), ${report.importedCommands} command(s), ${report.importedPackages} package(s), ${report.importedMcpServers} MCP server(s)`);
  if (report.changedBuiltIns.length > 0) {
    console.log(`changed built-ins left for review: ${report.changedBuiltIns.join(", ")}`);
  }
}

function readWorkspaceMcpFile() {
  try {
    return JSON.parse(fs.readFileSync(workspaceMcpServersPath, "utf8"));
  } catch {
    return { servers: [] };
  }
}

function readBuiltInPackages() {
  return ["packages", "packages-archived"].flatMap((directory) => {
    const packagesRoot = path.join(appRoot, "globals", directory);
    try {
      return fs.readdirSync(packagesRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => path.join(packagesRoot, entry.name, "package.config.json"))
        .filter((file) => fs.existsSync(file))
        .map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
      return [];
    }
  });
}

function readBuiltInMcpServers() {
  try {
    return JSON.parse(fs.readFileSync(path.join(appRoot, "manifests", "inventory", "mcp-servers.json"), "utf8")).servers || [];
  } catch {
    return [];
  }
}

function validatePackage(pkg, file) {
  if (!pkg || typeof pkg !== "object") throw new Error(`invalid package in ${file}`);
  if (!isSlug(pkg.id)) throw new Error(`package in ${file} has invalid id`);
  if (typeof pkg.label !== "string" || pkg.label.trim() === "") throw new Error(`package '${pkg.id}' needs label`);
  if (!Array.isArray(pkg.resources)) throw new Error(`package '${pkg.id}' needs resources array`);
  for (const comp of pkg.resources) {
    if (!comp || typeof comp !== "object" || typeof comp.type !== "string") {
      throw new Error(`package '${pkg.id}' has invalid resource`);
    }
  }
}

function validateMcpServer(server, file) {
  if (!server || typeof server !== "object") throw new Error(`invalid MCP server in ${file}`);
  if (!isSlug(server.name)) throw new Error(`MCP server in ${file} has invalid name`);
  if (typeof server.commandOrUrl !== "string" || server.commandOrUrl.trim() === "") {
    throw new Error(`MCP server '${server.name}' needs commandOrUrl`);
  }
  if (!Array.isArray(server.args)) throw new Error(`MCP server '${server.name}' needs args array`);
  if (!Array.isArray(server.harnesses)) throw new Error(`MCP server '${server.name}' needs harnesses array`);
  for (const harness of server.harnesses) {
    if (!hasHarnessProvider(harness)) throw new Error(`MCP server '${server.name}' has invalid harness: ${harness}`);
  }
}

function builtInSkillSource(name) {
  const systemSkill = path.join(appRoot, "globals", "system", "skills", name);
  if (fs.existsSync(systemSkill)) return systemSkill;
  let entries;
  for (const directory of ["packages", "packages-archived"]) {
    const packagesRoot = path.join(appRoot, "globals", directory);
    try {
      entries = fs.readdirSync(packagesRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const candidate = path.join(packagesRoot, entry.name, "skills", name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function sourceSkillNames(srcDir) {
  let entries;
  try {
    entries = fs.readdirSync(srcDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => !entry.name.startsWith("."))
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !fs.lstatSync(path.join(srcDir, entry.name)).isSymbolicLink())
    .filter((entry) => fs.existsSync(path.join(srcDir, entry.name, "SKILL.md")))
    .map((entry) => {
      if (!isSlug(entry.name)) throw new Error(`invalid skill directory name: ${entry.name}`);
      return entry.name;
    })
    .sort();
}

function jsonFiles(dir) {
  return filesByExt(dir, ".json");
}

function packageConfigFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => path.join(dir, entry.name, "package.config.json"))
    .filter((file) => fs.existsSync(file))
    .sort();
}

function markdownFiles(dir) {
  return filesByExt(dir, ".md");
}

function filesByExt(dir, ext) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(ext) && !entry.name.startsWith("."))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

function sameFile(a, b) {
  try {
    return fs.readFileSync(a, "utf8") === fs.readFileSync(b, "utf8");
  } catch {
    return false;
  }
}

function sameTree(a, b) {
  if (!fs.existsSync(a) || !fs.existsSync(b)) return false;
  const aFiles = treeFiles(a);
  const bFiles = treeFiles(b);
  if (aFiles.length !== bFiles.length) return false;
  return aFiles.every((file, index) => file === bFiles[index] && sameFile(path.join(a, file), path.join(b, file)));
}

function treeFiles(root, dir = root) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(root, abs);
    if (entry.isDirectory()) out.push(...treeFiles(root, abs));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

function readlinkSafe(target) {
  try {
    return fs.lstatSync(target).isSymbolicLink() ? fs.readlinkSync(target) : null;
  } catch {
    return null;
  }
}

function isSlug(value) {
  return /^[a-z0-9][a-z0-9-]*$/.test(String(value || ""));
}

if (isMainModule(import.meta.url)) {
  const dryRun = process.argv.includes("--dry-run");
  try {
    applyWorkspaceAssets({ dryRun });
  } catch (err) {
    console.error(err?.message || String(err));
    process.exit(1);
  }
}
