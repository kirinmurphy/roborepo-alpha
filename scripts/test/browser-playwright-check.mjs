#!/usr/bin/env node
// The Playwright provider against real Chromium: where it finds Playwright (project first, then
// RoboRepo's tool directory, otherwise blocked with the install command), project test files run by
// the project's own runner without touching its manifest or lockfile, and recording.
//
// Skips with a visible `skip:` line when Chromium is not installed, matching
// scripts/test/portal-ui/run.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { STATUS, validateRunResult } from "../cli/browser/result.mjs";
import { createEvidenceRun } from "../cli/browser/evidence.mjs";
import { playwrightProvider } from "../cli/browser/playwright-provider.mjs";
import { toolsDir } from "../cli/browser/playwright-resolve.mjs";

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

  // ---- Partial browser caches, through the CLI: what probe promises, run can deliver ----
  const cacheRoot = browserCacheRoot(chromium.executablePath());
  const cliHome = path.join(tempRoot, "cli-home");
  fs.mkdirSync(path.join(cliHome, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(cliHome, ".codex"), { recursive: true });
  assert.equal((await cli(cliHome, null, ["package", "enable", "feature-verification"])).code, 0);

  // Full Chromium without the headless shell cannot launch headless, so it is not "available".
  const fullOnly = partialCache(cacheRoot, (name) => /^chromium-\d+$/.test(name));
  const noShell = JSON.parse((await cli(cliHome, fullOnly, ["browser", "probe", "--dir", project, "--json"])).stdout);
  assert.equal(noShell.available, false, "Chromium without its headless shell is not available");
  assert.match(noShell.limitations.join("\n"), /install chromium/, "the limitation names the browser install command");

  // Without ffmpeg, video is reported unavailable and a run says so instead of dropping it.
  const noFfmpeg = partialCache(cacheRoot, (name) => /^chromium(_headless_shell)?-\d+$/.test(name));
  const probed = JSON.parse((await cli(cliHome, noFfmpeg, ["browser", "probe", "--dir", project, "--json"])).stdout);
  assert.deepEqual(probed.capabilities, { screenshot: true, video: false, trace: true });
  assert.match(probed.limitations.join("\n"), /install ffmpeg/, "missing video support names the ffmpeg install command");
  const noVideo = JSON.parse((await cli(cliHome, noFfmpeg, ["browser", "run", "--scenario", recorded, "--url", app.url, "--capture", "video", "--json"])).stdout);
  assert.equal(noVideo.status, STATUS.PASSED);
  assert.ok(!noVideo.artifacts.some((artifact) => artifact.type === "video"), "no video is fabricated");
  assert.match(noVideo.limitations.join("\n"), /video capture unavailable/);

  console.log("ok: browser playwright provider (resolution, spec runs, no project mutation, recording)");
} finally {
  app.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

async function run({ scenarioPath, capture = [], stateRoot }) {
  const evidence = createEvidenceRun(stateRoot);
  const result = await playwrightProvider.run({ scenarioPath, capture, url: app.url, evidence, stateRoot, timeoutMs: 60_000 });
  return validateRunResult(result);
}

function writeScript(dir, name, body) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, `export default async function ({ page, url, check }) {\n  await page.goto(url);\n${body}\n}\n`);
  return file;
}

// A browser cache holding only some of the real one's entries, linked rather than copied.
function partialCache(root, keep) {
  const dir = fs.mkdtempSync(path.join(tempRoot, "cache-"));
  for (const name of fs.readdirSync(root).filter(keep)) {
    fs.symlinkSync(path.join(root, name), path.join(dir, name), "junction");
  }
  return dir;
}

function browserCacheRoot(executable) {
  let dir = path.dirname(executable);
  while (!/^chromium(_headless_shell)?-\d+$/.test(path.basename(dir))) dir = path.dirname(dir);
  return path.dirname(dir);
}

// Asynchronous, because the fixture app is served from this process.
function cli(home, browsersPath, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(repoRoot, "scripts", "cli", "main.mjs"), ...args], {
      env: {
        ...process.env,
        HOME: home,
        ROBOREPO_STATE_DIR: path.join(home, ".roborepo"),
        SKIP_MCP: "1",
        ...(browsersPath ? { PLAYWRIGHT_BROWSERS_PATH: browsersPath } : {}),
      },
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("close", (code) => resolve({ code, stdout }));
  });
}

function snapshot(dir, names) {
  return names.map((name) => fs.readFileSync(path.join(dir, name)).toString("base64"));
}

function startFixtureApp() {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end("<!doctype html><title>Fixture</title><h1>Fixture</h1>");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() });
    });
  });
}
