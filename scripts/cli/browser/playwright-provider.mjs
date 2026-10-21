// The Playwright provider: resolves Playwright lazily (see playwright-resolve.mjs), reports what it
// can capture without launching anything, and runs either a project test file or an ad hoc script.

import path from "node:path";
import { blockedResult, unavailableProbe } from "./result.mjs";
import { browserBinaries, browserInstallCommand, installCommand, resolvePlaywright } from "./playwright-resolve.mjs";
import { isSpecScenario, runSpecScenario } from "./playwright-spec.mjs";
import { runScriptScenario } from "./playwright-script.mjs";

export const playwrightProvider = { id: "playwright", probe, run };

async function probe({ dir, stateRoot }) {
  const located = await locate({ fromDir: dir, stateRoot });
  if (located.blocked) return { ...unavailableProbe(located.blocked), playwright: located.playwright };
  const { binaries, playwright } = located;
  const limitations = binaries.hasFfmpeg ? [] : [videoLimitation(playwright)];
  return {
    available: true,
    capabilities: { screenshot: true, trace: true, video: binaries.hasFfmpeg },
    limitations,
    playwright: describe(playwright),
  };
}

async function run({ scenarioPath, capture, url, evidence, stateRoot, timeoutMs }) {
  const located = await locate({ fromDir: path.dirname(scenarioPath), stateRoot });
  if (located.blocked) return blockedResult(located.blocked);
  const { binaries, playwright } = located;

  const limitations = [];
  let requested = capture;
  if (capture.includes("video") && !binaries.hasFfmpeg) {
    limitations.push(videoLimitation(playwright));
    requested = capture.filter((type) => type !== "video");
  }

  const input = { playwright, scenarioPath, capture: requested, url, evidence, timeoutMs };
  if (isSpecScenario(scenarioPath)) {
    const result = await runSpecScenario(input);
    return { ...result, limitations: [...limitations, ...result.limitations] };
  }
  if (!/\.[cm]?js$/.test(scenarioPath)) {
    return blockedResult([`${scenarioPath} is neither a Playwright test file (*.spec.*, *.test.*) nor a JavaScript script scenario`]);
  }
  const result = await runScriptScenario(input);
  return { ...result, limitations: [...limitations, ...result.limitations] };
}

async function locate({ fromDir, stateRoot }) {
  const playwright = resolvePlaywright({ fromDir, stateRoot });
  if (!playwright) {
    return {
      blocked: [`Playwright is not installed in this project or RoboRepo's tool directory. Install it (needs approval): ${installCommand(stateRoot)}`],
      playwright: null,
    };
  }
  const { chromium } = await playwright.load();
  const binaries = browserBinaries(chromium, playwright);
  if (!binaries.hasChromium) {
    return {
      blocked: [`Playwright ${playwright.version} (${playwright.source}) has no Chromium browser. Install it (needs approval): ${browserInstallCommand(playwright)}`],
      playwright: describe(playwright),
    };
  }
  return { playwright, binaries };
}

function videoLimitation(playwright) {
  return `video capture unavailable: ffmpeg is not installed. Install it (needs approval): node ${JSON.stringify(playwright.cliPath)} install ffmpeg`;
}

function describe(playwright) {
  return { source: playwright.source, package: playwright.packageName, version: playwright.version };
}
