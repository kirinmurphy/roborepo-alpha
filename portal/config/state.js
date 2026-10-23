// Pure data/logic for the Config page — no DOM here. app.js owns wiring DOM events to this
// module's functions; templates.js owns turning its output into markup.

import { formatTokens } from "/portal/shared/token-chip.js";
import { activePresentedHarnesses } from "/portal/shared/harness-cohort.js";
export { formatTokens };

export const TOGGLE_ENDPOINT = {
  package: "/api/config/packages",
  skill: "/api/config/skills",
};

// Section-batch lock (client side of the server's own in-flight flag): true while a bulk request
// is in flight. standardSection() reads it to disable every toggle in bulk sections during the
// batch, so no per-row click can interleave with it; app.js's bulk handler clears it when the
// request settles. The server rejects overlapping batches (409) regardless — this is the
// fast, visual layer of the same guarantee.
let bulkInFlight = false;
export function setBulkInFlight(value) {
  bulkInFlight = value;
}
export function isBulkInFlight() {
  return bulkInFlight;
}

// Display order, loosest to strictest. Order-independent everywhere it is used as a membership
// check; only affects how bucket options are presented.
export const BUCKETS = ["allow", "ask", "deny"];

// Root-config drift chip shown beside settings.json / config.toml. Driven by snap.rootConfig, which
// the server computes once (buildRootConfigView in config.mjs) so terminal and web agree. "in-sync"
// and "not-installed" are the quiet default — no chip — so the chip only appears when there is
// something the user might want to know about (local changes, or an untracked file).
export const DRIFT_CHIP = {
  drifted: { label: "local changes", cls: "drift-info", title: "Changed since roborepo last wrote it, by you or by the harness app. Your settings are kept: `roborepo update` only adds roborepo's own entries." },
  unwritten: { label: "untracked", cls: "drift-muted", title: "No recorded roborepo write yet (pre-dates drift tracking, or not installed via roborepo)." },
};

export function resolveDriftChip(rootConfig, harness) {
  const driftByHarness = new Map((rootConfig || []).map((r) => [r.harness, r]));
  const row = driftByHarness.get(harness);
  return row && DRIFT_CHIP[row.state];
}

export function snapshotChanged(prevSignature, snap) {
  const sig = JSON.stringify(snap);
  return sig !== prevSignature ? sig : null;
}

// ------------------------------------------------------------------ context cost (estimates)

function levelFor(tokens, thresholds) {
  if (!thresholds || !Number.isFinite(tokens)) return null;
  if (tokens < thresholds.mediumAt) return "low";
  if (tokens > thresholds.highAbove) return "high";
  return "medium";
}

// Chip spec for one harness's startup total in the "Tokens used in config" bar: colored by the
// startup scale, tooltip carries the contributing-amount table.
export function harnessChipSpec(contextCost, harnessId) {
  const harness = contextCost?.harnesses?.[harnessId];
  if (!harness) return null;
  const b = harness.breakdown || {};
  const discovery = harness.startupTokens - (b.rulesTokens || 0);
  return {
    tokens: harness.startupTokens,
    level: harness.level,
    detail: "Included automatically in every new chat.",
    breakdown: [
      { label: "System rules", tokens: b.coreBaselineTokens || 0 },
      { label: "Package rule snippets", tokens: b.packageRulesTokens || 0 },
      { label: "Skill discovery descriptions", tokens: discovery },
    ],
    legend: contextCost.startupThresholds || contextCost.thresholds,
  };
}

// Chip spec for one harness's rendered rules file (CLAUDE.md / AGENTS.md), on the same startup
// color scale as the summary chips.
export function rulesChipSpec(contextCost, harnessId) {
  const harness = contextCost?.harnesses?.[harnessId];
  if (!harness) return null;
  const rulesTokens = harness.breakdown?.rulesTokens ?? harness.startupTokens;
  const legend = contextCost.renderedRulesThresholds || contextCost.thresholds;
  return {
    tokens: rulesTokens,
    level: harness.breakdown?.rulesLevel || levelFor(rulesTokens, legend),
    detail: "Rendered rules, loaded at chat start.",
    legend,
  };
}

function warningRatio(spec) {
  const highAbove = spec?.legend?.highAbove;
  if (!Number.isFinite(spec?.tokens) || !Number.isFinite(highAbove) || highAbove <= 0) return 0;
  return spec.tokens / highAbove;
}

function warningEntry(label, spec, extra = {}) {
  if (!spec || !["medium", "high"].includes(spec.level)) return null;
  return { label, spec, ratio: warningRatio(spec), ...extra };
}

