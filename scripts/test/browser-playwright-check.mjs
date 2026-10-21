#!/usr/bin/env node
// The Playwright provider against real Chromium: where it finds Playwright (project first, then
// RoboRepo's tool directory, otherwise blocked with the install command), project test files run by
// the project's own runner without touching its manifest or lockfile, timeouts that stop the
// runner's webServer, and recording. Partial browser caches are browser-playwright-cache-check.mjs.
//
// Skips with a visible `skip:` line when Chromium is not installed, matching
// scripts/test/portal-ui/run.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { STATUS, validateRunResult } from "../cli/browser/result.mjs";
import { createEvidenceRun } from "../cli/browser/evidence.mjs";
import { playwrightProvider } from "../cli/browser/playwright-provider.mjs";
import { toolsDir } from "../cli/browser/playwright-resolve.mjs";
import { freePort, responds, startFixtureApp, waitFor } from "./lib/local-http.mjs";

if (!fs.existsSync(chromium.executablePath())) {
  console.log("skip: browser playwright provider (chromium not installed; run `npx playwright install chromium`)");
  process.exit(0);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const modules = path.join(repoRoot, "node_modules");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-browser-playwright-"));
const app = await startFixtureApp();

try {
  // ---- Neither the project nor the tool directory has Playwright: blocked, nothing installed ----
  const bareState = path.join(tempRoot, "bare-state");
  const loose = writeScript(path.join(tempRoot, "loose"), "observe.mjs", "");
  const blocked = await run({ scenarioPath: loose, stateRoot: bareState });
  assert.equal(blocked.status, STATUS.BLOCKED);
  assert.match(blocked.limitations.join("\n"), /npm install --prefix .*playwright@\d/, "blocked names the exact install command");
  assert.ok(!fs.existsSync(toolsDir(bareState)), "a blocked run installs nothing");

  // ---- The tool directory is used when the project has no Playwright ----
  const toolState = path.join(tempRoot, "tool-state");
  fs.mkdirSync(path.join(toolsDir(toolState), "node_modules"), { recursive: true });
  for (const name of ["playwright", "playwright-core"]) {
    fs.symlinkSync(path.join(modules, name), path.join(toolsDir(toolState), "node_modules", name), "junction");
  }
  const fromTools = await run({ scenarioPath: loose, stateRoot: toolState });
  assert.equal(fromTools.status, STATUS.UNVERIFIED, "a navigation without check() is unverified");

  // ---- A project test file runs under the project's runner and leaves the project untouched ----
  const project = path.join(tempRoot, "project");
  fs.mkdirSync(path.join(project, "tests"), { recursive: true });
  fs.symlinkSync(modules, path.join(project, "node_modules"), "junction");
  fs.writeFileSync(path.join(project, "package.json"), '{\n  "name": "fixture",\n  "private": true,\n  "type": "module"\n}\n');
  fs.writeFileSync(path.join(project, "package-lock.json"), '{\n  "name": "fixture",\n  "lockfileVersion": 3\n}\n');
  fs.writeFileSync(path.join(project, "playwright.config.mjs"), 'export default { testDir: "./tests", use: { screenshot: "on" } };\n');
  fs.writeFileSync(path.join(project, "tests", "page.spec.mjs"), [
    'import { test, expect } from "@playwright/test";',
    'test("heading renders", async ({ page }) => {',
    "  await page.goto(process.env.ROBOREPO_BROWSER_URL);",
    '  await expect(page.getByRole("heading")).toHaveText("Fixture");',
    "});",
    'test("wrong heading", async ({ page }) => {',
    "  await page.goto(process.env.ROBOREPO_BROWSER_URL);",
    '  await expect(page.getByRole("heading")).toHaveText("Other", { timeout: 500 });',
    "});",
    "",
  ].join("\n"));
  const before = snapshot(project, ["package.json", "package-lock.json"]);
  const spec = await run({ scenarioPath: path.join(project, "tests", "page.spec.mjs"), capture: ["screenshot", "video"], stateRoot: toolState });
  assert.equal(spec.status, STATUS.FAILED, "one failing test fails the run");
  assert.deepEqual(spec.checks.map((check) => [check.name, check.status]), [["heading renders", "passed"], ["wrong heading", "failed"]]);
  assert.ok(spec.artifacts.some((artifact) => artifact.type === "screenshot"), "the config's screenshots are adopted as evidence");
  assert.match(spec.limitations.join("\n"), /video not captured/, "a capture the config does not produce is a limitation");
  assert.deepEqual(snapshot(project, ["package.json", "package-lock.json"]), before, "package.json and lockfile are byte-identical");

  // ---- Recording is set up before the run and finalized after the context closes ----
  const recorded = writeScript(path.join(project, "scripts"), "record.mjs", `  await check("heading renders", async () => {
    if ((await page.getByRole("heading").textContent()) !== "Fixture") throw new Error("wrong heading");
  });`);
  const canRecord = (await playwrightProvider.probe({ dir: project, stateRoot: toolState })).capabilities.video;
  const video = await run({ scenarioPath: recorded, capture: ["video"], stateRoot: toolState });
  assert.equal(video.status, STATUS.PASSED);
  if (canRecord) {
    assert.ok(video.artifacts.some((artifact) => artifact.type === "video" && fs.statSync(artifact.path).size > 0), "a finalized video is returned");
  }

  // ---- A spec that outlives --timeout fails, and the runner's webServer is shut down with it ----
  const slow = path.join(tempRoot, "slow-project");
  const serverPort = await freePort();
  fs.mkdirSync(path.join(slow, "tests"), { recursive: true });
  fs.symlinkSync(modules, path.join(slow, "node_modules"), "junction");
  fs.writeFileSync(path.join(slow, "package.json"), '{ "name": "slow", "private": true, "type": "module" }\n');
  fs.writeFileSync(path.join(slow, "srv.mjs"), 'import http from "node:http";\nhttp.createServer((q, r) => r.end("ok")).listen(Number(process.argv[2]), "127.0.0.1");\n');
  fs.writeFileSync(path.join(slow, "playwright.config.mjs"), `export default { testDir: "./tests", webServer: { command: "node srv.mjs ${serverPort}", url: "http://127.0.0.1:${serverPort}/" } };\n`);
  fs.writeFileSync(path.join(slow, "tests", "slow.spec.mjs"), 'import { test } from "@playwright/test";\ntest("never finishes in time", async () => { await new Promise((r) => setTimeout(r, 60_000)); });\n');
  const timedOut = await run({ scenarioPath: path.join(slow, "tests", "slow.spec.mjs"), stateRoot: toolState, timeoutMs: 8_000 });
  assert.equal(timedOut.status, STATUS.FAILED, "a spec that runs past --timeout failed; it did execute");
  assert.match(timedOut.checks[0].message, /timed out/);
  await waitFor(async () => !(await responds(serverPort)), 15_000);

  console.log("ok: browser playwright provider (resolution, spec runs, no project mutation, recording)");
} finally {
  app.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

async function run({ scenarioPath, capture = [], stateRoot, timeoutMs = 60_000 }) {
  const evidence = createEvidenceRun(stateRoot);
  const result = await playwrightProvider.run({ scenarioPath, capture, url: app.url, evidence, stateRoot, timeoutMs });
  return validateRunResult(result);
}

function writeScript(dir, name, body) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, `export default async function ({ page, url, check }) {\n  await page.goto(url);\n${body}\n}\n`);
  return file;
}

function snapshot(dir, names) {
  return names.map((name) => fs.readFileSync(path.join(dir, name)).toString("base64"));
}

