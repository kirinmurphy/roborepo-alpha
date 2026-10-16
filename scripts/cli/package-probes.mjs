import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { harnessHome, repoRoot, rootConfigActive } from "./paths.mjs";
import { hookFilePath } from "./hook-composition.mjs";
import { compareHookReadiness, fragmentHooks } from "../harnesses/hook-readiness.mjs";
import { hookRecordsFromFile } from "../harnesses/root-config-hooks.mjs";
import { getHarnessProvider } from "../harnesses/registry.mjs";
import { stateSkillsDir, telemetryDir } from "./state-paths.mjs";
import { codexStatusLineIncludes, readHarnessConfig, packageRuntimeAssetDestination } from "./package-harness-config.mjs";
import { effectiveEnabledIds, knownHarnessIds } from "./rules-render.mjs";

const CLAUDE_SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
const CODEX_CONFIG = path.join(os.homedir(), ".codex", "config.toml");
const LIVE_RULE_FILES = {
  claude: path.join(os.homedir(), ".claude", "CLAUDE.md"),
  codex: path.join(os.homedir(), ".codex", "AGENTS.md"),
};

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function readText(filePath, fallback = "") {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return fallback;
  }
}

function firstNonblankLine(relPath) {
  const content = readText(path.join(repoRoot, relPath), "");
  return content.split("\n").find((line) => line.trim()) || "";
}

