import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./paths.mjs";
import { renderRulesPreview, ruleDirsFor, knownHarnessIds } from "./rules-render.mjs";
import { loadSlashCommandPlan } from "./slash-commands.mjs";

// Token-cost estimation for the Config page. Everything here is an explicitly labeled
// estimate: text is measured with a deterministic chars/4 heuristic, never a real
// tokenizer, so all displayed values carry a "~" and the method rides the payload.
// Startup cost = text included automatically at chat start (rendered rules, skill
// discovery metadata). On-demand cost = text loaded only when a skill or command is
// invoked. Config syntax, hook scripts, and MCP schemas are never given numbers.

export const ESTIMATOR = { method: "estimated-v1", version: 1, charsPerToken: 4 };

const THRESHOLDS_FILE = path.join(repoRoot, "manifests", "platform", "context-cost-thresholds.json");
export const CONTEXT_COST_THRESHOLDS = JSON.parse(fs.readFileSync(THRESHOLDS_FILE, "utf8"));

// Product heuristics, not model context limits. low < mediumAt; medium =
// mediumAt..highAbove inclusive; high > highAbove. Thresholds live in a manifest so product
// tuning does not require code edits.
export const CONTEXT_LEVEL_THRESHOLDS = CONTEXT_COST_THRESHOLDS.startupPayload;
export const RENDERED_RULES_LEVEL_THRESHOLDS = CONTEXT_COST_THRESHOLDS.renderedRules;
export const RULE_FRAGMENT_LEVEL_THRESHOLDS = CONTEXT_COST_THRESHOLDS.ruleFragment;
export const SKILL_DISCOVERY_LEVEL_THRESHOLDS = CONTEXT_COST_THRESHOLDS.skillDiscovery;
export const ON_DEMAND_LEVEL_THRESHOLDS = CONTEXT_COST_THRESHOLDS.onDemand;

const HARNESSES = knownHarnessIds();

export function estimateTokens(text) {
  const chars = String(text ?? "").length;
  return { tokens: Math.ceil(chars / ESTIMATOR.charsPerToken), chars, method: ESTIMATOR.method };
}

export function classifyStartupLevel(tokens) {
  if (tokens < CONTEXT_LEVEL_THRESHOLDS.mediumAt) return "low";
  if (tokens > CONTEXT_LEVEL_THRESHOLDS.highAbove) return "high";
  return "medium";
}

export function classifyOnDemandLevel(tokens) {
  if (tokens < ON_DEMAND_LEVEL_THRESHOLDS.mediumAt) return "low";
  if (tokens > ON_DEMAND_LEVEL_THRESHOLDS.highAbove) return "high";
  return "medium";
}

export function classifyRenderedRulesLevel(tokens) {
  if (tokens < RENDERED_RULES_LEVEL_THRESHOLDS.mediumAt) return "low";
  if (tokens > RENDERED_RULES_LEVEL_THRESHOLDS.highAbove) return "high";
  return "medium";
}

export function classifyRuleFragmentLevel(tokens) {
  if (tokens < RULE_FRAGMENT_LEVEL_THRESHOLDS.mediumAt) return "low";
  if (tokens > RULE_FRAGMENT_LEVEL_THRESHOLDS.highAbove) return "high";
  return "medium";
}

export function classifySkillDiscoveryLevel(tokens) {
  if (tokens < SKILL_DISCOVERY_LEVEL_THRESHOLDS.mediumAt) return "low";
  if (tokens > SKILL_DISCOVERY_LEVEL_THRESHOLDS.highAbove) return "high";
  return "medium";
}

// Same normalization renderContent applies to each fragment, so per-package fragment
// measurements reconcile against the authoritative full render.
function normalizeFragment(text) {
  return text.replace(/\n{3,}/g, "\n\n").trimEnd();
}