function splitWarningLabel(label) {
  const match = String(label).match(/^(.+?)(\s+\(.+\))$/);
  return match ? { name: match[1], suffix: match[2] } : { name: String(label), suffix: "" };
}

function discoveryWarning(contextCost, harnesses) {
  const legend = contextCost?.skillDiscoveryThresholds || contextCost?.thresholds;
  const displayNameOf = new Map((harnesses || []).map((h) => [h.id, h.displayName]));
  const activeHarnessIds = new Set((harnesses || []).map((harness) => harness.id));
  const rows = Object.entries(contextCost?.harnesses || {})
    .filter(([harness]) => activeHarnessIds.has(harness))
    .map(([harness, cost]) => ({
      harness,
      tokens: cost.breakdown?.skillDiscoveryTokens || 0,
    }));
  if (rows.length === 0) return null;
  const max = rows.reduce((best, row) => (row.tokens > best.tokens ? row : best), { harness: "", tokens: 0 });
  const spec = {
    tokens: max.tokens,
    level: levelFor(max.tokens, legend),
    detail: "Total skill discovery descriptions loaded at chat start while enabled.",
    breakdown: rows.map((row) => ({
      label: displayNameOf.get(row.harness) || row.harness,
      tokens: row.tokens,
    })),
    legend,
  };
  return warningEntry("Skill Discovery Descriptions (in total)", spec, {
    info: discoveryWarningInfo(contextCost),
  });
}

function discoveryWarningInfo(contextCost) {
  const itemWarnings = skillDiscoveryItemWarnings(contextCost);
  if (itemWarnings.length) {
    return "Total of all enabled skill discovery descriptions. Individual large entries: "
      + itemWarnings.map((item) => `${item.label} (${formatTokens(item.tokens)})`).join(", ")
      + ".";
  }
  return "Total of all enabled skill discovery descriptions. No single discovery description is large on its own; the warning comes from the combined total.";
}

function skillDiscoveryItemWarnings(contextCost) {
  const legend = contextCost?.skillDiscoveryThresholds || contextCost?.thresholds;
  const byPackage = contextCost?.packages || {};
  return Object.entries(byPackage)
    .map(([id, cost]) => ({
      label: cost.label || id,
      tokens: cost.activeDiscoveryTokens || 0,
      level: cost.activeDiscoveryLevel || levelFor(cost.activeDiscoveryTokens || 0, legend),
      ratio: warningRatio({ tokens: cost.activeDiscoveryTokens || 0, legend }),
    }))
    .filter((item) => ["medium", "high"].includes(item.level))
    .sort((a, b) => (b.level === "high") - (a.level === "high") || b.ratio - a.ratio || a.label.localeCompare(b.label));
}

function itemWarningEntry(item, contextCost) {
  const cost = item.contextCost;
  if (!cost) return null;
  const isCommand = item.inspect?.kind === "command-skill";
  if (cost.onDemandTokens > 0 && cost.onDemandLevel && cost.onDemandLevel !== "low") {
    return warningEntry(item.label + (isCommand ? " (when run)" : " (when loaded)"), {
      tokens: cost.onDemandTokens,
      level: cost.onDemandLevel || null,
      detail: isCommand ? "Loaded when the command runs." : "Loaded when the skill is invoked.",
      legend: contextCost.onDemandThresholds,
    });
  }
  if (cost.rulesTokens > 0 && cost.rulesLevel && cost.rulesLevel !== "low") {
    return warningEntry(item.label + " (rules snippet)", {
      tokens: cost.rulesTokens,
      level: cost.rulesLevel || null,
      detail: "Rule snippet included in rendered rules while enabled.",
      legend: contextCost.ruleFragmentThresholds || contextCost.thresholds,
    });
  }
  if (cost.discoveryTokens > 0 && cost.discoveryLevel && cost.discoveryLevel !== "low") {
    return warningEntry(item.label + " (discovery)", {
      tokens: cost.discoveryTokens,
      level: cost.discoveryLevel || null,
      detail: "Discovery metadata, loaded at chat start while enabled.",
      legend: contextCost.skillDiscoveryThresholds || contextCost.thresholds,
    });
  }
  return null;
}

function compareWarningEntries(a, b) {
  const levelDelta = (b.spec.level === "high") - (a.spec.level === "high");
  if (levelDelta) return levelDelta;
  return b.ratio - a.ratio || a.label.localeCompare(b.label);
}

