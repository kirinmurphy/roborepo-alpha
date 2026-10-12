#!/usr/bin/env node
// `roborepo skill triggers --check` discovers fixtures through the package catalog: each package
// may own a skill-triggers.json at its root. Each case builds a throwaway app root holding only
// synthetic packages and runs the command against it, asserting on exit code and output.
//
// The command runs through its exported entry point rather than main.mjs because the CLI's command
// catalog lives under the app root too; copying it in would test the fixture copy, not the check.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHECK_MODULE = path.join(repoRoot, "scripts", "cli", "skill-trigger-check.mjs");
const DESCRIPTION = "Use when drafting a widget report. Do not use for PR descriptions.";

const VALID_FIXTURE = {
  skill: "widget",
  match: ["draft a widget report for this release"],
  nearMiss: ["write a PR summary"],
  triggerPhrases: ["widget report"],
  skipPhrases: ["PR descriptions"],
};

function withAppRoot(packages, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-trigger-fixtures-"));
  try {
    const appRoot = path.join(root, "app");
    fs.mkdirSync(path.join(appRoot, ".git"), { recursive: true });
    fs.mkdirSync(path.join(appRoot, "manifests", "inventory"), { recursive: true });
    fs.copyFileSync(
      path.join(repoRoot, "manifests", "inventory", "package-categories.json"),
      path.join(appRoot, "manifests", "inventory", "package-categories.json"),
    );
    const workspaceRoot = path.join(root, "workspace");
    for (const pkg of packages) {
      writePackage(pkg.workspace ? path.join(workspaceRoot, "packages") : path.join(appRoot, "globals", "packages"), pkg);
    }
    return run({
      ...process.env,
      ROBOREPO_APP_ROOT: appRoot,
      ROBOREPO_STATE_ROOT: path.join(root, "state"),
      ROBOREPO_WORKSPACE_ROOT: workspaceRoot,
      ROBOREPO_MODE: "development",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// triggers: an object is written as JSON, a string is written verbatim (for malformed input),
// and undefined writes no skill-triggers.json at all. workspace: true places the package in the
// user workspace instead of the app's built-ins.
function writePackage(packagesDir, { id, skills = [id], triggers, description = DESCRIPTION }) {
  const dir = path.join(packagesDir, id);
  for (const skill of skills) {
    fs.mkdirSync(path.join(dir, "skills", skill), { recursive: true });
    fs.writeFileSync(path.join(dir, "skills", skill, "SKILL.md"), `---\nname: ${skill}\ndescription: ${description}\n---\n`);
  }
  const config = {
    schemaVersion: 1,
    id,
    label: id,
    description: `${id} package.`,
    lifecycle: "optional",
    presentation: { category: "skills-dev-lifecycle", order: 1 },
    resources: skills.map((skill) => ({ type: "skill", id: skill, source: `skills/${skill}`, invocation: "auto", risk: "medium" })),
  };
  fs.writeFileSync(path.join(dir, "package.config.json"), `${JSON.stringify(config, null, 2)}\n`);
  if (triggers === undefined) return;
  const body = typeof triggers === "string" ? triggers : `${JSON.stringify(triggers, null, 2)}\n`;
  fs.writeFileSync(path.join(dir, "skill-triggers.json"), body);
}

function runCheck(packages) {
  return withAppRoot(packages, (env) => {
    const script = `import(${JSON.stringify(CHECK_MODULE)}).then((m) => m.skillTriggerCheck(["--check"]))`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8" });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  });
}

// --- A package with no skill-triggers.json contributes nothing and passes. ---
{
  const result = runCheck([{ id: "plain" }]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ok: 0 skill trigger fixture\(s\)$/m);
}

// --- A valid fixture passes and is counted. ---
{
  const result = runCheck([{ id: "widget", triggers: { tests: [VALID_FIXTURE] } }, { id: "plain" }]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ok: 1 skill trigger fixture\(s\)$/m);
}

// --- A workspace package's fixtures are discovered through the same catalog. ---
{
  const result = runCheck([{ id: "widget", workspace: true, triggers: { tests: [VALID_FIXTURE] } }]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ok: 1 skill trigger fixture\(s\)$/m);
}

// --- A package's fixtures may cover several skills it declares. ---
{
  const second = { ...VALID_FIXTURE, skill: "gadget" };
  const result = runCheck([{ id: "widget", skills: ["widget", "gadget"], triggers: { tests: [VALID_FIXTURE, second] } }]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ok: 2 skill trigger fixture\(s\)$/m);
}

// --- A description missing a trigger phrase fails and names the skill. ---
{
  const result = runCheck([{ id: "widget", description: "Use for widgets.", triggers: { tests: [VALID_FIXTURE] } }]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^fail: widget: description missing trigger phrase\(s\): widget report$/m);
}

// --- A fixture naming a skill its own package does not declare fails, even if another package does. ---
{
  const result = runCheck([
    { id: "widget" },
    { id: "other", triggers: { tests: [VALID_FIXTURE] } },
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^fail: .*other[/\\]skill-triggers\.json: fixture names skill 'widget', which package 'other' does not declare$/m);
}

// --- Malformed JSON fails and names the file. ---
{
  const result = runCheck([{ id: "widget", triggers: "{ not json" }]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^fail: .*widget[/\\]skill-triggers\.json: invalid JSON: /m);
}

// --- Unknown keys such as live-eval prompts pass through without failing the static check. ---
{
  const fixture = { ...VALID_FIXTURE, liveMatch: ["please draft the widget report"] };
  const result = runCheck([{ id: "widget", triggers: { tests: [fixture] } }]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ok: 1 skill trigger fixture\(s\)$/m);
}

console.log("ok: skill-trigger-fixtures-check");
