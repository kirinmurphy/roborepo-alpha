#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Zero-to-N harness presentation.
//
// The portal's own template modules import "/portal/shared/api.js" by absolute browser URL and
// cannot be loaded in Node, so the cohort *policy* lives in portal/shared/harness-cohort.js —
// DOM-free and importable here. This test covers which harnesses a surface presents and how they
// are named; it does not assert DOM structure (no jsdom in this zero-dependency repo).

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { presentedHarnesses, activePresentedHarnesses, formatHarnessList, supportedHarnessNames } = await import(
  path.join(repoRoot, "portal/shared/harness-cohort.js")
);

const catalog = [
  { id: "claude", displayName: "Claude Code", rulesFile: "CLAUDE.md", settingsFile: "settings.json" },
  { id: "codex", displayName: "Codex", rulesFile: "AGENTS.md", settingsFile: "config.toml" },
  { id: "gemini", displayName: "Gemini CLI", rulesFile: "GEMINI.md", settingsFile: "settings.json" },
];

// --- Zero: nothing detected. The registered catalog is still fully populated, which is exactly the
// trap — presenting it here would claim three installed harnesses on a bare machine. ---
{
  const snap = { harnesses: catalog, machineHarnesses: [] };
  assert.deepEqual(presentedHarnesses(snap), [], "zero detected harnesses must present nothing");
  assert.equal(
    supportedHarnessNames(snap),
    "Claude Code, Codex, and Gemini CLI",
    "the empty state still names supported providers, generated from the catalog",
  );
}

// --- One. ---
{
  const snap = {
    harnesses: catalog,
    machineHarnesses: [{ id: "codex", displayName: "Codex", enabled: true, confidence: "confirmed" }],
  };
  const presented = presentedHarnesses(snap);
  assert.equal(presented.length, 1);
  assert.equal(presented[0].id, "codex");
  // File metadata is merged in from the catalog; the machine entry alone does not carry it.
  assert.equal(presented[0].settingsFile, "config.toml", "catalog metadata must survive the merge");
  assert.equal(presented[0].enabled, true, "machine state must survive the merge");
}

// --- Two, including a present-but-disabled provider. A harness the user turned off is still on the
// machine, so it stays visible; "disabled" and "not installed" are different states. ---
{
  const snap = {
    harnesses: catalog,
    machineHarnesses: [
      { id: "claude", displayName: "Claude Code", enabled: true, confidence: "confirmed" },
      { id: "codex", displayName: "Codex", enabled: false, confidence: "probable" },
    ],
  };
  const presented = presentedHarnesses(snap);
  assert.deepEqual(presented.map((h) => h.id), ["claude", "codex"]);
  assert.deepEqual(presented.map((h) => h.enabled), [true, false]);
  assert.deepEqual(activePresentedHarnesses(snap).map((h) => h.id), ["claude"], "warning/report cohorts only include active harnesses");
}

// --- N, including a provider the catalog has never heard of. Order follows machineHarnesses. ---
{
  const snap = {
    harnesses: [...catalog, { id: "acme", displayName: "Acme Coder", rulesFile: "AGENT.md", settingsFile: "settings.json" }],
    machineHarnesses: [
      { id: "gemini", displayName: "Gemini CLI", enabled: true, confidence: "confirmed" },
      { id: "acme", displayName: "Acme Coder", enabled: true, confidence: "possible" },
      { id: "claude", displayName: "Claude Code", enabled: true, confidence: "confirmed" },
    ],
  };
  const presented = presentedHarnesses(snap);
  assert.deepEqual(presented.map((h) => h.id), ["gemini", "acme", "claude"], "N is data-driven and order-preserving");
  assert.equal(presented.find((h) => h.id === "acme").rulesFile, "AGENT.md");
  assert.equal(
    supportedHarnessNames(snap),
    "Claude Code, Codex, Gemini CLI, and Acme Coder",
    "a newly registered provider appears in supported-provider copy without a markup edit",
  );
}

// --- A machine entry with no catalog match is dropped rather than rendered without file metadata,
// which would produce cells pointing at undefined paths. ---
{
  const snap = {
    harnesses: catalog,
    machineHarnesses: [
      { id: "claude", displayName: "Claude Code", enabled: true, confidence: "confirmed" },
      { id: "ghost", displayName: "Ghost", enabled: true, confidence: "possible" },
    ],
  };
  assert.deepEqual(presentedHarnesses(snap).map((h) => h.id), ["claude"], "unknown provider ids are dropped");
}

// --- Older snapshot without machineHarnesses falls back to the catalog: showing the previous view
// beats rendering an empty grid on a machine that does have harnesses. ---
{
  assert.equal(presentedHarnesses({ harnesses: catalog }).length, 3, "missing machineHarnesses falls back to catalog");
  assert.deepEqual(presentedHarnesses({}), [], "an empty snapshot presents nothing rather than throwing");
}

// --- List formatting across the same zero/one/two/N boundaries. ---
assert.equal(formatHarnessList([]), "");
assert.equal(formatHarnessList(["Codex"]), "Codex");
assert.equal(formatHarnessList(["Claude Code", "Codex"]), "Claude Code and Codex");
assert.equal(formatHarnessList(["A", "B", "C"]), "A, B, and C");

console.log("harness cohort presentation checks passed");
