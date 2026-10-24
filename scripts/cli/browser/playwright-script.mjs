// Runs an ad hoc script scenario: a JavaScript module whose default export receives a live page.
//
//   export default async function ({ page, context, url, check, screenshot }) {
//     await page.goto(url);
//     await check("results filter while typing", async () => { ... throw on failure ... });
//     await screenshot();
//   }
//
// `check` is the only way a script earns `passed`. Navigating and capturing without one is an
// observation, so the run reports `unverified`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CHECK_STATUS, blockedResult, statusFromChecks } from "./result.mjs";
import { own } from "./owned-resources.mjs";

export async function runScriptScenario({ playwright, scenarioPath, capture, url, evidence, timeoutMs }) {
  const deadline = performance.now() + timeoutMs;
  const remaining = () => {
    const milliseconds = Math.ceil(deadline - performance.now());
    if (milliseconds <= 0) throw new ScenarioTimeoutError(`scenario timed out after ${timeoutMs}ms`);
    return milliseconds;
  };
  const withinDeadline = (run) => {
    const milliseconds = remaining();
    return withTimeout(Promise.resolve().then(run), milliseconds, timeoutMs).then((value) => {
      remaining();
      return value;
    });
  };
  const checks = [];
  const limitations = [];
  // Everything the browser writes for this run (recordings, trace scratch files) goes under one
  // owned directory, so an interrupted run that skips this function's `finally` still removes it.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-browser-script-"));
  const removeWorkDir = () => fs.rmSync(workDir, { recursive: true, force: true });
  const releaseWorkDir = own(removeWorkDir);
  let browser = null;
  try {
    const scenario = await withinDeadline(() => import(pathToFileURL(scenarioPath).href));
    if (typeof scenario.default !== "function") {
      return blockedResult([`${scenarioPath} must export a default async function that receives { page, context, url, check, screenshot }`]);
    }
    const { chromium } = await withinDeadline(() => playwright.load());
    // Playwright's native launch deadline also stops a partially launched browser.
    browser = await chromium.launch({ tracesDir: path.join(workDir, "traces"), timeout: remaining() });
    // Recording is configured on the context before anything runs: a video cannot be added to a
    // context after the fact, and it is only written once the context closes.
    const recordVideo = capture.includes("video") ? { recordVideo: { dir: path.join(workDir, "video") } } : {};
    const context = await withinDeadline(() => browser.newContext(recordVideo));
    if (capture.includes("trace")) await withinDeadline(() => context.tracing.start({ screenshots: true, snapshots: true }));
    const page = await withinDeadline(() => context.newPage());
    let screenshots = 0;

    const check = async (name, fn) => {
      // The contract requires every check to have a name; an unnamed one is still reported.
      const label = typeof name === "string" && name.trim() ? name : `unnamed check ${checks.length + 1}`;
      try {
        await fn();
        checks.push({ name: label, status: CHECK_STATUS.PASSED });
      } catch (error) {
        checks.push({ name: label, status: CHECK_STATUS.FAILED, message: error?.message || String(error) });
      }
    };
    const screenshot = async () => {
      await page.screenshot({ path: evidence.reserve("screenshot"), fullPage: true });
      screenshots += 1;
    };

    try {
      await withinDeadline(() => scenario.default({ page, context, url, check, screenshot }));
    } catch (error) {
      if (error instanceof ScenarioTimeoutError) throw error;
      checks.push({ name: "scenario", status: CHECK_STATUS.FAILED, message: error?.message || String(error) });
    }

    if (capture.includes("screenshot") && screenshots === 0) {
      await withinDeadline(() => page.screenshot({ path: evidence.reserve("screenshot"), fullPage: true, timeout: remaining() })).catch((error) => {
        limitations.push(`final screenshot failed: ${error.message}`);
      });
    }
    if (capture.includes("trace")) await withinDeadline(() => context.tracing.stop({ path: evidence.reserve("trace") }));
    const video = page.video();
    await withinDeadline(() => context.close());
    if (video) evidence.adopt(await withinDeadline(() => video.path()), "video");
  } catch (error) {
    if (!(error instanceof ScenarioTimeoutError) && error.name !== "TimeoutError") throw error;
    checks.push({ name: "scenario", status: CHECK_STATUS.FAILED, message: `scenario timed out after ${timeoutMs}ms` });
  } finally {
    await browser?.close();
    releaseWorkDir();
    removeWorkDir();
  }

  return { status: statusFromChecks(checks), checks, artifacts: evidence.written(), limitations };
}

class ScenarioTimeoutError extends Error {}

function withTimeout(promise, timeoutMs, budgetMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ScenarioTimeoutError(`scenario timed out after ${budgetMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