const defaultDeps = {
  repoRoot,
  readFile(absPath) {
    try {
      return fs.readFileSync(absPath, "utf8");
    } catch {
      return null;
    }
  },
  statFile(absPath) {
    try {
      const stat = fs.statSync(absPath);
      return { mtimeMs: stat.mtimeMs, size: stat.size };
    } catch {
      return null;
    }
  },
  listDir(absDir) {
    try {
      return fs.readdirSync(absDir).sort();
    } catch {
      return [];
    }
  },
  renderRules: (harness, enabledIds) => renderRulesPreview(harness, enabledIds),
  slashCommandPlan: () => loadSlashCommandPlan(),
};

// --------------------------------------------------------------------------- collectors

function packageRulesComponents(pkg, harness, enabled, deps) {
  const components = [];
  for (const comp of pkg.components || []) {
    if (comp.type !== "rules") continue;
    if (comp.harness !== "both" && comp.harness !== harness) continue;
    const content = deps.readFile(path.join(deps.repoRoot, comp.source));
    if (content === null) continue;
    components.push({
      id: `${pkg.id}:rules:${comp.source}`,
      packageId: pkg.id,
      resourceKey: `rules:${comp.source}`,
      sourceType: "rules",
      load: "startup",
      tokens: estimateTokens(normalizeFragment(content)).tokens,
      active: enabled,
      basis: "rendered-fragment",
      sourcePaths: [comp.source],
    });
  }
  return components;
}

function skillComponents(tool, harness, enabled, deps) {
  const components = [];
  const inventory = tool.inventory || {};
  const frontmatter = inventory.frontmatter || {};
  const installed = Boolean(inventory.harnesses?.[harness]?.installed);
  const discoveryText = [frontmatter.name || tool.id, frontmatter.description || ""]
    .filter(Boolean)
    .join(": ");
  components.push({
    id: `${tool.id}:skill-discovery`,
    packageId: tool.packageId,
    resourceKey: `skill:${tool.id}`,
    sourceType: "skill",
    load: "startup",
    tokens: estimateTokens(discoveryText).tokens,
    active: enabled && installed,
    basis: "skill-discovery-metadata",
    sourcePaths: inventory.inspectPath ? [inventory.inspectPath] : [],
  });
  const skillMd = inventory.inspectPath ? deps.readFile(inventory.inspectPath) : null;
  components.push({
    id: `${tool.id}:skill-body`,
    packageId: tool.packageId,
    resourceKey: `skill:${tool.id}`,
    sourceType: "skill",
    load: "on-demand",
    tokens: skillMd === null ? 0 : estimateTokens(skillMd).tokens,
    active: enabled && installed,
    basis: "skill-md",
    // Reference/context files load only when the skill instructs reading them; they are
    // listed for traceability but never counted.
    sourcePaths: inventory.inspectPath ? [inventory.inspectPath] : [],
    notes: (inventory.contextFiles || []).length ? ["reference files not counted"] : [],
  });
  return components;
}

function commandComponents(plan, harness, enabledSet) {
  // Skill-backed command discovery is already covered by the skill's own discovery
  // metadata; only the wrapper body ("when run") is added here. Standalone commands
  // contribute both a discovery line and their wrapper body.
  const components = [];
  for (const command of plan.commands) {
    if (!command.harnesses.includes(harness)) continue;
    const wrapper = plan.expected.get(`${harness}::${command.packageId}`)?.get(`${command.name}.md`) || "";
    const active = enabledSet.has(command.packageId);
    if (command.kind === "standalone") {
      components.push({
        id: `${command.name}:command-discovery`,
        packageId: command.packageId,
        resourceKey: `slash-command:${command.name}`,
        sourceType: "slash-command",
        load: "startup",
        tokens: estimateTokens(command.description || "").tokens,
        active,
        basis: "command-discovery-metadata",
        sourcePaths: [],
      });
    }
    components.push({
      id: `${command.name}:command-wrapper`,
      packageId: command.packageId,
      // A skill-backed wrapper is part of its skill's cost, so a package's contents view shows
      // one figure per skill rather than splitting the skill from the command that runs it.
      resourceKey: command.kind === "skill-backed" && command.skill ? `skill:${command.skill}` : `slash-command:${command.name}`,
      sourceType: "slash-command",
      load: "on-demand",
      tokens: estimateTokens(wrapper).tokens,
      active,
      basis: "generated-wrapper",
      sourcePaths: [],
    });
  }
  return components;
}

