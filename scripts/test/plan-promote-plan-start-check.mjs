#!/usr/bin/env node
// Dedicated coverage for the plan-promote / plan-start standalone skill packages: discoverability,
// frontmatter parsing, generated-command wiring, package validation, and boundary text. Comparable
// skill-command packages (e.g. integration-check) rely only on the generic catalog tests
// (package-catalog-check.mjs); these two get their own file because their SKILL.md bodies encode
// explicit "do not use for" boundaries against each other and against plan-docs/integration-check,
// which is worth asserting directly rather than only through the generic allowlist checks.
//
// Also covers plan-start's worktree-root resolution: the config shape in plans-config.json and the
// SKILL.md phrases that commit to a specific first-run gate. That gate has no executable code path
// (plan-start is agent-followed prose), so this is prose-presence coverage, not behavioral proof.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadPackageCatalog, validatePackageCatalog } from "../cli/package-catalog.mjs";
import { loadSlashCommandPlan } from "../cli/slash-commands.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repoRoot, "scripts/cli/main.mjs");

const SKILLS = {
  "plan-promote": {
    boundaryPhrases: [
      "implement feature code",
      "create a feature branch or worktree",
      "change plan lifecycle",
    ],
  },
  "plan-start": {
    boundaryPhrases: [
      "create a second implementation plan",
      "change lifecycle state",
      "perform closeout or merge orchestration",
    ],
    // Worktree-root resolution has no executable code path -- plan-start is agent-followed prose,
    // not a script -- so these phrases are the only enforcement that the gate behavior survives
    // future edits to the skill: propose-and-wait on first use, then persist so later runs on the
    // same repository do not re-prompt.
    worktreeRootPhrases: [
      "worktreeRoot",
      "~/.worktrees",
      "wait for the user to confirm or override",
      "write the resulting path",
      "one-time gate per",
    ],
  },
};

// --- SKILL.md discoverability + frontmatter ---
for (const [id, { boundaryPhrases }] of Object.entries(SKILLS)) {
  const skillPath = path.join(repoRoot, "globals/packages", id, "skills", id, "SKILL.md");
  assert.ok(fs.existsSync(skillPath), `${id}: SKILL.md missing at ${skillPath}`);

  const text = fs.readFileSync(skillPath, "utf8");
  const frontmatterMatch = text.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(frontmatterMatch, `${id}: SKILL.md has no parsable frontmatter block`);

  const nameMatch = frontmatterMatch[1].match(/^name:\s*(.+)$/m);
  assert.ok(nameMatch, `${id}: frontmatter missing name field`);
  assert.equal(nameMatch[1].trim(), id, `${id}: frontmatter name must match folder name`);

  const descMatch = frontmatterMatch[1].match(/^description:\s*(.+)$/m);
  assert.ok(descMatch && descMatch[1].trim().length > 0, `${id}: frontmatter description must be non-empty`);

  for (const phrase of boundaryPhrases) {
    assert.ok(text.includes(phrase), `${id}: SKILL.md missing expected boundary phrase "${phrase}"`);
  }

  // Match against whitespace-normalized text: SKILL.md hard-wraps prose, so a phrase spanning a
  // line break would otherwise fail on the literal newline.
  const normalizedText = text.replace(/\s+/g, " ");
  for (const phrase of SKILLS[id].worktreeRootPhrases || []) {
    assert.ok(normalizedText.includes(phrase), `${id}: SKILL.md missing expected worktree-root phrase "${phrase}"`);
  }
}

