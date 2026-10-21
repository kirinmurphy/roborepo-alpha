#!/usr/bin/env node
// The response-output rules package and the marker packages that used to depend on it.
//
// - Every rules-capable harness renders the same response-output block when enabled, and none of
//   it when disabled.
// - The rules load every turn, so they stay within their size budget and never repeat a sentence
//   the always-on shared fragments already say.
// - With caveman enabled too, the precedence paragraph that keeps outcome, decisions, and evidence
//   status is still rendered.
// - The marker packages stand alone: no `requires`, and each states its own placement.
// - No live file still names the old `response-shape` package.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { harnessIdsWithCapability, renderRulesPreview, renderSharedRulesPreview } from "../cli/rules-render.mjs";
import { loadPackageCatalog } from "../cli/package-catalog.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const rulesPath = path.join(repoRoot, "globals", "packages", "response-output", "rules.md");
const rules = fs.readFileSync(rulesPath, "utf8");
const MAX_RULE_LINES = 78;
const MARKERS = ["impact-awareness", "convention-capture", "skill-visibility"];

// ---- Same text in every harness when enabled, none when disabled ----
const harnesses = harnessIdsWithCapability("rules");
assert.ok(harnesses.length >= 3, "claude, codex, and gemini all render rules");
const block = rules.trim();
for (const harness of harnesses) {
  assert.ok(renderRulesPreview(harness, ["response-output"]).includes(block), `${harness} renders the full response-output block`);
  assert.ok(!renderRulesPreview(harness, []).includes("## Response Output"), `${harness} renders none of it when disabled`);
}

// ---- Size and no duplication of always-on fragments ----
const lineCount = rules.trimEnd().split("\n").length;
assert.ok(lineCount <= MAX_RULE_LINES, `response-output rules are ${lineCount} lines; the budget is ${MAX_RULE_LINES}`);
const shared = normalize(renderSharedRulesPreview());
for (const sentence of sentences(rules)) {
  assert.ok(!shared.includes(sentence), `response-output repeats a shared fragment: "${sentence}"`);
}

// ---- Caveman coexistence ----
const both = normalize(renderRulesPreview("claude", ["response-output", "caveman"]));
assert.ok(both.includes("Use caveman full by default."), "caveman's own rule renders");
assert.ok(both.includes("an enabled caveman mode counts as one"), "the caveman precedence sentence renders beside caveman");
assert.ok(both.includes("Marking something unverified is evidence status, not hedging."));

// ---- Marker packages stand alone ----
const catalog = loadPackageCatalog({ includeUnavailable: true });
for (const id of MARKERS) {
  const pkg = catalog.find((entry) => entry.id === id);
  assert.ok(pkg, `${id} is in the catalog`);
  assert.deepEqual(pkg.requires ?? [], [], `${id} requires no other package`);
  const markerRules = fs.readFileSync(path.join(repoRoot, "globals", "packages", id, "rules.md"), "utf8");
  assert.match(markerRules, /on its own line at the end of the response, never inside a paragraph/, `${id} states its own placement`);
}

// ---- No live reference to the old package id ----
// Plan documents record history and other plans' reasoning, so docs/plans/ is excluded.
const grep = spawnSync("git", ["grep", "-l", "response-shape", "--", ".", ":(exclude)docs/plans/**", ":(exclude)scripts/test/response-output-rules-check.mjs"], {
  cwd: repoRoot,
  encoding: "utf8",
});
assert.equal(grep.stdout.trim(), "", `files still name response-shape:\n${grep.stdout}`);

console.log(`ok: response-output rules (${lineCount} lines, ${harnesses.length} harnesses, markers standalone)`);

function sentences(text) {
  return normalize(text.replace(/```[\s\S]*?```/g, ""))
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.replace(/^[-*#\s]+/, "").trim())
    .filter((sentence) => sentence.split(" ").length >= 6);
}

function normalize(text) {
  return text.replace(/\s+/g, " ");
}