// True when a boolean scalar under [tui] equals `value` in live Codex config. Mirrors the writer in
// scripts/harnesses/codex/index.mjs (setTomlScalar, behind the Codex provider's
// rootConfig.mergePackageComponent) — scoped to the [tui] block so an unrelated same-named key
// elsewhere can't produce a false match.
function codexScalarMatches(configText, key, value) {
  const block = configText.match(/^\[tui\]\s*\n([\s\S]*?)(?=^\[|\s*$)/m);
  if (!block) return false;
  return new RegExp(`^${key}\\s*=\\s*${value ? "true" : "false"}\\b`, "m").test(block[1]);
}

// "both" is a legacy sentinel meaning "every harness", from when there were exactly two. Every
// other consumer already treats it that way (rules-render.mjs and context-cost.mjs match it against
// any harness; packages.mjs maps it to renderHomeRules's all-harnesses form), so it must expand to
// the full registry here too — expanding it to a literal pair silently skipped probing a
// "both"-declared component's live state on any third harness.
function targetHarnesses(component) {
  if (component.harness === "both" || !component.harness) return knownHarnessIds();
  return [component.harness];
}

function foldComponentState({ desired, observed, blocked = false, inactive = false }) {
  if (blocked) return "blocked";
  // "inactive" = desired and correctly installed, but a runtime service the user has deliberately
  // turned off (e.g. telemetry capture disabled). This is NOT a broken install, so it must fold to
  // its own state rather than "missing" — otherwise an administratively-off service looks identical
  // to a genuinely absent one and the package reads as "partial" (see packageStatus).
  if (desired && inactive) return "inactive";
  if (desired && observed) return "present";
  if (desired && !observed) return "missing";
  if (!desired && observed) return "external";
  return "absent";
}

function componentResult(component, { desired, observed, owner = "unknown", detail = null, blocked = false, inactive = false }) {
  return {
    type: component.type,
    id: component.id || component.name || component.preset || component.source || null,
    desired,
    observed,
    owner: observed ? owner : null,
    state: foldComponentState({ desired, observed, blocked, inactive }),
    detail,
  };
}

function probeRules(component, desired) {
  const signature = firstNonblankLine(component.source);
  const observedHarnesses = targetHarnesses(component).filter((harness) => {
    const live = readText(LIVE_RULE_FILES[harness], "");
    return !!signature && live.includes(signature);
  });
  return componentResult(component, {
    desired,
    observed: observedHarnesses.length > 0,
    owner: desired ? "roborepo" : "external",
    detail: observedHarnesses.length ? `rendered in ${observedHarnesses.join(", ")}` : "rules fragment not found in live files",
  });
}

function probeCommand(component, desired) {
  return componentResult(component, {
    desired,
    observed: desired,
    owner: desired ? "roborepo" : null,
    detail: desired ? "command is enabled through package registry" : "command is registry-gated",
  });
}

// `hookRecords` (harness id -> hooks.read records) carries trust state from callers that already
// awaited the provider's read. Without it, the installed entries are read from the hook file and
// trust stays "unknown": package status is synchronous and must not spawn a harness runtime.
function probeHooks(component, desired, hookRecords) {
  const hooksPath = hookFilePath(component.harness, { rootConfigPath: rootConfigActive[component.harness] });
  const observed = hookRecords?.get(component.harness)
    ?? hookRecordsFromFile(hooksPath, { trust: "unknown" });
  const expected = fragmentHooks(readJson(path.join(repoRoot, component.source), {}));
  const { state, groups } = compareHookReadiness(
    [{ owner: component.source, label: component.source, hooks: expected }], observed, { hooksPath });
  const found = (groups[0]?.hooks || []).filter((hook) => hook.state !== "missing").length;
  const scripts = component.scripts || [];
  const scriptsPresent = scripts.every((relPath) =>
    fs.existsSync(path.join(harnessHome[component.harness], "hooks", path.basename(relPath))));
  return componentResult(component, {
    desired,
    observed: expected.length > 0 && found === expected.length && scriptsPresent,
    owner: desired ? "roborepo" : "external",
    detail: hookProbeDetail({ state, found, expected: expected.length, scriptsPresent, harness: component.harness }),
  });
}

function hookProbeDetail({ state, found, expected, scriptsPresent, harness }) {
  const counts = `${found}/${expected} hook command(s) present`;
  if (!scriptsPresent) return `${counts}, script file(s) missing`;
  if (state === "review_required") return `${counts}, awaiting review in ${harnessDisplayName(harness)}`;
  if (state === "inactive") return `${counts}, disabled in ${harnessDisplayName(harness)}`;
  if (state === "active") return `${counts}, active`;
  return counts;
}

function harnessDisplayName(harness) {
  return getHarnessProvider(harness).manifest.displayName;
}

function probePermissions(component, desired, settings) {
  const allow = settings.permissions?.allow || [];
  const missing = (component.allow || []).filter((entry) => !allow.includes(entry));
  return componentResult(component, {
    desired,
    observed: missing.length === 0,
    owner: desired ? "roborepo" : "external",
    detail: missing.length ? `${missing.length} permission(s) missing` : `${(component.allow || []).length} permission(s) present`,
  });
}

function probeCodexToolApprovals(component, desired) {
  const config = readText(CODEX_CONFIG, "");
  const missing = Object.entries(component.approvals || {}).filter(([toolName, approvalMode]) => {
    const server = component.server.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const tool = toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const mode = String(approvalMode).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return !new RegExp(`^\\[mcp_servers\\.${server}\\.tools\\.${tool}\\]\\s*\\napproval_mode\\s*=\\s*"${mode}"`, "m").test(config);
  });
  return componentResult(component, {
    desired,
    observed: missing.length === 0,
    owner: desired ? "roborepo" : "external",
    detail: missing.length ? `${missing.length} Codex tool approval(s) missing` : `${Object.keys(component.approvals || {}).length} Codex tool approval(s) present`,
  });
}

function probePlugin(component, desired, settings) {
  const observed = settings.enabledPlugins?.[component.id] === true;
  return componentResult(component, {
    desired,
    observed,
    owner: desired ? "roborepo" : "external",
    detail: observed ? "enabled in Claude settings" : "not enabled in Claude settings",
  });
}

function probeMcp(component, desired, settings) {
  const name = component.preset;
  const codexConfig = readText(CODEX_CONFIG, "");
  const observed =
    !!settings.mcpServers?.[name] ||
    codexConfig.includes(`[mcp_servers.${name}]`) ||
    codexConfig.includes(`[mcp_servers."${name}"]`);
  return componentResult(component, {
    desired,
    observed,
    owner: desired ? "roborepo" : "external",
    detail: observed ? "MCP preset found in live config" : "MCP preset not found in live config",
  });
}

function probeService(component, desired, telemetryState) {
  const isTelemetry = component.id === "telemetry";
  const observed = isTelemetry ? telemetryState?.enabled === true : false;
  // A telemetry service that is desired and has a state file but reads enabled:false is
  // administratively OFF, not broken — the user simply hasn't started capture. Report it as
  // "inactive" (an actionable, non-alarming state) rather than folding it into "missing", which
  // would drag the package status down to "partial" and read like a failed install.
  const inactive = isTelemetry && desired && !observed && telemetryState != null;
  return componentResult(component, {
    desired,
    observed,
    inactive,
    owner: observed ? "roborepo" : null,
    detail: observed
      ? "service state enabled"
      : inactive
        ? "service installed but capture is turned off (roborepo web to start)"
        : "service state missing",
  });
}

function probePackageRuntimeAsset(component, desired, pkg) {
  const dest = packageRuntimeAssetDestination(pkg, component);
  const observed = fs.existsSync(dest);
  return componentResult(component, {
    desired,
    observed,
    owner: observed ? "roborepo" : null,
    detail: observed ? `package-runtime asset present: ${dest}` : `package-runtime asset missing: ${dest}`,
  });
}

function probeHarnessConfig(component, desired, settings, pkg) {
  const config = readHarnessConfig(component, pkg);
  if (component.harness === "claude") {
    const observed = JSON.stringify(settings.statusLine || null) === JSON.stringify(config.statusLine || null);
    return componentResult(component, {
      desired,
      observed,
      owner: observed ? "roborepo" : settings.statusLine ? "external" : null,
      detail: observed ? "Claude statusLine matches package config" : settings.statusLine ? "Claude statusLine is unmanaged" : "Claude statusLine missing",
    });
  }
  if (component.harness === "codex") {
    const configText = readText(CODEX_CONFIG, "");
    const desiredItems = config.tui?.status_line || [];
    const itemsPresent = desiredItems.every((item) => codexStatusLineIncludes(configText, item));
    // When the package owns a scalar (e.g. status_line_use_colors), the probe must verify it too —
    // array items alone would report "present" while an owned scalar silently failed to apply.
    const wantsColorScalar = typeof config.tui?.status_line_use_colors === "boolean";
    const scalarPresent = !wantsColorScalar
      || codexScalarMatches(configText, "status_line_use_colors", config.tui.status_line_use_colors);
    const observed = itemsPresent && scalarPresent;
    return componentResult(component, {
      desired,
      observed,
      owner: observed ? "roborepo" : null,
      detail: observed
        ? "Codex status_line contains package fields"
        : !itemsPresent ? "Codex status_line missing package fields" : "Codex status_line color scalar not applied",
    });
  }
  return componentResult(component, { desired, observed: false, detail: "unknown harness-config harness", blocked: desired });
}

// Slash-command entrypoints this skill resource declares, keyed by harness — needed here because
// componentResource() strips entrypoints down to { type, id } for the generic component list, so
// the probe must read them from the package's raw (pre-normalization) resources instead.
function skillCommandNamesByHarness(pkg, skillId) {
  const byHarness = { claude: [], codex: [] };
  const resource = (pkg?.resources || []).find((r) => r.type === "skill" && r.id === skillId);
  for (const entrypoint of resource?.entrypoints || []) {
    if (entrypoint.type !== "slash-command") continue;
    for (const harness of entrypoint.harnesses || []) {
      if (byHarness[harness]) byHarness[harness].push(entrypoint.name);
    }
  }
  return byHarness;
}

function probeSkill(component, desired, pkg) {
  const cachePath = path.join(stateSkillsDir, component.id);
  const observed = fs.existsSync(cachePath);
  const managed = fs.existsSync(path.join(cachePath, ".builtin-managed"));

  // Command-wrapper presence is a separate signal from cache presence: it must not change whether
  // this component reads as "external" (cache-only adopt-live detection depends on that), only
  // whether a DESIRED, cache-present skill is flagged as inconsistent (blocked) when its command
  // wrapper — a real file the enable path installs alongside the cache — has gone missing.
  const commandsByHarness = skillCommandNamesByHarness(pkg, component.id);
  const commandChecks = [];
  for (const [harness, names] of Object.entries(commandsByHarness)) {
    for (const name of names) {
      const wrapperPath = path.join(os.homedir(), `.${harness}`, "commands", `${name}.md`);
      commandChecks.push(fs.existsSync(wrapperPath));
    }
  }
  const allCommandsPresent = commandChecks.length === 0 || commandChecks.every(Boolean);
  const commandsMissing = observed && desired && !allCommandsPresent;

  return componentResult(component, {
    desired,
    observed,
    blocked: commandsMissing,
    owner: managed ? "roborepo" : observed ? "external" : null,
    detail: !observed
      ? "skill cache missing"
      : commandsMissing
        ? `cache ${managed ? "managed" : "unmanaged"}: ${cachePath}; command wrapper(s) missing`
        : `cache ${managed ? "managed" : "unmanaged"}: ${cachePath}`,
  });
}

function dependencyComponents(pkg, packageStatusById) {
  return (pkg.requires || []).map((id) => {
    const dep = packageStatusById.get(id);
    const observed = dep?.desired === true;
    return {
      type: "requires",
      id,
      desired: true,
      observed,
      owner: dep ? "roborepo" : null,
      state: observed ? "present" : "missing",
      detail: dep ? `dependency status: ${dep.status}` : "dependency not found",
    };
  });
}

function packageStatus({ desired, components }) {
  if (desired) {
    if (components.some((component) => component.state === "missing" || component.state === "blocked")) {
      return "partial";
    }
    // A fully-installed package whose only not-"present" component is an administratively-off
    // service reads as "configured" — everything is in place, the service just isn't running.
    // This keeps a deliberate off state visually distinct from a broken install ("partial").
    if (components.some((component) => component.state === "inactive")) {
      return "configured";
    }
    return "enabled";
  }
  return components.some((component) => component.state === "external") ? "external" : "disabled";
}

export function buildPackageLiveState(packages, { hookRecords = null } = {}) {
  const enabledIds = new Set(effectiveEnabledIds(packages));
  const settings = readJson(CLAUDE_SETTINGS, {});
  const telemetryState = readJson(path.join(telemetryDir, "state.json"), null);
  const byId = new Map();
  const out = [];

  for (const pkg of packages) {
    const baseDesired = enabledIds.has(pkg.id);
    const components = [];

    for (const component of pkg.components || []) {
      const componentDesired = baseDesired;
      if (component.type === "rules") components.push(probeRules(component, componentDesired));
      else if (component.type === "command") components.push(probeCommand(component, componentDesired));
      else if (component.type === "hooks") components.push(probeHooks(component, componentDesired, hookRecords));
      else if (component.type === "permissions") components.push(probePermissions(component, componentDesired, settings));
      else if (component.type === "codex_tool_approvals") components.push(probeCodexToolApprovals(component, componentDesired));
      else if (component.type === "plugin") components.push(probePlugin(component, componentDesired, settings));
      else if (component.type === "mcp") components.push(probeMcp(component, componentDesired, settings));
      else if (component.type === "service") components.push(probeService(component, componentDesired, telemetryState));
      else if (component.type === "package-runtime-asset") components.push(probePackageRuntimeAsset(component, componentDesired, pkg));
      else if (component.type === "harness-config") components.push(probeHarnessConfig(component, componentDesired, settings, pkg));
      else if (component.type === "skill") components.push(probeSkill(component, componentDesired, pkg));
      else components.push(componentResult(component, { desired: componentDesired, observed: false, detail: "unknown component type", blocked: componentDesired }));
    }

    const desired = baseDesired;
    const status = packageStatus({ desired, components });
    const summary = { desired, status, components };
    byId.set(pkg.id, summary);
    out.push([pkg.id, summary]);
  }

  for (const [id, summary] of out) {
    const pkg = packages.find((entry) => entry.id === id);
    const deps = dependencyComponents(pkg, byId);
    if (deps.length === 0) continue;
    const components = [...summary.components, ...deps];
    const ownComponents = (pkg.components || []).length > 0;
    const desired = ownComponents ? summary.desired : deps.every((dep) => dep.observed);
    byId.set(id, { desired, status: packageStatus({ desired, components }), components });
  }

  return byId;
}
