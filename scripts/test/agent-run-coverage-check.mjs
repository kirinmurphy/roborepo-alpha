#!/usr/bin/env node
// ROBOREPO DEVELOPMENT CHECK — not a runtime guard, and nothing in the shipped CLI calls it.
//
// Purpose: catch drift between the roborepo CLI's real command surface and the permission
// manifest. Every roborepo namespace should be DELIBERATELY classified — allowlisted as
// read-only (inspect-install), or ask-bucketed as config-mutating (mutate-harness-config).
// A namespace that is neither is not a bug in itself; it is an unreviewed decision, and the
// failure mode is silent: it inherits whatever the default happens to be.
//
// This exists because enumerated command lists drift as the CLI grows, which is exactly the
// problem behaviors were introduced to avoid. The behaviors stay semantic; this check makes
// sure a NEW namespace can't slip past unclassified.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
process.env.ROBOREPO_APP_ROOT = repoRoot;

const manifest = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "manifests", "inventory", "agent-permissions.json"), "utf8"),
);

// --- the CLI's actual top-level surface, read from the command definition manifests ----------
const defsRoot = path.join(repoRoot, "manifests", "platform", "cli", "command-definitions");

function collectCommandFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectCommandFiles(full));
    else if (entry.name.endsWith(".command.json") || entry.name.endsWith(".namespace.json")) out.push(full);
  }
  return out;
}

const topLevel = new Set();
for (const file of collectCommandFiles(defsRoot)) {
  const def = JSON.parse(fs.readFileSync(file, "utf8"));
  if (Array.isArray(def.path) && def.path.length > 0) topLevel.add(String(def.path[0]));
}
assert.ok(topLevel.size > 0, "fixture assumption: command definitions declare top-level paths");

// --- how the manifest classifies each roborepo token ------------------------------------------
const classified = new Map(); // token -> bucket
for (const b of manifest.behaviors ?? []) {
  if (b.kind !== "commands") continue;
  for (const tokens of b.commands ?? []) {
    if (tokens[0] !== "roborepo") continue;
    if (tokens.length >= 2) classified.set(String(tokens[1]), b.bucket);
  }
}
for (const tokens of manifest.commands?.allow ?? []) {
  if (tokens[0] === "roborepo" && tokens.length >= 2) classified.set(String(tokens[1]), "allow");
}

// Namespaces that are intentionally left unclassified — they fall through to a prompt, which is
// the safe default. Listed explicitly so the omission is a decision on the record, not an
// oversight. Add here only after deciding a prompt is the right behavior.
const INTENTIONALLY_UNCLASSIFIED = new Set([
  "help",
  "web", // opens a browser; harmless but interactive, so prompting is correct
  // Unrestricted by design; must never be allowlisted. Asserted below.
  "run",
  // `browser run` executes scenario code, so a `roborepo browser` prefix entry would authorize
  // arbitrary code without a prompt. Asserted below.
  "browser",
]);

const unclassified = [...topLevel]
  .filter((cmd) => !classified.has(cmd))
  .filter((cmd) => !INTENTIONALLY_UNCLASSIFIED.has(cmd))
  .sort();

if (unclassified.length > 0) {
  console.error("agent-run-coverage-check: FAIL");
  console.error("");
  console.error("These roborepo commands are neither allowlisted nor ask-bucketed in");
  console.error("manifests/inventory/agent-permissions.json:");
  console.error("");
  for (const cmd of unclassified) console.error(`  roborepo ${cmd}`);
  console.error("");
  console.error("Decide for each one, then record it:");
  console.error("  read-only / safe unattended -> add to the 'inspect-install' behavior (allow)");
  console.error("  mutates config or state     -> add to the 'mutate-harness-config' behavior (ask)");
  console.error("  should always prompt        -> add to INTENTIONALLY_UNCLASSIFIED in this file");
  process.exit(1);
}

// --- the two classifying behaviors must keep existing ------------------------------------------
// If either is renamed or dropped, the check above silently passes for everything.
const behaviorIds = new Set((manifest.behaviors ?? []).map((b) => b.id));
assert.ok(behaviorIds.has("inspect-install"), "manifest must keep an 'inspect-install' behavior for this check to mean anything");
assert.ok(behaviorIds.has("mutate-harness-config"), "manifest must keep a 'mutate-harness-config' behavior for this check to mean anything");

// --- agent-run must never be reachable as an allowlisted roborepo subcommand of itself ---------
assert.equal(classified.get("run"), undefined, "plain `roborepo run` must NOT be bucketed allow — its payload is invisible to the prefix matcher");
assert.equal(classified.get("browser"), undefined, "`roborepo browser` must NOT be bucketed — `browser run` executes scenario code and must always prompt");

// agent-run IS manifest-allowed (that is the point: one safe prefix for the harness allowlist),
// so the only thing keeping it from laundering a payload is the policy's nesting refusal. Pin
// that the two facts stay consistent against the LIVE manifest, not the policy test's fixture.
const { checkAgentRun } = await import("../cli/agent-run-policy.mjs");
assert.equal(classified.get("agent-run"), "allow", "agent-run is the one roborepo command meant to be allowlisted");
assert.equal(
  checkAgentRun(["roborepo", "agent-run", "npm", "test"], manifest).ok,
  false,
  "...and it must still refuse to invoke itself, or the allowlist entry becomes a laundering path",
);

console.log(`agent-run-coverage-check: ok (${topLevel.size} top-level commands, ${classified.size} classified)`);
