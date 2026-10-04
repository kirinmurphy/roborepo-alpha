import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { repoRoot, rootConfigActive, harnessHome, workspacePackagesDir, packageMode, initializeWorkspace } from "./paths.mjs";
import { forgetPackageIds, readEnabledPackagesRegistry, setPackageEnabled, renderHomeRules, effectiveEnabledIds, knownHarnessIds, harnessIdsWithCapability } from "./rules-render.mjs";
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
import { getHarnessProvider } from "../harnesses/registry.mjs";

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
    case "enable":
      return enablePackage(rest);
    case "disable":
      return disablePackage(rest);
    case "validate":
      return validatePackages(rest);
    case "reconcile":
      return reconcileEnabledPackages(rest);
    case "adopt-live":
      return adoptLivePackages({ dryRun: rest.includes("--dry-run") });
    default:
      console.error("usage: roborepo package list|inspect|status|create|enable|disable|validate|reconcile|adopt-live");
      process.exit(2);
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

function parseCreateArgs(rest) {
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

  if (spawnSync("claude", ["--version"], { encoding: "utf8" }).status === 0) {
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

export async function enablePackage(rest, _seen = new Set()) {
  const [pkgId, ...flags] = rest;
  if (!pkgId) {
    console.error("usage: roborepo package enable <package-id>");
    const catalog = loadPackageCatalog();
    console.error(`available: ${catalog.map((p) => p.id).join(", ")}`);
    process.exit(2);
  }

  const dryRun = flags.includes("--dry-run");
  const reconcile = flags.includes("--reconcile");
  const catalog = loadPackageCatalog({ includeUnavailable: reconcile });
  const pkg = catalog.find((p) => p.id === pkgId);
  if (!pkg) {
    console.error(unavailablePackageMessage(pkgId));
    console.error(`available: ${catalog.map((p) => p.id).join(", ")}`);
    process.exit(2);
  }

  if (_seen.has(pkg.id)) return; // already handled in this enable pass (cycle / shared dependency)
  _seen.add(pkg.id);

  const enabledIds = effectiveEnabledIds(catalog);
  const ownership = validatePackageCommandOwnership(pkg, { catalog, enabledIds });
  if (!ownership.ok) {
    console.error(ownership.message);
    process.exit(2);
  }

  // A package can compose others via `requires`: enable its dependencies first (deduped, cycle-safe).
  // A composite package (one with `requires`) bundles the component-packages it depends on. NOTE:
  // distinct from an install "bundle" (manifests/platform/presets.json), which groups file-copy rows
  // at install time — composition here is runtime feature enablement.
  for (const depId of pkg.requires ?? []) {
    if (!catalog.find((p) => p.id === depId)) {
      console.warn(`  warn: ${pkg.id} requires unknown package: ${depId}`);
      continue;
    }
    await enablePackage([depId, ...flags], _seen);
  }

  if (dryRun) { console.log(`[dry-run] would enable: ${pkg.label}`); }
  else { console.log(reconcile ? `reconcile: ${pkg.label}` : `enabling: ${pkg.label}`); }

  if (dryRun) {
    console.log(`  [dry-run] mark package enabled in registry`);
  } else if (!reconcile) {
    setPackageEnabled(pkg.id, true);
  }

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
        const targetPath = hookFilePath(component.harness, { claudeSettingsPath: USER_CLAUDE_SETTINGS });
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

  if (!dryRun && !reconcile) {
    const commandNames = packageCommandNames(pkg);
    if (commandNames.length) {
      console.log(`\ncli commands available: ${commandNames.map((c) => `roborepo ${c}`).join(", ")}`);
    }
  }
}

export async function reconcileEnabledPackages(rest = []) {
  const dryRun = rest.includes("--dry-run");
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
  for (const id of enabledIds) {
    if (!known.has(id)) continue;
    await enablePackage([id, "--reconcile", ...(dryRun ? ["--dry-run"] : [])]);
    reconciled++;
  }
  if (reconciled === 0) console.log("reconcile: no enabled packages");
  cleanupPackageProjections({ dryRun });
  if (!dryRun) forgetPackageIds(stale);
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

export async function disablePackage(rest) {
  const [pkgId, ...flags] = rest;
  if (!pkgId) {
    console.error("usage: roborepo package disable <package-id>");
    console.error(`available: ${loadPackageCatalog().map((p) => p.id).join(", ")}`);
    process.exit(2);
  }
  const pkg = findPackage(pkgId);
  if (!pkg) {
    console.error(unavailablePackageMessage(pkgId));
    console.error(`available: ${loadPackageCatalog().map((p) => p.id).join(", ")}`);
    process.exit(2);
  }

  const dryRun = flags.includes("--dry-run");
  const cascade = flags.includes("--cascade");
  const catalog = loadPackageCatalog({ includeUnavailable: true });
  const dependents = enabledDependents(pkg.id, catalog);
  if (dependents.length > 0 && !cascade) {
    console.error(`cannot disable ${pkg.id}; enabled packages depend on it: ${dependents.join(", ")}`);
    console.error(`rerun with --cascade to disable dependents first`);
    process.exit(2);
  }
  if (cascade) {
    for (const dependent of [...dependents].reverse()) {
      await disablePackage([dependent, ...flags.filter((flag) => flag !== "--cascade"), "--cascade"]);
    }
  }
  console.log(dryRun ? `[dry-run] would disable: ${pkg.label}` : `disabling: ${pkg.label}`);
  if (dryRun) {
    console.log(`  [dry-run] mark package disabled in registry`);
  } else {
    setPackageEnabled(pkg.id, false);
  }

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
        const targetPath = hookFilePath(component.harness, { claudeSettingsPath: USER_CLAUDE_SETTINGS });
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

function enabledDependents(pkgId, catalog) {
  const enabled = new Set(effectiveEnabledIds(catalog));
  const direct = catalog
    .filter((pkg) => enabled.has(pkg.id) && (pkg.requires || []).includes(pkgId))
    .map((pkg) => pkg.id);
  const out = new Set(direct);
  for (const id of direct) {
    for (const nested of enabledDependents(id, catalog)) out.add(nested);
  }
  return [...out];
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