function labelResources(pkg) {
  const labels = [];
  const types = new Set((pkg.components || []).map((c) => c.type));
  for (const resource of pkg.resources || []) types.add(resource.type);
  if (types.has("hooks")) labels.push("conditional");
  if (types.has("mcp")) labels.push("runtime-dependent");
  return labels;
}

// --------------------------------------------------------------------------- aggregation

function sumTokens(components, load, { activeOnly = false } = {}) {
  return components
    .filter((c) => c.load === load && (!activeOnly || c.active))
    .reduce((total, c) => total + (c.tokens || 0), 0);
}

function systemRulesTokens(harness, deps) {
  let total = 0;
  for (const dir of ruleDirsFor(harness)) {
    const absDir = path.join(deps.repoRoot, dir);
    for (const file of deps.listDir(absDir).filter((f) => f.endsWith(".md"))) {
      const content = deps.readFile(path.join(absDir, file));
      if (content !== null) total += estimateTokens(normalizeFragment(content)).tokens;
    }
  }
  return total;
}

function harnessCost(harness, { catalog, enabledIds, tools, deps, plan }) {
  const enabledSet = new Set(enabledIds);
  const components = [];

  for (const pkg of catalog) {
    components.push(...packageRulesComponents(pkg, harness, enabledSet.has(pkg.id), deps));
  }
  for (const tool of tools) {
    components.push(...skillComponents(tool, harness, enabledSet.has(tool.packageId), deps));
  }
  components.push(...commandComponents(plan, harness, enabledSet));

  // Authoritative startup rules total: the final rendered payload, not a fragment sum.
  // Rendering adds a preamble and normalizes content, so the remainder over the active
  // package fragments is attributed to core/baseline rather than invented per-package.
  const rulesTokens = estimateTokens(deps.renderRules(harness, enabledIds)).tokens;
  const packageRulesTokens = components
    .filter((c) => c.sourceType === "rules" && c.active)
    .reduce((total, c) => total + c.tokens, 0);
  const coreBaselineTokens = Math.max(0, rulesTokens - packageRulesTokens);
  const reconciliationDelta = coreBaselineTokens - systemRulesTokens(harness, deps);
  components.push({
    id: "core-baseline",
    packageId: null,
    sourceType: "core",
    load: "startup",
    tokens: coreBaselineTokens,
    active: true,
    basis: "rendered-remainder",
    sourcePaths: ruleDirsFor(harness),
  });

  const skillDiscoveryTokens = components
    .filter((c) => c.basis === "skill-discovery-metadata" && c.active)
    .reduce((total, c) => total + c.tokens, 0);
  const commandDiscoveryTokens = components
    .filter((c) => c.basis === "command-discovery-metadata" && c.active)
    .reduce((total, c) => total + c.tokens, 0);

  const startupTokens = rulesTokens + skillDiscoveryTokens + commandDiscoveryTokens;
  const onDemandTokens = sumTokens(components, "on-demand", { activeOnly: true });

  return {
    startupTokens,
    level: classifyStartupLevel(startupTokens),
    onDemandTokens,
    breakdown: {
      rulesTokens,
      rulesLevel: classifyRenderedRulesLevel(rulesTokens),
      coreBaselineTokens,
      packageRulesTokens,
      skillDiscoveryTokens,
      skillDiscoveryLevel: classifySkillDiscoveryLevel(skillDiscoveryTokens),
      reconciliationDelta,
    },
    components,
  };
}