export function tokenWarningEntries(snap) {
  const contextCost = snap?.contextCost;
  if (!contextCost) return [];
  const harnesses = activePresentedHarnesses(snap);
  const entries = [
    ...harnesses.map((h) => warningEntry(h.rulesFile, rulesChipSpec(contextCost, h.id))),
    discoveryWarning(contextCost, harnesses),
    ...(snap.behaviorView || [])
      .flatMap((section) => section.items || [])
      .filter((item) => item.active !== false)
      .map((item) => itemWarningEntry(item, contextCost)),
  ].filter(Boolean);
  return entries.map((entry) => ({ ...entry, ...splitWarningLabel(entry.label) })).sort(compareWarningEntries);
}

// Labeled chip specs for the source-inspect modal's dedicated cost row: what does the thing
// being viewed cost? Always returns an array of { label, spec } so the row can render
// "Startup: [chip]  When loaded: [chip]" — the moment-of-cost distinction lives in the label,
// never inside the chip's own text. live-rules → one "Startup" chip for that harness's rendered
// rules; skills/commands → separate Startup (discovery) and When loaded/When run entries; rules
// fragments → one Startup entry.
export function inspectChipSpecs(inspect, itemCost, snap) {
  const contextCost = snap?.contextCost;
  if (!inspect || !contextCost) return [];
  if (inspect.kind === "live-rules") {
    const spec = inspect.harness ? rulesChipSpec(contextCost, inspect.harness) : null;
    return spec ? [{ label: "Startup", spec }] : [];
  }
  if (!itemCost) return [];
  if (inspect.kind === "skill" || inspect.kind === "command-skill") {
    const entries = [];
    if (itemCost.startupTokens > 0) {
      entries.push({
        label: "Startup",
        spec: {
          tokens: itemCost.startupTokens,
          level: levelFor(itemCost.startupTokens, contextCost.skillDiscoveryThresholds || contextCost.thresholds),
          detail: "Discovery metadata, loaded at chat start while enabled.",
          legend: contextCost.skillDiscoveryThresholds || contextCost.thresholds,
        },
      });
    }
    if (itemCost.onDemandTokens > 0) {
      const isCommand = inspect.kind === "command-skill";
      entries.push({
        label: isCommand ? "When run" : "When loaded",
        spec: {
          tokens: itemCost.onDemandTokens,
          level: itemCost.onDemandLevel || null,
          detail: isCommand ? "Loaded when the command runs." : "Loaded when the skill is invoked.",
          legend: contextCost.onDemandThresholds,
        },
      });
    }
    return entries;
  }
  if (inspect.kind === "rules") {
    if (!(itemCost.startupTokens > 0)) return [];
    return [{
      label: "Startup",
      spec: {
        tokens: itemCost.startupTokens,
        level: itemCost.rulesLevel || levelFor(itemCost.startupTokens, contextCost.ruleFragmentThresholds || contextCost.thresholds),
        detail: "Rule snippet included in rendered rules while enabled.",
        legend: contextCost.ruleFragmentThresholds || contextCost.thresholds,
      },
    }];
  }
  return [];
}

// Chip specs for one behaviorView item row. Warning-only: a chip appears ONLY for medium/high
// cost (never low/green) — the row list is meant to flag notable cost, not restate every
// package's size. Returns { spec, label } pairs consumed by <token-chip> directly.
export function contextCostChipSpecs(item, contextCost) {
  const cost = item.contextCost;
  if (!cost || !contextCost) return [];
  const chips = [];
  const isCommand = item.inspect?.kind === "command-skill";
  const differNote = cost.harnessesDiffer ? " Costs differ by harness; the larger is shown." : "";

  if (cost.onDemandTokens > 0 && cost.onDemandLevel && cost.onDemandLevel !== "low") {
    chips.push({
      label: isCommand ? "When run" : "When loaded",
      spec: {
        tokens: cost.onDemandTokens,
        level: cost.onDemandLevel,
        detail: (isCommand ? "Loaded when the command runs." : "Loaded when the skill is invoked.") + differNote,
        legend: contextCost.onDemandThresholds,
      },
    });
  } else if (cost.rulesTokens > 0 && cost.rulesLevel && cost.rulesLevel !== "low") {
    chips.push({
      label: "Startup",
      spec: {
        tokens: cost.rulesTokens,
        level: cost.rulesLevel,
        detail: "Rule snippet included in rendered rules while enabled." + differNote,
        legend: contextCost.ruleFragmentThresholds || contextCost.thresholds,
      },
    });
  } else if (cost.discoveryTokens > 0 && cost.discoveryLevel && cost.discoveryLevel !== "low") {
    chips.push({
      label: "Startup",
      spec: {
        tokens: cost.discoveryTokens,
        level: cost.discoveryLevel,
        detail: "Discovery metadata, loaded at chat start while enabled." + differNote,
        legend: contextCost.skillDiscoveryThresholds || contextCost.thresholds,
      },
    });
  }
  return chips;
}
