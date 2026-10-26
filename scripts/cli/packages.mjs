import fs from "node:fs";
import path from "node:path";
import { repoRoot, rootConfigActive, harnessHome, workspacePackagesDir, packageMode, initializeWorkspace } from "./paths.mjs";
import { renderHomeRules, knownHarnessIds, harnessIdsWithCapability } from "./rules-render.mjs";
import { forgetPackageIds, readEnabledPackagesRegistry, selectedRootIds, setPackageEnabled, effectiveEnabledIds, withPackageSelection } from "./package-state.mjs";
import { requiredBy, requiredClosure, rootsRequiring } from "./package-graph.mjs";
import { loadPackageCatalog, unavailablePackageMessage, validatePackageCatalog, BUILT_IN_PACKAGES_DIR, readPackageCategories } from "./package-catalog.mjs";
import { packageCommandNames, validatePackageCommandOwnership } from "./package-commands.mjs";
import { buildPackageLiveState } from "./package-probes.mjs";
import { packageStatusSummary } from "./package-status.mjs";
import { ensureClaudeMcpPermission } from "./mcp-claude.mjs";
import { configFileMcpProviders, ensureConfigFileMcp, removeConfigFileMcp } from "./mcp-config-file.mjs";
import { loadMcpPresets } from "./mcp-presets.mjs";
import { writeRootConfig } from "./root-config-writes.mjs";
import { hookFilePath, mergeHooksInto, unmergeHooksFrom, installHookScripts, removeHookScripts } from "./hook-composition.mjs";
import { installPackageRuntimeAsset, mergeHarnessConfig, removePackageRuntimeAsset, unmergeHarnessConfig } from "./package-harness-config.mjs";
import { installPackageCommands, removePackageCommands } from "./slash-commands.mjs";
import { cleanupPackageProjections } from "./package-projection-cleanup.mjs";
import { SKILL_TRIGGERS_FILE } from "./skill-trigger-fixtures.mjs";
import { getHarnessProvider } from "../harnesses/registry.mjs";
import { hasClaudeCli } from "../harnesses/claude/mcp-claude-cli.mjs";
import { assertHarnessWriteAllowed } from "./harness-write-guard.mjs";
import { confirmYesNo, makePrompter } from "./prompts.mjs";

export const USER_CLAUDE_SETTINGS = rootConfigActive.claude;
export const USER_CODEX_CONFIG = rootConfigActive.codex;

// Lazy: packages.mjs is imported by every CLI command (version, setup, rules, ...), not just ones
// that touch MCP presets. Loading eagerly at module scope meant any environment missing
// manifests/inventory/mcp-presets.json (e.g. a stripped-down package-mode app root) would exit(1)
// before an unrelated command even ran.
let mcpPresetsCache = null;
function getMcpPresets() {
  if (!mcpPresetsCache) mcpPresetsCache = loadMcpPresets();
  return mcpPresetsCache;
}


export function findPackage(pkgId) {
  return loadPackageCatalog().find((p) => p.id === pkgId) || null;
}

export function packageCommand(args = []) {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list":
      return listPackages(rest);
    case "inspect":
      return inspectPackage(rest);
    case "status":
      return printPackageStatus(rest);
    case "create":
      return createPackage(rest);
    case "add-skill":
      return addSkillToPackage(rest);
    case "enable":
      return enablePackageCommand(rest);
    case "disable":
      return disablePackageCommand(rest);
    case "validate":
      return validatePackages(rest);
    case "reconcile":
      return reconcileEnabledPackages(rest);
    case "adopt-live":
      return adoptLivePackages({ dryRun: rest.includes("--dry-run") });
    default:
      console.error("usage: roborepo package list|inspect|status|create|add-skill|enable|disable|validate|reconcile|adopt-live");
      process.exit(2);
  }
}

// `package enable|disable` from the terminal: once the change finishes, say whether any RoboRepo
// hook it rewrote now awaits review, and turn the result into an exit code (a refused mutation
// exits with its error's code, a blocked apply exits 1, a partial apply still exits 0 after its
// warning). Portal and onboarding changes report their own way, so this sits on the command, not
// inside enablePackage, which they also call.
export function enablePackageCommand(rest) {
  return withHookReviewHint(rest, async (changed) => {
    const result = await enablePackage(rest, changed);
    await offerRecommendations(result, rest, changed);
    return result;
  });
}

export function disablePackageCommand(rest) {
  return withHookReviewHint(rest, (changed) => disablePackage(rest, changed));
}

async function withHookReviewHint(rest, run) {
  const changed = new Set();
  let result;
  try {
    result = await run(changed);
  } catch (err) {
    if (!(err instanceof PackageMutationError)) throw err;
    console.error(err.message);
    process.exit(err.exitCode);
  }
  if (!rest.includes("--dry-run")) {
    const [{ hookHarnessesForPackages }, { printHookReviewHint }] = await Promise.all([
      import("./hook-readiness-status.mjs"), import("./hook-review-guidance.mjs"),
    ]);
    await printHookReviewHint(hookHarnessesForPackages(changed));
  }
  if (!result.ok) process.exit(1);
}

// Interactive terminals are asked about each recommendation the enable left off; a pipe, a script,
// or --dry-run only lists them. The package engine itself never prompts.
async function offerRecommendations(result, rest, changed) {
  if (!result.recommendations?.length) return;
  const interactive = process.stdin.isTTY && process.stdout.isTTY && !rest.includes("--dry-run");
  if (!interactive) {
    console.log(`recommended (not enabled): ${result.recommendations.map((rec) => rec.id).join(", ")}`);
    return;
  }
  const prompter = makePrompter();
  try {
    for (const rec of result.recommendations) {
      if (!(await confirmYesNo(prompter, `Also enable recommended package ${rec.label} (${rec.id})?`, false))) continue;
      const next = await enablePackage([rec.id], changed);
      result.outcomes.push(...next.outcomes);
      result.ok &&= next.ok;
    }
  } finally {
    prompter.close();
  }
}

