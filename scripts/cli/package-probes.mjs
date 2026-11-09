import fs from "node:fs";
import path from "node:path";
import { harnessHome, repoRoot, rootConfigActive } from "./paths.mjs";
import { hookFilePath } from "./hook-composition.mjs";
import { compareHookReadiness, fragmentHooks } from "../harnesses/hook-readiness.mjs";
import { hookRecordsFromFile } from "../harnesses/root-config-hooks.mjs";
import { getHarnessProvider } from "../harnesses/registry.mjs";
import { hasHarnessPath, resolveHarnessPath } from "../harnesses/paths.mjs";
import { stateSkillsDir, telemetryDir } from "./state-paths.mjs";
import { capableProviders, pluginDirDestination, readHarnessConfig, packageRuntimeAssetDestination, resourceProviders } from "./package-harness-config.mjs";
import { knownHarnessIds } from "./rules-render.mjs";
import { effectiveEnabledIds } from "./package-state.mjs";
import { requiredClosure } from "./package-graph.mjs";

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

// A component without a harness applies to every registered harness.
function targetHarnesses(component) {
  if (!component.harness) return knownHarnessIds();
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

function liveRulesFile(harness) {
  const { manifest } = getHarnessProvider(harness);
  return hasHarnessPath(manifest, "rules") ? resolveHarnessPath(manifest, "rules") : null;
}

function probeRules(component, desired) {
  const signature = firstNonblankLine(component.source);
  const observedHarnesses = targetHarnesses(component).filter((harness) => {
    const rulesFile = liveRulesFile(harness);
    const live = rulesFile ? readText(rulesFile, "") : "";
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
    detail: hookProbeDetail({
      state, found, expected: expected.length, scriptsPresent, harness: component.harness,
      perHookTrust: (groups[0]?.hooks || []).some((hook) => hook.trust !== "not-required"),
    }),
  });
}

// A harness without per-hook trust (Claude) reports `not-required`, which proves the hook is
// configured, not that every session runs it: Claude holds settings hooks in an interactive
// session until the user trusts that workspace. So such hooks read "configured", never "active".
function hookProbeDetail({ state, found, expected, scriptsPresent, harness, perHookTrust }) {
  const counts = `${found}/${expected} hook command(s) present`;
  if (!scriptsPresent) return `${counts}, script file(s) missing`;
  if (state === "review_required") return `${counts}, awaiting review in ${harnessDisplayName(harness)}`;
  if (state === "inactive") return `${counts}, disabled in ${harnessDisplayName(harness)}`;
  if (state === "active") return `${counts}, ${perHookTrust ? "active" : "configured"}`;
  return counts;
}

function harnessDisplayName(harness) {
  return getHarnessProvider(harness).manifest.displayName;
}

// Folds one provider probe per target harness into a component result: present only when every
// target provider observes it.
function probeThroughProviders(component, desired, providers, probe) {
  const results = providers.map((provider) => probe(provider, { configPath: rootConfigActive[provider.id] }));
  const observed = results.length > 0 && results.every((result) => result.observed);
  return componentResult(component, {
    desired,
    observed,
    owner: desired ? "roborepo" : "external",
    detail: results.map((result) => result.detail).join("; ") || "no provider supports this resource",
  });
}

function probePermissions(component, desired) {
  return probeThroughProviders(component, desired, resourceProviders(component, "package-permissions"),
    (provider, io) => provider.adapters.packages.probePermissions(component.allow || [], io));
}

function probeToolApprovals(component, desired) {
  return probeThroughProviders(component, desired, resourceProviders(component, "package-tool-approvals"),
    (provider, io) => provider.adapters.packages.probeToolApprovals(component, io));
}

function probePlugin(component, desired) {
  return probeThroughProviders(component, desired, resourceProviders(component, "package-plugins"),
    (provider, io) => provider.adapters.packages.probePlugin(component, io));
}

// Found when any MCP-capable provider has the preset registered.
function probeMcp(component, desired) {
  const observed = capableProviders("mcp").some((provider) =>
    provider.adapters.mcp.hasServer(component.preset, { configPath: rootConfigActive[provider.id] }));
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

function probePluginDir(component, desired, pkg) {
  const destPath = pluginDirDestination(pkg, component);
  const [provider] = resourceProviders(component, "package-plugin-dirs");
  const { observed, detail } = provider.adapters.packages.probePluginDir(destPath, { configPath: rootConfigActive[provider.id] });
  return componentResult(component, { desired, observed, owner: observed ? "roborepo" : null, detail });
}

function probeHarnessConfig(component, desired, pkg) {
  const [provider] = resourceProviders(component, "package-config");
  const { observed, owner, detail } = provider.adapters.rootConfig.probePackageComponent(
    readHarnessConfig(component, pkg), { configPath: rootConfigActive[provider.id] });
  return componentResult(component, { desired, observed, owner, detail });
}

// Slash-command entrypoints this skill resource declares, keyed by harness — needed here because
// componentResource() strips entrypoints down to { type, id } for the generic component list, so
// the probe must read them from the package's raw (pre-normalization) resources instead.
function skillCommandNamesByHarness(pkg, skillId) {
  const byHarness = {};
  const resource = (pkg?.resources || []).find((r) => r.type === "skill" && r.id === skillId);
  for (const entrypoint of resource?.entrypoints || []) {
    if (entrypoint.type !== "slash-command") continue;
    for (const harness of entrypoint.harnesses || []) {
      (byHarness[harness] ||= []).push(entrypoint.name);
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
      const wrapperPath = path.join(harnessHome[harness], "commands", `${name}.md`);
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
    const observed = dep?.desired === true && ["enabled", "configured"].includes(dep.status);
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

// `effectiveIds` is for callers probing a subset of the catalog: the subset cannot see a selected
// root outside it, so a dependency that root requires would read as not desired.
export function buildPackageLiveState(packages, { hookRecords = null, effectiveIds = effectiveEnabledIds(packages) } = {}) {
  const enabledIds = new Set(effectiveIds);
  const telemetryState = readJson(path.join(telemetryDir, "state.json"), null);
  const byId = new Map();

  for (const pkg of packages) {
    const baseDesired = enabledIds.has(pkg.id);
    const components = [];

    for (const component of pkg.components || []) {
      const componentDesired = baseDesired;
      if (component.type === "rules") components.push(probeRules(component, componentDesired));
      else if (component.type === "command") components.push(probeCommand(component, componentDesired));
      else if (component.type === "hooks") components.push(probeHooks(component, componentDesired, hookRecords));
      else if (component.type === "permissions") components.push(probePermissions(component, componentDesired));
      else if (component.type === "mcp-tool-approvals") components.push(probeToolApprovals(component, componentDesired));
      else if (component.type === "plugin") components.push(probePlugin(component, componentDesired));
      else if (component.type === "mcp") components.push(probeMcp(component, componentDesired));
      else if (component.type === "service") components.push(probeService(component, componentDesired, telemetryState));
      else if (component.type === "package-runtime-asset") components.push(probePackageRuntimeAsset(component, componentDesired, pkg));
      else if (component.type === "plugin-dir") components.push(probePluginDir(component, componentDesired, pkg));
      else if (component.type === "harness-config") components.push(probeHarnessConfig(component, componentDesired, pkg));
      else if (component.type === "skill") components.push(probeSkill(component, componentDesired, pkg));
      else components.push(componentResult(component, { desired: componentDesired, observed: false, detail: "unknown component type", blocked: componentDesired }));
    }

    const desired = baseDesired;
    const status = packageStatus({ desired, components });
    const summary = { desired, status, components };
    byId.set(pkg.id, summary);
  }

  for (const id of requiredClosure(packages, [...byId.keys()])) {
    const summary = byId.get(id);
    const pkg = packages.find((entry) => entry.id === id);
    const deps = dependencyComponents(pkg, byId);
    if (deps.length === 0) continue;
    const components = [...summary.components, ...deps];
    const desired = summary.desired;
    byId.set(id, { desired, status: packageStatus({ desired, components }), components });
  }

  return byId;
}
