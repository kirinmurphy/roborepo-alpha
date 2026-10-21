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
  const scenario = await import(pathToFileURL(scenarioPath).href);
  if (typeof scenario.default !== "function") {
    return blockedResult([`${scenarioPath} must export a default async function that receives { page, context, url, check, screenshot }`]);
  }

  const { chromium } = await playwright.load();
  const checks = [];
  const limitations = [];
  // Everything the browser writes for this run (recordings, trace scratch files) goes under one
  // owned directory, so an interrupted run that skips this function's `finally` still removes it.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-browser-script-"));
  const removeWorkDir = () => fs.rmSync(workDir, { recursive: true, force: true });
  const releaseWorkDir = own(removeWorkDir);
  let browser = null;
  try {
    browser = await chromium.launch({ tracesDir: path.join(workDir, "traces") });
    // Recording is configured on the context before anything runs: a video cannot be added to a
    // context after the fact, and it is only written once the context closes.
    const recordVideo = capture.includes("video") ? { recordVideo: { dir: path.join(workDir, "video") } } : {};
    const context = await browser.newContext(recordVideo);
    if (capture.includes("trace")) await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();
    let screenshots = 0;

    const check = async (name, fn) => {
      try {
        await fn();
        checks.push({ name, status: CHECK_STATUS.PASSED });
      } catch (error) {
        checks.push({ name, status: CHECK_STATUS.FAILED, message: error?.message || String(error) });
      }
    };
    const screenshot = async () => {
      await page.screenshot({ path: evidence.reserve("screenshot"), fullPage: true });
      screenshots += 1;
    };

    try {
      await withTimeout(scenario.default({ page, context, url, check, screenshot }), timeoutMs);
    } catch (error) {
      checks.push({ name: "scenario", status: CHECK_STATUS.FAILED, message: error?.message || String(error) });
    }

    if (capture.includes("screenshot") && screenshots === 0) {
      await page.screenshot({ path: evidence.reserve("screenshot"), fullPage: true }).catch((error) => {
        limitations.push(`final screenshot failed: ${error.message}`);
      });
    }
    if (capture.includes("trace")) await context.tracing.stop({ path: evidence.reserve("trace") });
    const video = page.video();
    await context.close();
    if (video) evidence.adopt(await video.path(), "video");
  } finally {
    await browser?.close();
    releaseWorkDir();
    removeWorkDir();
  }

  return { status: statusFromChecks(checks), checks, artifacts: evidence.written(), limitations };
}

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`scenario timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