// Each resource's share of its package's cost, keyed by resourceKey (`skill:<id>`,
// `rules:<source>`, `slash-command:<name>`). Each figure is that resource's largest value across
// harnesses, as the package totals are, so the figures add up to the package total only when one
// harness is largest for every resource; otherwise their sum can exceed it.
function aggregateResources(harnesses, packageId) {
  const keys = new Set();
  for (const harness of HARNESSES) {
    for (const c of harnesses[harness].components) {
      if (c.packageId === packageId && c.resourceKey) keys.add(c.resourceKey);
    }
  }
  const resources = {};
  for (const key of keys) {
    const perHarness = HARNESSES.map((harness) => {
      const own = harnesses[harness].components.filter((c) => c.packageId === packageId && c.resourceKey === key);
      return {
        startupTokens: sumTokens(own, "startup"),
        rulesTokens: own.filter((c) => c.sourceType === "rules").reduce((total, c) => total + (c.tokens || 0), 0),
        onDemandTokens: sumTokens(own, "on-demand"),
      };
    });
    const startupTokens = Math.max(...perHarness.map((h) => h.startupTokens));
    const rulesTokens = Math.max(...perHarness.map((h) => h.rulesTokens));
    const onDemandTokens = Math.max(...perHarness.map((h) => h.onDemandTokens));
    resources[key] = {
      startupTokens,
      rulesTokens,
      rulesLevel: classifyRuleFragmentLevel(rulesTokens),
      onDemandTokens,
      onDemandLevel: classifyOnDemandLevel(onDemandTokens),
    };
  }
  return resources;
}

function aggregatePackages(catalog, enabledIds, harnesses) {
  const packages = {};
  for (const pkg of catalog) {
    const perHarness = {};
    for (const harness of HARNESSES) {
      const own = harnesses[harness].components.filter((c) => c.packageId === pkg.id);
      const rulesTokens = own
        .filter((c) => c.sourceType === "rules")
        .reduce((total, c) => total + (c.tokens || 0), 0);
      const discoveryTokens = own
        .filter((c) => c.basis === "skill-discovery-metadata" || c.basis === "command-discovery-metadata")
        .reduce((total, c) => total + (c.tokens || 0), 0);
      const activeDiscoveryTokens = own
        .filter((c) => c.basis === "skill-discovery-metadata" || c.basis === "command-discovery-metadata")
        .filter((c) => c.active)
        .reduce((total, c) => total + (c.tokens || 0), 0);
      perHarness[harness] = {
        startupTokens: sumTokens(own, "startup"),
        rulesTokens,
        discoveryTokens,
        activeDiscoveryTokens,
        onDemandTokens: sumTokens(own, "on-demand"),
        activeStartupTokens: sumTokens(own, "startup", { activeOnly: true }),
        activeOnDemandTokens: sumTokens(own, "on-demand", { activeOnly: true }),
      };
    }
    const startupTokens = Math.max(...HARNESSES.map((h) => perHarness[h].startupTokens));
    const rulesTokens = Math.max(...HARNESSES.map((h) => perHarness[h].rulesTokens));
    const discoveryTokens = Math.max(...HARNESSES.map((h) => perHarness[h].discoveryTokens));
    const activeDiscoveryTokens = Math.max(...HARNESSES.map((h) => perHarness[h].activeDiscoveryTokens));
    const onDemandTokens = Math.max(...HARNESSES.map((h) => perHarness[h].onDemandTokens));
    packages[pkg.id] = {
      label: pkg.label || pkg.id,
      startupTokens,
      startupLevel: classifyStartupLevel(startupTokens),
      rulesTokens,
      rulesLevel: classifyRuleFragmentLevel(rulesTokens),
      discoveryTokens,
      discoveryLevel: classifySkillDiscoveryLevel(discoveryTokens),
      activeDiscoveryTokens,
      activeDiscoveryLevel: classifySkillDiscoveryLevel(activeDiscoveryTokens),
      onDemandTokens,
      onDemandLevel: classifyOnDemandLevel(onDemandTokens),
      // Active totals honor each component's own active flag (enabled AND, for skills,
      // installed on that harness) so section rollups reconcile with the harness totals
      // instead of assuming every enabled package's content actually loads.
      activeStartupTokens: Math.max(...HARNESSES.map((h) => perHarness[h].activeStartupTokens)),
      activeOnDemandTokens: Math.max(...HARNESSES.map((h) => perHarness[h].activeOnDemandTokens)),
      harnessesDiffer: HARNESSES.some(
        (h) => perHarness[h].startupTokens !== startupTokens || perHarness[h].onDemandTokens !== onDemandTokens,
      ),
      perHarness,
      resources: aggregateResources(harnesses, pkg.id),
      labels: labelResources(pkg),
      notes: harnesses.claude.components.some(
        (c) => c.packageId === pkg.id && (c.notes || []).includes("reference files not counted"),
      ) ? ["reference files not counted"] : [],
    };
  }
  return packages;
}

