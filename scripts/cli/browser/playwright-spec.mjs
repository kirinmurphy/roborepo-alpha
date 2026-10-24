// Runs an existing Playwright test file with the project's own test runner and config. The project's
// tests are the preferred evidence: their assertions already exist, so a pass here is a real pass.
//
// Screenshot and video capture for spec files follow the project's own config (`use.screenshot`,
// `use.video`). Rewriting a project's config to force capture would change what its tests do, so a
// requested capture the config did not produce is reported as a limitation instead. Trace is the
// exception: the runner takes it as a flag.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { CHECK_STATUS, STATUS, blockedResult, statusFromChecks } from "./result.mjs";
import { own } from "./owned-resources.mjs";

// After an interrupt, how long the runner gets to shut down its browsers and any `webServer` its
// config started before it is killed outright.
const SHUTDOWN_GRACE_MS = 10_000;

const CONFIG_NAMES = ["playwright.config.ts", "playwright.config.js", "playwright.config.mjs", "playwright.config.cjs"];
const ATTACHMENT_TYPES = [
  { type: "screenshot", test: (a) => a.contentType === "image/png" },
  { type: "video", test: (a) => a.contentType === "video/webm" },
  { type: "trace", test: (a) => a.name === "trace" },
];

export function isSpecScenario(scenarioPath) {
  return /\.(spec|test)\.[cm]?[jt]sx?$/.test(scenarioPath);
}

export async function runSpecScenario({ playwright, scenarioPath, capture, url, evidence, timeoutMs }) {
  const projectRoot = findProjectRoot(path.dirname(scenarioPath));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-browser-spec-"));
  const releaseWorkDir = own(() => fs.rmSync(workDir, { recursive: true, force: true }));
  const reportPath = path.join(workDir, "report.json");
  try {
    // --update-snapshots=none: verifying must not write a missing screenshot baseline into the project.
    const args = [
      playwright.cliPath, "test", escapeRegExp(scenarioPath),
      "--reporter=json", `--output=${path.join(workDir, "out")}`, "--update-snapshots=none",
    ];
    if (capture.includes("trace")) args.push("--trace=on");
    const child = await runRunner(args, {
      cwd: projectRoot,
      timeoutMs,
      env: {
        ...process.env,
        PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath,
        PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath,
        ...(url ? { ROBOREPO_BROWSER_URL: url } : {}),
      },
    });
    if (child.timedOut) {
      // The tests ran and did not finish in time: that is a failed run, not one that could not start.
      const check = { name: "test run", status: CHECK_STATUS.FAILED, message: `timed out after ${timeoutMs}ms` };
      return { status: STATUS.FAILED, checks: [check], artifacts: evidence.written(), limitations: [] };
    }
    if (!fs.existsSync(reportPath)) {
      return blockedResult([`Playwright produced no report: ${lastLine(child.output) || `exit ${child.code}`}`]);
    }

    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    const { checks, attachments, notes } = readReport(report);
    for (const error of report.errors || []) {
      checks.push({ name: "test runner", status: CHECK_STATUS.FAILED, message: stripAnsi(error.message || "Playwright runner error") });
    }
    if (child.code !== 0 && !checks.some((check) => check.status === CHECK_STATUS.FAILED)) {
      checks.push({ name: "test runner", status: CHECK_STATUS.FAILED, message: `Playwright exited with code ${child.code}` });
    }
    if (checks.length === 0) return blockedResult([`no tests in ${scenarioPath} ran (is it inside the config's testDir?)`, ...notes]);

    const limitations = [...notes];
    for (const { type, test } of ATTACHMENT_TYPES) {
      const found = attachments.filter((attachment) => test(attachment) && attachment.path && fs.existsSync(attachment.path));
      // Runner output under workDir is the run's to move; anything else (a snapshot baseline) is
      // the project's and is only copied.
      for (const attachment of found) {
        if (isInside(attachment.path, workDir)) evidence.adopt(attachment.path, type);
        else evidence.copyIn(attachment.path, type);
      }
      if (capture.includes(type) && found.length === 0) {
        limitations.push(`${type} not captured: spec scenarios capture what the project's Playwright config enables (use.${type})`);
      }
    }
    return { status: statusFromChecks(checks), checks, artifacts: evidence.written(), limitations };
  } finally {
    releaseWorkDir();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// One check per test, named by its title path. Flaky passes count as passed but are disclosed;
// skipped tests are not checks at all, since nothing was asserted.
function readReport(report) {
  const checks = [];
  const attachments = [];
  const notes = [];
  for (const { titles, test } of walkTests(report.suites || [], [])) {
    const name = [...titles, test.projectName].filter(Boolean).join(" › ") || "untitled test";
    const results = test.results || [];
    for (const result of results) attachments.push(...(result.attachments || []));
    if (test.status === "skipped") {
      notes.push(`skipped: ${name}`);
      continue;
    }
    if (test.status === "flaky") notes.push(`flaky (passed on retry): ${name}`);
    if (test.status === "expected" || test.status === "flaky") {
      checks.push({ name, status: CHECK_STATUS.PASSED });
    } else {
      const message = results.at(-1)?.error?.message || test.status;
      checks.push({ name, status: CHECK_STATUS.FAILED, message: stripAnsi(message) });
    }
  }
  return { checks, attachments, notes };
}

function* walkTests(suites, titles) {
  for (const suite of suites) {
    const next = suite.title && !/\.[cm]?[jt]sx?$/.test(suite.title) ? [...titles, suite.title] : titles;
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) yield { titles: [...next, spec.title], test };
    }
    yield* walkTests(suite.suites || [], next);
  }
}

// Asynchronous on purpose: a synchronous spawn would freeze this process's event loop for the whole
// test run, starving anything the run depends on that shares it.
//
// Stopping uses SIGINT, which the Playwright runner treats as a graceful shutdown: it closes its
// browsers and stops the `webServer` its config started. SIGTERM would kill only the runner and
// orphan that server. SIGKILL follows only if the runner ignores the interrupt. The interrupt
// resolves once the runner has exited, because it keeps writing (traces, failure screenshots) into
// the run's temp directory while it shuts down.
function runRunner(args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const closed = new Promise((resolveClosed) => child.once("close", resolveClosed));
    let killTimer = null;
    const interrupt = () => {
      if (!killTimer) {
        child.kill("SIGINT");
        killTimer = setTimeout(() => child.kill("SIGKILL"), SHUTDOWN_GRACE_MS);
      }
      return closed;
    };
    const release = own(interrupt);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      interrupt();
    }, timeoutMs);
    child.on("close", (code) => {
      release();
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ code, output, timedOut });
    });
  });
}

function findProjectRoot(startDir) {
  let packageRoot = null;
  for (let dir = startDir; dir !== path.dirname(dir); dir = path.dirname(dir)) {
    if (CONFIG_NAMES.some((name) => fs.existsSync(path.join(dir, name)))) return dir;
    if (!packageRoot && fs.existsSync(path.join(dir, "package.json"))) packageRoot = dir;
  }
  return packageRoot || startDir;
}

function isInside(filePath, dir) {
  const relative = path.relative(dir, filePath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

// The runner treats file arguments as regular expressions.
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lastLine(text) {
  return String(text || "").trim().split("\n").at(-1);
}

function stripAnsi(text) {
  return String(text).replace(/\u001b\[[0-9;]*m/g, "");
}