// --- plan-start's start transition: worktree metadata, plan-only commit, validator gate ---
// Prose-presence coverage like the worktree-root gate above: the transition is agent-followed, so
// these assertions are what keep its ordering and refusal behavior from eroding in later edits.
{
  const skillDir = path.join(repoRoot, "globals/packages/plan-start/skills/plan-start");
  const normalize = (text) => text.replace(/\s+/g, " ");
  const skill = normalize(fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8"));
  const referencePath = path.join(skillDir, "references/start-validation.md");
  assert.ok(fs.existsSync(referencePath), "plan-start: references/start-validation.md missing");
  const reference = normalize(fs.readFileSync(referencePath, "utf8"));

  assert.ok(skill.includes("Read `references/start-validation.md` before"), "plan-start: SKILL.md must load the start-validation reference");
  const order = ["## Start Transition", "## Implementation Workflow"].map((heading) => skill.indexOf(heading));
  assert.ok(order[0] > 0 && order[0] < order[1], "plan-start: Start Transition must precede the Implementation Workflow");

  // The transition's steps must stay in this order: metadata, lifecycle move, plan-only commit,
  // fresh validation, and only then the context switch.
  const transition = skill.slice(order[0], order[1]);
  const steps = [
    "Write `worktree: <name>` into the canonical plan",
    "from `backlog/` to `active/`",
    "stage only the old and new canonical plan paths",
    "Run the start validator against fresh disk and Git state",
    "Enter the implementation worktree only after the validator returns `APPROVED`",
  ];
  let cursor = -1;
  for (const step of steps) {
    const at = transition.indexOf(step);
    assert.ok(at > cursor, `plan-start: start transition step missing or out of order: "${step}"`);
    cursor = at;
  }
  for (const phrase of ["Do not push", "at most three correction passes", "not the checkout directory's basename", "configuration-only commit"]) {
    assert.ok(transition.includes(phrase), `plan-start: start transition missing "${phrase}"`);
  }

  for (const phrase of [
    "rev-parse --absolute-git-dir",
    "Never use `git add -A` or `.`",
    "Never fold it into the transition commit",
    "Do not push",
    "Enter the target worktree only on `APPROVED`",
    "at most three correction passes",
    "do not enter the target worktree",
    "Read every fact fresh",
    "lists only the plan's rename (`R`) or modification (`M`)",
    "status --porcelain -- docs/plans",
    "Execution is still in the primary checkout",
  ]) {
    assert.ok(reference.includes(phrase), `plan-start: start-validation.md missing "${phrase}"`);
  }

  assert.ok(skill.includes("move it from `backlog/` to `active/` with `git mv`"), "plan-start: SKILL.md must own the backlog-to-active move");
}

// --- plan-start's run mode: no check-ins, strict autonomy bar, queued questions batched at the end ---
// Prose-presence coverage: these phrases carry the run-to-completion contract, which has no code path.
{
  const skill = fs.readFileSync(path.join(repoRoot, "globals/packages/plan-start/skills/plan-start/SKILL.md"), "utf8").replace(/\s+/g, " ");
  for (const phrase of [
    "Do not stop for milestone, phase, or slice check-ins",
    "Do not ask the user anything during implementation",
    "Decide autonomously only when **all** of these hold",
    "Reversibility alone is not enough",
    "Always block, never decide",
    "## Decision Log",
    "## Open Questions",
    "every task that depends on it",
    "present every open entry to the user in one batch",
    "the run resumes in this same mode",
    "`model: sonnet`",
    "Never pass `isolation: \"worktree\"`",
    "reports it back instead of choosing",
  ]) {
    assert.ok(skill.includes(phrase), `plan-start: SKILL.md missing run-mode phrase "${phrase}"`);
  }
}

// --- plans-config.json stays valid JSON and, when present, worktreeRoot is a well-formed string ---
// worktreeRoot is optional and currently absent by default in this repo's own plans-config.json
// (a user can remove it to re-trigger plan-start's first-time confirmation gate), so this only
// asserts the shape when the key exists rather than requiring it.
{
  const configPath = path.join(repoRoot, "docs/plans/plans-config.json");
  assert.ok(fs.existsSync(configPath), `plans-config.json missing at ${configPath}`);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if ("worktreeRoot" in config) {
    assert.equal(typeof config.worktreeRoot, "string", "worktreeRoot must be a string when present");
    assert.ok(config.worktreeRoot.trim().length > 0, "worktreeRoot must not be an empty string when present");
  }
}

// --- package.config.json loads and validates through the real catalog ---
const catalog = loadPackageCatalog({ includeUnavailable: true });
validatePackageCatalog(catalog);

const byId = new Map(catalog.map((pkg) => [pkg.id, pkg]));
for (const id of Object.keys(SKILLS)) {
  assert.ok(byId.has(id), `catalog missing package: ${id}`);
  const pkg = byId.get(id);
  const skillResource = pkg.resources.find((r) => r.type === "skill" && r.id === id);
  assert.ok(skillResource, `${id}: package.config.json has no matching skill resource`);
  assert.equal(skillResource.invocation, "manual", `${id}: skill resource should be manually invoked`);
}
assert.equal(byId.get("plan-promote").resources[0].risk, "medium", "plan-promote should be risk: medium");
assert.equal(byId.get("plan-start").resources[0].risk, "high", "plan-start should be risk: high");

// --- generated slash commands exist for every harness and point at the right SKILL.md ---
const slashPlan = loadSlashCommandPlan();
const slashNames = new Set(slashPlan.commands.map((c) => c.name));
for (const id of Object.keys(SKILLS)) {
  assert.ok(slashNames.has(id), `missing slash command: ${id}`);
}

for (const harness of ["claude", "codex", "gemini"]) {
  for (const id of Object.keys(SKILLS)) {
    const generatedPath = path.join(repoRoot, "generated/packages", id, harness, "commands", `${id}.md`);
    assert.ok(fs.existsSync(generatedPath), `missing generated command: ${generatedPath}`);
    const body = fs.readFileSync(generatedPath, "utf8");
    assert.ok(body.includes(`/${harness === "claude" ? ".claude" : harness === "codex" ? ".codex" : ".gemini"}/skills/${id}/SKILL.md`),
      `${generatedPath} does not reference the correct SKILL.md read path`);
  }
}

// --- package enablement / dry-run round trip via the real CLI ---
for (const id of Object.keys(SKILLS)) {
  const result = spawnSync(process.execPath, [cli, "package", "validate", id], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `roborepo package validate ${id} failed: ${result.stderr}\n${result.stdout}`);
}

console.log("ok: plan-promote / plan-start discoverability, frontmatter, generated commands, and boundaries");