function createPackage(rest) {
  const opts = parseCreateArgs(rest);
  // Mirrors skill-new.mjs: package mode scaffolds into the portable workspace; a development
  // checkout scaffolds directly into the real shared source (globals/packages/), matching where
  // `roborepo package validate`/the built-in catalog actually reads from.
  const packagesDir = packageMode ? workspacePackagesDir : BUILT_IN_PACKAGES_DIR;
  if (packageMode) initializeWorkspace();
  const packageDir = path.join(packagesDir, opts.id);
  const configPath = path.join(packageDir, "package.config.json");
  if (fs.existsSync(configPath)) throw new Error(`package already exists: ${opts.id}`);
  const config = packageTemplate(opts);
  fs.mkdirSync(packageDir, { recursive: true });
  for (const resource of config.resources) {
    if (resource.type === "skill") {
      const skillDir = path.join(packageDir, resource.source);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), skillBody(resource.id, config.description));
    } else if (resource.type === "slash-command") {
      const commandPath = path.join(packageDir, resource.source);
      fs.mkdirSync(path.dirname(commandPath), { recursive: true });
      fs.writeFileSync(commandPath, commandBody(resource.name, config.description));
    }
  }
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`created package: ${configPath}`);
  console.log(`next: roborepo package validate ${opts.id}`);
}

// Adds one skill to an existing package: its SKILL.md, the `skill` resource (placed after the
// package's other skills, so they stay ahead of rules and hooks), an optional slash-command
// entrypoint, and an empty trigger fixture for the author to fill. Ownership is left to
// validatePackageCatalog rather than re-checked here: the files are written, the catalog is
// validated, and any failure (a skill or command another package claims, among others) restores
// the package and reports the validation error.
function addSkillToPackage(rest) {
  const usage = "usage: roborepo package dev add-skill <package-id> <skill-id> [--command] [--description=<text>]";
  const { flags, positional } = parseFlags(rest);
  const [pkgId, skillId] = positional;
  if (!pkgId || !/^[a-z0-9][a-z0-9-]*$/.test(String(skillId || ""))) {
    console.error(usage);
    process.exit(2);
  }
  const catalog = loadPackageCatalog({ includeUnavailable: true });
  const pkg = catalog.find((entry) => entry.id === pkgId);
  if (!pkg) throw new Error(`unknown package: ${pkgId}`);
  if (packageMode && pkg.origin === "built-in") {
    throw new Error(`package ${pkgId} is built in; app files are not edited in package mode`);
  }
  const withCommand = flags.get("command") === "true";
  // validatePackageCatalog ignores a second claim by the same package, so a repeat inside this
  // package is refused here.
  if ((pkg.resources || []).some((r) => r.type === "skill" && r.id === skillId)) {
    throw new Error(`package ${pkgId} already has skill ${skillId}`);
  }

  const description = flags.get("description") || `${titleize(skillId)} skill.`;
  const configPath = pkg.sourceFile || path.join(pkg.sourceRoot, "package.config.json");
  const originalConfig = fs.readFileSync(configPath, "utf8");
  const config = JSON.parse(originalConfig);
  const skillsRoot = path.join(pkg.sourceRoot, "skills");
  const skillDir = path.join(skillsRoot, skillId);
  if (fs.existsSync(skillDir)) throw new Error(`skill directory already exists: ${skillDir}`);
  const createsSkillsRoot = !fs.existsSync(skillsRoot);
  const triggersPath = path.join(pkg.sourceRoot, SKILL_TRIGGERS_FILE);
  const originalTriggers = fs.existsSync(triggersPath) ? fs.readFileSync(triggersPath, "utf8") : null;

  const resource = withCommand
    ? {
        type: "skill",
        id: skillId,
        source: `skills/${skillId}`,
        invocation: "manual",
        risk: "medium",
        entrypoints: [{ type: "slash-command", name: skillId, description, harnesses: harnessIdsWithCapability("slash-commands") }],
      }
    : { type: "skill", id: skillId, source: `skills/${skillId}`, invocation: "auto", risk: "low" };
  const resources = config.resources || [];
  const lastSkill = resources.map((r) => r.type).lastIndexOf("skill");
  resources.splice(lastSkill + 1, 0, resource);
  config.resources = resources;

  const triggers = originalTriggers ? JSON.parse(originalTriggers) : { tests: [] };
  triggers.tests.push({ skill: skillId, match: [], nearMiss: [], triggerPhrases: [], skipPhrases: [] });

  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), skillBody(skillId, description));
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  fs.writeFileSync(triggersPath, `${JSON.stringify(triggers, null, 2)}\n`);
  try {
    validatePackageCatalog(loadPackageCatalog({ includeUnavailable: true }));
  } catch (error) {
    fs.writeFileSync(configPath, originalConfig);
    if (originalTriggers === null) fs.rmSync(triggersPath, { force: true });
    else fs.writeFileSync(triggersPath, originalTriggers);
    fs.rmSync(createsSkillsRoot ? skillsRoot : skillDir, { recursive: true, force: true });
    throw new Error(`package ${pkgId} did not validate with skill ${skillId}; nothing was changed: ${error.message}`);
  }
  console.log(`added skill ${skillId} to package ${pkgId}: ${path.join(skillDir, "SKILL.md")}`);
  // Only built-in packages get generated command wrappers, so a workspace package's command
  // entrypoint is declared but never installs.
  if (withCommand && pkg.origin === "built-in") console.log("next: roborepo skill render-commands");
  else if (withCommand) console.log(`note: /${skillId} will not install; only built-in packages get generated slash-command wrappers`);
  console.log(`then fill the ${skillId} trigger fixture in ${triggersPath} and run: roborepo skill triggers --check`);
}

