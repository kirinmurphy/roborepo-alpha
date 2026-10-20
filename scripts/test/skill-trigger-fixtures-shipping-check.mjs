#!/usr/bin/env node
// Trigger fixtures are test data, not agent instructions, so they must never reach a harness home
// or a client project. They sit at the package root precisely because skill directories are copied
// whole; a copy path that starts copying package roots would ship them to agents silently.
//
// Runs the real CLI against an isolated app root and home: sync shared skills into the home, export
// them into a throwaway project, then search both for any skill-triggers.json.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeIsolatedCli } from "./app-root-fixture.mjs";

const FIXTURE_FILE = "skill-triggers.json";

const cli = makeIsolatedCli({ prefix: "roborepo-trigger-shipping-" });
const project = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-trigger-shipping-project-"));
try {
  fs.mkdirSync(path.join(project, ".git"));
  runCli(["skill", "sync-global"], cli.home);
  runCli(["skill", "export-to-project", "--yes", "--on-conflict=skip"], project);

  // Without a fixture-bearing skill among the copies, "no fixture found" would prove nothing.
  const fixtureSkills = skillsWithFixtures(path.join(cli.appRoot, "globals", "packages"));
  for (const dir of [path.join(cli.home, ".roborepo", "skills"), path.join(project, ".claude", "skills")]) {
    const copied = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    assert.ok(
      copied.some((name) => fixtureSkills.has(name)),
      `${dir} holds no skill whose package has ${FIXTURE_FILE}; the check would pass vacuously`,
    );
  }

  const leaked = [...findFixtureFiles(cli.home), ...findFixtureFiles(project)];
  assert.deepEqual(leaked, [], `${FIXTURE_FILE} was copied out of its package:\n${leaked.join("\n")}`);
} finally {
  cli.cleanup();
  fs.rmSync(project, { recursive: true, force: true });
}

console.log("ok: skill-trigger-fixtures-shipping-check");

function runCli(args, cwd) {
  const main = path.join(cli.appRoot, "scripts", "cli", "main.mjs");
  const result = spawnSync(process.execPath, [main, ...args], { cwd, env: cli.env, encoding: "utf8" });
  assert.equal(result.status, 0, `roborepo ${args.join(" ")} failed:\n${result.stderr}`);
}

function skillsWithFixtures(packagesDir) {
  const skills = new Set();
  for (const id of fs.readdirSync(packagesDir)) {
    if (!fs.existsSync(path.join(packagesDir, id, FIXTURE_FILE))) continue;
    const config = JSON.parse(fs.readFileSync(path.join(packagesDir, id, "package.config.json"), "utf8"));
    for (const resource of config.resources || []) {
      if (resource.type === "skill") skills.add(resource.id);
    }
  }
  return skills;
}

function findFixtureFiles(root) {
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === FIXTURE_FILE)
    .map((entry) => path.join(entry.parentPath, entry.name));
}