// --------------------------------------------------------------------------- cache

// One cached result, keyed by a stat signature over every input file plus enabled state
// and install state. Cache hits return the same object reference so the serialized
// snapshot stays byte-identical and the portal's snapshotChanged skip keeps working.
let cache = { signature: null, result: null };

export function invalidateContextCostCache() {
  cache = { signature: null, result: null };
}

function statSig(absPath, deps) {
  const stat = deps.statFile(absPath);
  return stat ? `${absPath}:${stat.mtimeMs}:${stat.size}` : `${absPath}:absent`;
}

function buildSignature({ catalog, enabledIds, tools, deps }) {
  const parts = [`v${ESTIMATOR.version}`, [...enabledIds].sort().join(",")];
  parts.push(statSig(THRESHOLDS_FILE, deps));
  for (const dir of new Set(HARNESSES.flatMap(ruleDirsFor))) {
    const absDir = path.join(deps.repoRoot, dir);
    for (const file of deps.listDir(absDir).filter((f) => f.endsWith(".md"))) {
      parts.push(statSig(path.join(absDir, file), deps));
    }
  }
  for (const pkg of catalog) {
    if (pkg.sourceFile) parts.push(statSig(pkg.sourceFile, deps));
    for (const comp of pkg.components || []) {
      if (comp.type === "rules") parts.push(statSig(path.join(deps.repoRoot, comp.source), deps));
    }
  }
  for (const tool of tools) {
    const inventory = tool.inventory || {};
    if (inventory.inspectPath) parts.push(statSig(inventory.inspectPath, deps));
    for (const harness of HARNESSES) {
      parts.push(`${tool.id}:${harness}:${inventory.harnesses?.[harness]?.installed ? 1 : 0}`);
    }
  }
  return parts.join("|");
}

// --------------------------------------------------------------------------- entry

export function buildContextCost({ catalog, enabledIds, tools, deps = defaultDeps }) {
  const signature = buildSignature({ catalog, enabledIds, tools, deps });
  if (cache.signature === signature) return cache.result;

  const plan = deps.slashCommandPlan();
  const harnesses = {};
  for (const harness of HARNESSES) {
    harnesses[harness] = harnessCost(harness, { catalog, enabledIds, tools, deps, plan });
  }

  const result = {
    method: ESTIMATOR.method,
    estimatorVersion: ESTIMATOR.version,
    thresholds: { ...CONTEXT_LEVEL_THRESHOLDS },
    startupThresholds: { ...CONTEXT_LEVEL_THRESHOLDS },
    renderedRulesThresholds: { ...RENDERED_RULES_LEVEL_THRESHOLDS },
    ruleFragmentThresholds: { ...RULE_FRAGMENT_LEVEL_THRESHOLDS },
    skillDiscoveryThresholds: { ...SKILL_DISCOVERY_LEVEL_THRESHOLDS },
    onDemandThresholds: { ...ON_DEMAND_LEVEL_THRESHOLDS },
    harnesses,
    packages: aggregatePackages(catalog, enabledIds, harnesses),
  };
  cache = { signature, result };
  return result;
}