function parseFlags(rest) {
  const flags = new Map();
  const positional = [];
  for (const arg of rest) {
    if (arg.startsWith("--") && arg.includes("=")) {
      const [key, value] = arg.slice(2).split(/=(.*)/s);
      flags.set(key, value);
    } else if (arg.startsWith("--")) {
      flags.set(arg.slice(2), "true");
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function parseCreateArgs(rest) {
  const { flags, positional } = parseFlags(rest);
  const id = positional[0] || flags.get("id") || flags.get("name");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(id || ""))) {
    console.error("usage: roborepo package dev create <id> [--kind=empty|auto-skill|skill-command|standalone-command] [--description=<text>] [--default-enabled=true]");
    process.exit(2);
  }
  return {
    id,
    kind: flags.get("kind") || "empty",
    description: flags.get("description") || `Custom package ${id}`,
    command: flags.get("command") || id,
    defaultEnabled: flags.get("default-enabled") === "true",
  };
}

function packageTemplate(opts) {
  const base = {
    schemaVersion: 1,
    id: opts.id,
    label: titleize(opts.id),
    description: opts.description,
    lifecycle: "optional",
    presentation: { category: opts.kind.includes("command") ? "skills-dev-lifecycle" : "code-conventions", order: 100 },
    resources: [],
  };
  if (opts.defaultEnabled) base.defaultEnabled = true;
  if (opts.kind === "auto-skill") {
    base.resources.push({ type: "skill", id: opts.id, source: `skills/${opts.id}`, invocation: "auto", risk: "low" });
  } else if (opts.kind === "skill-command") {
    base.resources.push({
      type: "skill",
      id: opts.id,
      source: `skills/${opts.id}`,
      invocation: "manual",
      risk: "medium",
      entrypoints: [
        { type: "slash-command", name: opts.command, description: opts.description, harnesses: harnessIdsWithCapability("slash-commands") },
      ],
    });
  } else if (opts.kind === "standalone-command") {
    base.resources.push({
      type: "slash-command",
      id: opts.command,
      name: opts.command,
      source: `commands/${opts.command}.md`,
      description: opts.description,
      harnesses: harnessIdsWithCapability("slash-commands"),
    });
  } else if (opts.kind !== "empty") {
    throw new Error(`unknown package template: ${opts.kind}`);
  }
  return base;
}

function titleize(id) {
  return id.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function skillBody(id, description) {
  return `---\nname: ${id}\ndescription: ${description}\n---\n\n# ${titleize(id)}\n\n${description}\n`;
}

function commandBody(name, description) {
  return `---\ndescription: ${description}\n---\n\n# /${name}\n\n${description}\n`;
}

function listPackages() {
  const catalog = loadPackageCatalog({ includeUnavailable: true });
  const states = buildPackageLiveState(catalog);
  const categories = readPackageCategories();
  const byCategory = new Map(categories.map((category) => [category.id, { ...category, packages: [] }]));
  for (const pkg of catalog) {
    const category = pkg.presentation.category;
    if (!byCategory.has(category)) byCategory.set(category, { id: category, label: titleize(category), order: 999, packages: [] });
    byCategory.get(category).packages.push(pkg);
  }

  console.log("Packages");
  for (const category of [...byCategory.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))) {
    if (category.packages.length === 0) continue;
    console.log(`\n${category.label}`);
    for (const pkg of category.packages.sort((a, b) => (a.presentation.order ?? 0) - (b.presentation.order ?? 0) || a.id.localeCompare(b.id))) {
      const status = states.get(pkg.id)?.status || "disabled";
      console.log(`  ${status.padEnd(8)} ${packageListLabel(pkg)}`);
    }
  }
}

function packageListLabel(pkg) {
  return pkg.label.toLowerCase() === titleize(pkg.id).toLowerCase()
    ? pkg.id
    : `${pkg.id} - ${pkg.label}`;
}

// Exits 0 for any known package whatever its state, so a caller branches on the printed status;
// exits 1 only when the id names no package at all.
function printPackageStatus(rest) {
  const json = rest.includes("--json");
  const [pkgId] = rest.filter((arg) => !arg.startsWith("--"));
  if (!pkgId) {
    console.error("usage: roborepo package status <package-id> [--json]");
    process.exit(2);
  }
  const summary = packageStatusSummary(pkgId);
  if (json) console.log(JSON.stringify(summary, null, 2));
  else console.log(`${summary.id}: ${summary.status}${summary.available ? "" : " (not available)"}`);
  if (summary.status === "missing") process.exit(1);
}

function inspectPackage(rest) {
  const [pkgId] = rest;
  if (!pkgId) {
    console.error("usage: roborepo package inspect <package-id>");
    process.exit(2);
  }
  const pkg = loadPackageCatalog({ includeUnavailable: true }).find((entry) => entry.id === pkgId);
  if (!pkg) {
    console.error(unavailablePackageMessage(pkgId));
    process.exit(2);
  }
  console.log(JSON.stringify({
    id: pkg.id,
    label: pkg.label,
    description: pkg.description,
    lifecycle: pkg.lifecycle,
    status: pkg.status || "available",
    presentation: pkg.presentation,
    requires: pkg.requires || [],
    resources: pkg.resources || [],
    sourceRoot: pkg.sourceRoot,
  }, null, 2));
}

function validatePackages(rest) {
  const catalog = loadPackageCatalog({ includeUnavailable: true });
  const [pkgId] = rest.filter((arg) => !arg.startsWith("--"));
  if (pkgId && !catalog.some((pkg) => pkg.id === pkgId)) {
    console.error(`unknown package: ${pkgId}`);
    process.exit(2);
  }
  validatePackageCatalog(catalog);
  console.log(pkgId ? `ok: package ${pkgId} valid` : `ok: ${catalog.length} package(s) valid`);
}

export function readSettings(settingsPath) {
  try { return JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch { return {}; }
}

export function writeSettings(settingsPath, settings) {
  writeRootConfig("claude", settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

function mergePermissions(settingsPath, allow) {
  const settings = readSettings(settingsPath);
  const existing = settings.permissions?.allow || [];
  const toAdd = allow.filter((p) => !existing.includes(p));
  if (toAdd.length === 0) { console.log("ok: permissions already present"); return; }
  settings.permissions = { ...settings.permissions, allow: [...existing, ...toAdd] };
  writeSettings(settingsPath, settings);
  console.log(`wired: ${toAdd.length} permissions → ${settingsPath}`);
}

function tomlTableKey(key) {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function codexToolApprovalTable(component, toolName) {
  return `[mcp_servers.${tomlTableKey(component.server)}.tools.${tomlTableKey(toolName)}]`;
}

function mergeCodexToolApprovals(configPath, component) {
  let text = "";
  try { text = fs.readFileSync(configPath, "utf8"); } catch {}
  let changed = false;
  for (const [toolName, approvalMode] of Object.entries(component.approvals || {})) {
    const table = codexToolApprovalTable(component, toolName);
    const tablePattern = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const blockPattern = new RegExp(`(^${tablePattern}\\n)([^[]*)`, "m");
    const nextLine = `approval_mode = ${JSON.stringify(approvalMode)}\n`;
    if (blockPattern.test(text)) {
      text = text.replace(blockPattern, (_match, header, body) => {
        if (/^approval_mode\s*=/m.test(body)) {
          const nextBody = body.replace(/^approval_mode\s*=.*$/m, nextLine.trim());
          if (nextBody !== body) changed = true;
          return `${header}${nextBody}`;
        }
        changed = true;
        return `${header}${nextLine}${body}`;
      });
    } else {
      text = `${text.endsWith("\n") ? text : `${text}\n`}\n${table}\n${nextLine}`;
      changed = true;
    }
  }
  if (changed) {
    writeRootConfig("codex", configPath, text);
    console.log(`wired: Codex tool approvals → ${configPath}`);
  } else {
    console.log(`ok: Codex tool approvals already present → ${configPath}`);
  }
}

function unmergeCodexToolApprovals(configPath, component) {
  let text = "";
  try { text = fs.readFileSync(configPath, "utf8"); } catch {}
  let changed = false;
  for (const toolName of Object.keys(component.approvals || {})) {
    const table = codexToolApprovalTable(component, toolName);
    const tablePattern = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const blockPattern = new RegExp(`\\n?^${tablePattern}\\n[^[]*(?=^\\[|$)`, "m");
    if (blockPattern.test(text)) {
      text = text.replace(blockPattern, (match) => {
        changed = true;
        return match.startsWith("\n") ? "\n" : "";
      });
    }
  }
  if (changed) {
    writeRootConfig("codex", configPath, text.replace(/\n{3,}/g, "\n\n"));
    console.log(`removed: Codex tool approvals ← ${configPath}`);
  } else {
    console.log(`ok: Codex tool approvals already absent ← ${configPath}`);
  }
}


function installMcpPreset(presetId) {
  // Wires a built-in package's own MCP preset. Registers Claude and every config-file-backed
  // provider (Codex, Gemini, ...) independently (mirroring removeMcpPreset below) instead of
  // delegating to a single `mcp add` subprocess: that combined path treats Claude CLI registration
  // and the config-file writes as all-or-nothing (see mcpAdd), so an environment without the
  // `claude` binary (e.g. CI) would silently skip the other writes too, even though they have no
  // external CLI dependency of their own. configFileMcpProviders() (scripts/cli/mcp.mjs) iterates
  // the registry rather than naming Codex/Gemini individually, so a future config-file-backed
  // provider is wired here with no change to this function.
  if (process.env.SKIP_MCP === "1") { console.log(`skip: mcp ${presetId} (SKIP_MCP)`); return; }
  const spec = getMcpPresets().get(presetId.toLowerCase());
  if (!spec) throw new Error(`mcp add failed for preset: ${presetId} (unknown preset)`);

  if (hasClaudeCli()) {
    if (getHarnessProvider("claude").adapters.mcp.list().includes(spec.name)) {
      console.log(`  ok: claude mcp ${spec.name} already present`);
    } else {
      const result = getHarnessProvider("claude").adapters.mcp.addServer(spec, { scope: "user", transport: null });
      if (!result.ok) throw new Error(`mcp add failed for preset: ${presetId}`);
      // The old subprocess call (`mcp add --builtin --only-claude`) never passed
      // --skip-claude-permission, so updateClaudePermission defaulted true -- preserve that grant.
      ensureClaudeMcpPermission(spec.name);
    }
  } else {
    console.log(`  ok: claude CLI unavailable for mcp ${presetId}`);
  }

  for (const provider of configFileMcpProviders()) ensureConfigFileMcp(provider, spec);
}

// Typed failure for a package mutation that cannot start: a usage error, an unknown package, an
// ownership conflict, or a disable the dependency rules refuse. Nothing has changed when it is
// thrown. The terminal commands print the message and exit with `exitCode`; the portal returns it.
export class PackageMutationError extends Error {
  constructor(message, { exitCode = 2 } = {}) {
    super(message);
    this.name = "PackageMutationError";
    this.exitCode = exitCode;
  }
}

function packageIdUsage(verb, catalog) {
  return `usage: roborepo package ${verb} <package-id>\navailable: ${catalog.filter((p) => p.selectable).map((p) => p.id).join(", ")}`;
}

function unknownPackageError(pkgId, catalog) {
  return new PackageMutationError(`${unavailablePackageMessage(pkgId)}\navailable: ${catalog.filter((p) => p.selectable).map((p) => p.id).join(", ")}`);
}

// A dependency-only package is controlled by the selectable packages that require it.
function notSelectableError(pkg, catalog, verb) {
  const controllers = requiredBy(catalog, pkg.id);
  const by = controllers.length ? `; it turns on and off with: ${controllers.join(", ")}` : "";
  return new PackageMutationError(`cannot ${verb} ${pkg.id} directly: it is a dependency-only package${by}`);
}

// One probed outcome per package whose effective state the mutation changed (or re-applied):
//   enabled  — wanted, and every component probes as present (or configured, for an off service)
//   partial  — some components probe as present and others as missing (or, after a disable, a
//              component is still there)
//   blocked  — applying stopped on an error before this package finished
//   disabled — not wanted, and nothing it owns probes as present
function probeOutcomes(catalog, ids, blocked) {
  const live = buildPackageLiveState(catalog);
  return ids.map((id) => {
    if (blocked.has(id)) return { id, outcome: "blocked", message: blocked.get(id), components: [] };
    const state = live.get(id);
    const components = state?.components || [];
    let outcome;
    if (state?.desired) outcome = state.status === "enabled" || state.status === "configured" ? "enabled" : "partial";
    else outcome = state?.status === "disabled" ? "disabled" : "partial";
    const missing = components.filter((c) => (state?.desired ? ["missing", "blocked"] : ["external"]).includes(c.state));
    return {
      id,
      outcome,
      message: outcome === "partial"
        ? `${state?.desired ? "missing" : "still present"}: ${missing.map((c) => `${c.type} ${c.id ?? ""}`.trim()).join(", ")}`
        : null,
      components,
    };
  });
}

function printOutcomes(outcomes) {
  for (const entry of outcomes) {
    const detail = entry.message ? ` (${entry.message})` : "";
    const line = `  ${entry.outcome}: ${entry.id}${detail}`;
    if (entry.outcome === "enabled" || entry.outcome === "disabled") console.log(line);
    else console.warn(line);
  }
}

// Apply each package in order (dependencies first), stopping at the first error. Packages the
// error stopped are recorded as blocked with that error.
async function applyInOrder(ids, catalog, run) {
  const blocked = new Map();
  for (const [index, id] of ids.entries()) {
    try {
      await run(catalog.find((p) => p.id === id));
    } catch (err) {
      const message = String(err?.message || err);
      blocked.set(id, message);
      for (const rest of ids.slice(index + 1)) blocked.set(rest, `not applied: ${id} failed`);
      break;
    }
  }
  return blocked;
}

// Enable records one selected root, then applies every package in its required closure,
// dependencies first. Dependencies become effective without being recorded as roots, so they
// turn off with the last selected package that requires them. Re-applying an already-effective
// dependency is idempotent and repairs a missing resource. Returns:
//   { ok, outcomes[], recommendations[], changedPackageIds[] }
// `changed` (optional) collects the ids whose resources were applied.
export async function enablePackage(rest, changed = new Set()) {
  const [pkgId, ...flags] = rest;
  const catalog = loadPackageCatalog();
  if (!pkgId) throw new PackageMutationError(packageIdUsage("enable", catalog));
  const dryRun = flags.includes("--dry-run");
  const pkg = catalog.find((p) => p.id === pkgId);
  if (!pkg) throw unknownPackageError(pkgId, catalog);
  if (!pkg.selectable) throw notSelectableError(pkg, catalog, "enable");
  if (!dryRun) assertHarnessWriteAllowed();

  const ownership = validatePackageCommandOwnership(pkg, { catalog, enabledIds: effectiveEnabledIds(catalog) });
  if (!ownership.ok) throw new PackageMutationError(ownership.message);

  const order = requiredClosure(catalog, [pkg.id]);
  if (dryRun) {
    console.log(`[dry-run] would enable: ${pkg.label}`);
    console.log(`  [dry-run] mark package selected in registry`);
    for (const id of order) {
      if (id !== pkg.id) console.log(`  [dry-run] would enable required package: ${id}`);
      await applyPackageComponents(catalog.find((p) => p.id === id), { dryRun: true });
    }
    return { ok: true, outcomes: [], recommendations: disabledRecommendations(pkg, catalog, order), changedPackageIds: [] };
  }

  console.log(`enabling: ${pkg.label}`);
  setPackageEnabled(pkg.id, true, loadPackageCatalog({ includeUnavailable: true }));
  const blocked = await applyInOrder(order, catalog, async (target) => {
    if (target.id !== pkg.id) console.log(`enabling required package: ${target.label}`);
    changed.add(target.id);
    await applyPackageComponents(target);
  });
  const outcomes = probeOutcomes(catalog, order, blocked);
  printOutcomes(outcomes);

  const commandNames = packageCommandNames(pkg);
  if (commandNames.length && !blocked.size) {
    console.log(`\ncli commands available: ${commandNames.map((c) => `roborepo ${c}`).join(", ")}`);
  }
  return {
    ok: blocked.size === 0,
    outcomes,
    recommendations: disabledRecommendations(pkg, catalog, effectiveEnabledIds(catalog)),
    changedPackageIds: [...changed],
  };
}

// Selectable recommendations of `pkg` that are not effective. Offered, never applied here: only
// the portal and the interactive terminal command ask the user.
function disabledRecommendations(pkg, catalog, effectiveIds) {
  const effective = new Set(effectiveIds);
  return (pkg.recommends || [])
    .map((id) => catalog.find((p) => p.id === id))
    .filter((dep) => dep && dep.selectable && !effective.has(dep.id))
    .map((dep) => ({ id: dep.id, label: dep.label, description: dep.description }));
}

// Apply one package's resources to every harness. Used by enable and by reconcile, which
// re-applies effective packages without touching the registry.
async function applyPackageComponents(pkg, { dryRun = false } = {}) {
  const servicePromises = [];
  for (const component of pkg.components) {
    switch (component.type) {
      case "mcp":
        if (dryRun) { console.log(`  [dry-run] mcp add ${component.preset}`); break; }
        installMcpPreset(component.preset);
        break;
      case "permissions":
        if (dryRun) { console.log(`  [dry-run] merge ${component.allow.length} permissions`); break; }
        mergePermissions(USER_CLAUDE_SETTINGS, component.allow);
        break;
      case "codex_tool_approvals":
        if (dryRun) { console.log(`  [dry-run] merge Codex tool approvals for ${component.server}`); break; }
        mergeCodexToolApprovals(USER_CODEX_CONFIG, component);
        break;
      case "rules": {
        if (dryRun) { console.log(`  [dry-run] register rules from ${component.source} (${component.harness})`); break; }
        renderHomeRules({ harness: component.harness === "both" ? undefined : component.harness });
        break;
      }
      case "command":
        if (dryRun) { console.log(`  [dry-run] register command ${component.name}`); }
        break;
      case "hooks": {
        const hooksPath = path.join(repoRoot, component.source);
        if (dryRun) {
          console.log(`  [dry-run] merge hooks from ${component.source} (${component.harness})`);
          if (component.scripts?.length) installHookScripts(component.harness, component.scripts, repoRoot, { dryRun: true });
          break;
        }
        const hooksFragment = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
        const targetPath = hookFilePath(component.harness, { rootConfigPath: rootConfigActive[component.harness] });
        if (targetPath) mergeHooksInto(component.harness, targetPath, hooksFragment);
        if (component.scripts?.length) installHookScripts(component.harness, component.scripts, repoRoot);
        break;
      }
      case "plugin":
        if (dryRun) { console.log(`  [dry-run] enable plugin ${component.id}`); break; }
        enablePlugin(USER_CLAUDE_SETTINGS, component);
        break;
      case "service":
        if (dryRun) { console.log(`  [dry-run] enable service ${component.id}`); break; }
        servicePromises.push(setService(component.id, true));
        break;
      case "package-runtime-asset":
        installPackageRuntimeAsset(pkg, component, { dryRun });
        break;
      case "harness-config":
        if (dryRun) { console.log(`  [dry-run] merge harness config ${component.source} (${component.harness})`); break; }
        mergeHarnessConfig(pkg, component, {
          claudeSettingsPath: USER_CLAUDE_SETTINGS,
          codexConfigPath: USER_CODEX_CONFIG,
          readSettings,
          writeSettings,
        });
        break;
      case "skill":
        if (dryRun) {
          console.log(`  [dry-run] install skill ${component.id}`);
          for (const harnessName of knownHarnessIds()) {
            installPackageCommands(pkg, harnessHome[harnessName], harnessName, { dryRun: true });
          }
          break;
        }
        servicePromises.push(setSkillComponent(component.id, true));
        for (const harnessName of knownHarnessIds()) {
          installPackageCommands(pkg, harnessHome[harnessName], harnessName);
        }
        break;
      default:
        console.log(`  skip: unknown component type: ${component.type}`);
    }
  }
  // Service/skill components run async handlers (lazy-imported to avoid import cycles); await them so
  // the function doesn't resolve before the side effects land.
  if (servicePromises.length) await Promise.all(servicePromises);

}

export async function reconcileEnabledPackages(rest = []) {
  const dryRun = rest.includes("--dry-run");
  if (!dryRun) assertHarnessWriteAllowed();
  const catalog = loadPackageCatalog({ includeUnavailable: true });
  const enabledIds = effectiveEnabledIds(catalog);
  const known = new Set(catalog.map((pkg) => pkg.id));
  // A retired or renamed package can sit in either registry list. Both are dropped, not moved to
  // `disabled`: the catalog no longer has the package, so there is nothing left to disable.
  const registry = readEnabledPackagesRegistry();
  const stale = [...new Set([...registry.packages, ...registry.disabled])].filter((id) => !known.has(id));
  for (const id of stale) {
    console.warn(`${dryRun ? "  [dry-run] would remove" : "  remove"} stale package not in catalog: ${id}`);
  }
  let reconciled = 0;
  const changedPackageIds = new Set();
  // Effective ids come dependencies first, so a package is never re-applied ahead of what it needs.
  for (const id of enabledIds) {
    const pkg = catalog.find((entry) => entry.id === id);
    if (!pkg) continue;
    console.log(dryRun ? `[dry-run] would reconcile: ${pkg.label}` : `reconcile: ${pkg.label}`);
    await applyPackageComponents(pkg, { dryRun });
    changedPackageIds.add(id);
    reconciled++;
  }
  if (reconciled === 0) console.log("reconcile: no enabled packages");
  cleanupPackageProjections({ dryRun });
  if (!dryRun) forgetPackageIds(stale);
  return [...changedPackageIds];
}

export function adoptLivePackages({ dryRun = false } = {}) {
  const catalog = loadPackageCatalog({ includeUnavailable: true });
  const liveState = buildPackageLiveState(catalog);
  // Effective, not raw registry: a default-enabled package is already known-desired and should
  // never be offered for adoption even if its live state happens to look external.
  const alreadyEnabled = new Set(effectiveEnabledIds(catalog));
  const adopters = [];

  for (const pkg of catalog) {
    if (alreadyEnabled.has(pkg.id)) continue;
    const state = liveState.get(pkg.id);
    const adoptable = (state?.components || []).some((component) =>
      component.state === "external" &&
      !["mcp", "command", "requires"].includes(component.type)
    );
    if (adoptable) adopters.push(pkg.id);
  }

  if (adopters.length === 0) {
    console.log("adopt-live: no live packages to adopt");
    return [];
  }

  if (dryRun) {
    console.log(`adopt-live: would mark enabled packages: ${adopters.join(", ")}`);
    return adopters;
  }

  for (const id of adopters) setPackageEnabled(id, true);
  console.log(`adopt-live: marked enabled packages: ${adopters.join(", ")}`);
  return adopters;
}

// --------------------------------------------------------------------------- disable (reversal)

function unmergePermissions(settingsPath, allow) {
  const settings = readSettings(settingsPath);
  const existing = settings.permissions?.allow || [];
  const toRemove = new Set(allow);
  const next = existing.filter((p) => !toRemove.has(p));
  if (next.length === existing.length) { console.log("ok: permissions already absent"); return; }
  settings.permissions = { ...settings.permissions, allow: next };
  writeSettings(settingsPath, settings);
  console.log(`removed: ${existing.length - next.length} permissions ← ${settingsPath}`);
}

function removeMcpPreset(presetId, dryRun) {
  if (dryRun) { console.log(`  [dry-run] mcp remove ${presetId}`); return; }
  // mcp.removeServer already does the same all-scope sweep + ~/.claude.json prune as the
  // pruneClaudeMcpStore/multi-scope-remove pair this replaces (see mcpRemoveServer in
  // scripts/harnesses/claude/index.mjs) -- including its own internal CLI-availability check, so
  // the ~/.claude.json prune still runs even when the `claude` binary is absent, matching the
  // original's unconditional pruneClaudeMcpStore call.
  getHarnessProvider("claude").adapters.mcp.removeServer(presetId, { homePath: harnessHome.claude });
  console.log(`  removed: mcp ${presetId} from Claude scopes`);
  for (const provider of configFileMcpProviders()) removeConfigFileMcp(provider, presetId);
}

// Disable removes selected roots, then removes the resources of every package that left the
// effective set, dependents first:
//   - a selected root is deselected; if a selected parent still requires it, it stays effective
//     and the result names the parents keeping it on
//   - a package effective only because a parent requires it has no root to remove, so it is
//     refused; --cascade deselects those parents first and it turns off with them
//   - --cascade on a root that a parent also requires deselects those parents too
// Returns { ok, outcomes[], keptOnBy[], changedPackageIds[] }. `changed` (optional) collects the ids
// whose resources were removed.
export async function disablePackage(rest, changed = new Set()) {
  const [pkgId, ...flags] = rest;
  const catalog = loadPackageCatalog({ includeUnavailable: true });
  if (!pkgId) throw new PackageMutationError(packageIdUsage("disable", catalog));
  const pkg = findPackage(pkgId);
  if (!pkg) throw unknownPackageError(pkgId, catalog);
  if (!pkg.selectable) throw notSelectableError(pkg, catalog, "disable");

  const dryRun = flags.includes("--dry-run");
  const cascade = flags.includes("--cascade");
  const roots = selectedRootIds(catalog);
  const isRoot = roots.includes(pkg.id);
  const keepers = rootsRequiring(catalog, pkg.id, roots);
  if (!isRoot && keepers.length && !cascade) {
    throw new PackageMutationError(
      `cannot disable ${pkg.id}; it is on because selected packages require it: ${keepers.join(", ")}\n` +
      `rerun with --cascade to disable them too`,
    );
  }
  if (!dryRun) assertHarnessWriteAllowed();

  const deselect = [...(isRoot || !keepers.length ? [pkg.id] : []), ...(cascade ? keepers : [])];
  const registry = readEnabledPackagesRegistry();
  const nextRegistry = deselect.reduce((next, id) => withPackageSelection(catalog, next, id, false), registry);
  const before = effectiveEnabledIds(catalog, registry);
  const afterSet = new Set(effectiveEnabledIds(catalog, nextRegistry));
  // Dependents before their dependencies; the target itself is always cleaned when it ends up off,
  // so re-disabling an already-off package still removes anything it left behind.
  const order = [...new Set([...before.filter((id) => !afterSet.has(id)), ...(afterSet.has(pkg.id) ? [] : [pkg.id])])]
    .filter((id) => catalog.some((p) => p.id === id))
    .reverse();
  const keptOnBy = afterSet.has(pkg.id) ? rootsRequiring(catalog, pkg.id, selectedRootIds(catalog, nextRegistry)) : [];

  if (dryRun) {
    console.log(`[dry-run] would disable: ${pkg.label}`);
    for (const id of deselect) console.log(`  [dry-run] mark ${id} deselected in registry`);
    for (const id of order) await removePackageComponents(catalog.find((p) => p.id === id), { dryRun: true });
    if (keptOnBy.length) console.log(`  [dry-run] ${pkg.id} would stay on: required by ${keptOnBy.join(", ")}`);
    return { ok: true, outcomes: [], keptOnBy, changedPackageIds: [] };
  }

  console.log(`disabling: ${pkg.label}`);
  for (const id of deselect) setPackageEnabled(id, false, catalog);
  const blocked = await applyInOrder(order, catalog, async (target) => {
    if (target.id !== pkg.id) console.log(`disabling ${deselect.includes(target.id) ? "dependent" : "no longer required"} package: ${target.label}`);
    changed.add(target.id);
    await removePackageComponents(target);
  });
  const outcomes = probeOutcomes(catalog, order, blocked);
  printOutcomes(outcomes);
  if (keptOnBy.length) console.log(`  ${pkg.id} stays on: required by ${keptOnBy.join(", ")}`);
  return { ok: blocked.size === 0, outcomes, keptOnBy, changedPackageIds: [...changed] };
}

// Remove one package's resources from every harness.
async function removePackageComponents(pkg, { dryRun = false } = {}) {
  const servicePromises = [];
  for (const component of pkg.components) {
    switch (component.type) {
      case "mcp":
        removeMcpPreset(component.preset, dryRun);
        break;
      case "permissions":
        if (dryRun) { console.log(`  [dry-run] remove ${component.allow.length} permissions`); break; }
        unmergePermissions(USER_CLAUDE_SETTINGS, component.allow);
        break;
      case "codex_tool_approvals":
        if (dryRun) { console.log(`  [dry-run] remove Codex tool approvals for ${component.server}`); break; }
        unmergeCodexToolApprovals(USER_CODEX_CONFIG, component);
        break;
      case "rules": {
        if (dryRun) { console.log(`  [dry-run] deregister rules from ${component.source} (${component.harness})`); break; }
        renderHomeRules({ harness: component.harness === "both" ? undefined : component.harness });
        break;
      }
      case "command":
        if (dryRun) { console.log(`  [dry-run] deregister command ${component.name}`); }
        break;
      case "hooks": {
        if (dryRun) {
          console.log(`  [dry-run] remove hooks from ${component.source} (${component.harness})`);
          if (component.scripts?.length) removeHookScripts(component.harness, component.scripts, repoRoot, { dryRun: true });
          break;
        }
        const hooksFragment = JSON.parse(fs.readFileSync(path.join(repoRoot, component.source), "utf8"));
        const targetPath = hookFilePath(component.harness, { rootConfigPath: rootConfigActive[component.harness] });
        if (targetPath) unmergeHooksFrom(component.harness, targetPath, hooksFragment);
        if (component.scripts?.length) removeHookScripts(component.harness, component.scripts, repoRoot);
        break;
      }
      case "plugin":
        if (dryRun) { console.log(`  [dry-run] disable plugin ${component.id}`); break; }
        disablePlugin(USER_CLAUDE_SETTINGS, component);
        break;
      case "service":
        if (dryRun) { console.log(`  [dry-run] disable service ${component.id}`); break; }
        servicePromises.push(setService(component.id, false));
        break;
      case "harness-config":
        if (dryRun) { console.log(`  [dry-run] remove harness config ${component.source} (${component.harness})`); break; }
        unmergeHarnessConfig(pkg, component, {
          claudeSettingsPath: USER_CLAUDE_SETTINGS,
          codexConfigPath: USER_CODEX_CONFIG,
          readSettings,
          writeSettings,
        });
        break;
      case "package-runtime-asset":
        removePackageRuntimeAsset(pkg, component, { dryRun });
        break;
      case "skill":
        if (dryRun) {
          console.log(`  [dry-run] remove skill ${component.id}`);
          for (const harnessName of knownHarnessIds()) {
            removePackageCommands(pkg, harnessHome[harnessName], harnessName, { dryRun: true });
          }
          break;
        }
        servicePromises.push(setSkillComponent(component.id, false));
        for (const harnessName of knownHarnessIds()) {
          removePackageCommands(pkg, harnessHome[harnessName], harnessName);
        }
        break;
      default:
        console.log(`  skip: unknown component type: ${component.type}`);
    }
  }
  if (servicePromises.length) await Promise.all(servicePromises);
}

// --------------------------------------------------------------------------- service component
//
// A service component delegates to a registered async handler that owns the feature's bespoke
// install (state file, hooks, server, …) — telemetry is the first. Handlers are lazy-imported so
// packages.mjs has no static dependency on (and no import cycle with) the feature modules. Adding a
// new service = register its { id → loader } here; the package model itself stays generic.
const SERVICE_HANDLERS = {
  telemetry: async () => (await import("./telemetry.mjs")).setTelemetryEnabled,
};

async function setService(id, enabled) {
  const loader = SERVICE_HANDLERS[id];
  if (!loader) { console.log(`  skip: unknown service: ${id}`); return; }
  const handler = await loader();
  const result = handler(enabled);
  if (result?.message) console.log(`  ${result.message}`);
  return result;
}

// Skill component: link/unlink a shared skill into the harness skill dirs. setSkillInstalled lives
// in config-mutate.mjs (which imports this module), so it's lazy-imported to avoid the cycle.
async function setSkillComponent(id, enabled) {
  const { setSkillInstalled } = await import("./config-mutate.mjs");
  const result = setSkillInstalled(id, enabled);
  if (result?.message) console.log(`  ${result.message}`);
  return result;
}

// --------------------------------------------------------------------------- plugin component
//
// A plugin component owns two settings keys: extraKnownMarketplaces[<marketplace.name>] (so the
// harness knows where to fetch it) and enabledPlugins[<id>] (the on/off bool). enable writes both;
// the harness performs the actual download on its next launch — we can't fetch it from here, so a
// freshly enabled plugin shows as enabled but only takes effect once the harness installs it.
// disable flips the bool to false and removes our marketplace entry, leaving any already-downloaded
// plugin files for the harness to clean up.

function enablePlugin(settingsPath, component) {
  const settings = readSettings(settingsPath);
  let changed = false;

  if (component.marketplace?.name) {
    settings.extraKnownMarketplaces ||= {};
    if (!settings.extraKnownMarketplaces[component.marketplace.name]) {
      settings.extraKnownMarketplaces[component.marketplace.name] = { source: component.marketplace.source };
      changed = true;
    }
  }

  settings.enabledPlugins ||= {};
  if (settings.enabledPlugins[component.id] !== true) {
    settings.enabledPlugins[component.id] = true;
    changed = true;
  }

  if (changed) {
    writeSettings(settingsPath, settings);
    console.log(`  plugin enabled: ${component.id} → ${settingsPath}`);
    console.log(`  note: the harness installs the plugin from the marketplace on its next launch`);
  } else {
    console.log(`  ok: plugin ${component.id} already enabled`);
  }
}

function disablePlugin(settingsPath, component) {
  const settings = readSettings(settingsPath);
  let changed = false;

  if (settings.enabledPlugins && component.id in settings.enabledPlugins) {
    delete settings.enabledPlugins[component.id];
    changed = true;
  }
  if (component.marketplace?.name && settings.extraKnownMarketplaces?.[component.marketplace.name]) {
    delete settings.extraKnownMarketplaces[component.marketplace.name];
    changed = true;
  }

  if (changed) {
    writeSettings(settingsPath, settings);
    console.log(`  plugin disabled: ${component.id} ← ${settingsPath}`);
  } else {
    console.log(`  ok: plugin ${component.id} already absent`);
  }
}
