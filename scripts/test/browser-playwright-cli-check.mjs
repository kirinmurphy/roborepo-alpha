#!/usr/bin/env node
// How a real Playwright run ends, seen from outside the CLI process:
//
// - `--timeout` bounds the command, not just the result: a script scenario still holding its own
//   timers does not keep `roborepo browser run` alive after the result is printed;
// - an interrupted spec run leaves none of its temp directories behind.
//
// Each run gets its own TMPDIR so leftovers are attributable. Skips with a visible `skip:` line
// when Chromium is not installed, matching scripts/test/portal-ui/run.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createBrowserCliHome } from "./lib/browser-cli-home.mjs";
import { startFixtureApp, waitFor } from "./lib/local-http.mjs";

if (!fs.existsSync(chromium.executablePath())) {
  console.log("skip: browser playwright CLI (chromium not installed; run `npx playwright install chromium`)");
  process.exit(0);
}

// The CLI runs under a temp HOME, which hides Playwright's per-user browser cache; point at it.
const browsersPath = /^(.*)[\\/]chromium-\d+[\\/]/.exec(chromium.executablePath())[1];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = createBrowserCliHome("roborepo-browser-pw-cli-");
const app = await startFixtureApp();

try {
  assert.equal(cli.run(["package", "enable", "feature-verification"]).status, 0);
  const project = path.join(cli.home, "project");
  fs.mkdirSync(path.join(project, "tests"), { recursive: true });
  fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(project, "node_modules"), "junction");
  fs.writeFileSync(path.join(project, "package.json"), '{ "name": "fixture", "private": true, "type": "module" }\n');
  fs.writeFileSync(path.join(project, "playwright.config.mjs"), 'export default { testDir: "./tests" };\n');

  // ---- A timed-out script scenario ends the command, despite its own pending timer ----
  const lingering = path.join(project, "lingering.mjs");
  fs.writeFileSync(lingering, "export default async function () { await new Promise((r) => setTimeout(r, 30_000)); }\n");
  const startedAt = Date.now();
  const timedOut = await browserRun(["--scenario", lingering, "--url", app.url, "--timeout", "3", "--json"], tmpDir("timeout"));
  const elapsed = Date.now() - startedAt;
  assert.equal(JSON.parse(timedOut.stdout).status, "failed", "a scenario that outlives --timeout fails");
  assert.ok(elapsed < 15_000, `the command ends near its timeout, not when the scenario's timer fires (${elapsed}ms)`);

  // ---- An interrupted spec run leaves no temp directory behind ----
  fs.writeFileSync(path.join(project, "tests", "slow.spec.mjs"), [
    'import { test } from "@playwright/test";',
    'test("runs long", async ({ page }) => {',
    "  await page.goto(process.env.ROBOREPO_BROWSER_URL);",
    "  await new Promise((r) => setTimeout(r, 60_000));",
    "});",
    "",
  ].join("\n"));
  const interruptedTmp = tmpDir("interrupt");
  const run = cli.start(
    ["browser", "run", "--scenario", path.join(project, "tests", "slow.spec.mjs"), "--url", app.url],
    { TMPDIR: interruptedTmp, PLAYWRIGHT_BROWSERS_PATH: browsersPath },
  );
  await waitFor(() => ownTempDirs(interruptedTmp).length > 0, 15_000);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  run.child.kill("SIGTERM");
  assert.equal((await run.done).status, 143);
  await waitFor(() => ownTempDirs(interruptedTmp).length === 0, 15_000);

  console.log("ok: browser playwright CLI (timeout ends the command, interrupt cleans temp dirs)");
} finally {
  app.close();
  cli.cleanup();
}

// Asynchronous, because the fixture app is served from this process.
function browserRun(args, tmp) {
  return cli.start(["browser", "run", ...args], { TMPDIR: tmp, PLAYWRIGHT_BROWSERS_PATH: browsersPath }).done;
}

function tmpDir(name) {
  const dir = path.join(cli.home, `tmp-${name}`);
  fs.mkdirSync(dir);
  return dir;
}

function ownTempDirs(tmp) {
  return fs.readdirSync(tmp).filter((name) => name.startsWith("rr-browser-"));
}
