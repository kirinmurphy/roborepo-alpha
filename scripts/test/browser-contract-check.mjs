#!/usr/bin/env node
// The `roborepo browser` provider contract: one suite, run unchanged against the stub provider and
// the Playwright provider, so replacing Playwright cannot change the result shape or what a status
// means. Also covers the validator that enforces it: `passed` needs executed checks, and every
// artifact path must exist.
//
// The Playwright half skips with a visible `skip:` line when Chromium is not installed, matching
// scripts/test/portal-ui/run.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { STATUS, statusFromChecks, validateProbeResult, validateRunResult } from "../cli/browser/result.mjs";
import { createEvidenceRun } from "../cli/browser/evidence.mjs";
import { stubProvider } from "../cli/browser/stub-provider.mjs";
import { playwrightProvider } from "../cli/browser/playwright-provider.mjs";
import { startFixtureApp } from "./lib/local-http.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-browser-contract-"));
const stateRoot = path.join(tempRoot, ".roborepo");

try {
  checkValidator();
  await checkContract(stubProvider, stubScenarios());
  console.log("ok: browser contract (stub provider)");

  if (!fs.existsSync(chromium.executablePath())) {
    console.log("skip: browser contract (playwright provider; chromium not installed, run `npx playwright install chromium`)");
  } else {
    const server = await startFixtureApp();
    try {
      await checkContract(playwrightProvider, playwrightScenarios(), { url: server.url, dir: path.join(tempRoot, "app") });
    } finally {
      server.close();
    }
    console.log("ok: browser contract (playwright provider)");
  }
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

// The same assertions for every provider. Each provider brings scenarios in its own format: the
// contract is the result, never the scenario language.
async function checkContract(provider, scenarios, { url = null, dir = tempRoot } = {}) {
  const probe = validateProbeResult(await provider.probe({ dir, stateRoot }));
  assert.equal(probe.available, true, `${provider.id}: probe reports available`);

  const passing = await runScenario(provider, scenarios.passing, ["screenshot"], url);
  assert.equal(passing.status, STATUS.PASSED, `${provider.id}: executed passing checks report passed`);
  assert.ok(passing.checks.length > 0, `${provider.id}: passed carries the checks that earned it`);
  assert.ok(passing.artifacts.some((artifact) => artifact.type === "screenshot"), `${provider.id}: requested screenshot is returned`);
  for (const artifact of passing.artifacts) assert.ok(fs.existsSync(artifact.path), `${provider.id}: artifact exists: ${artifact.path}`);

  const observing = await runScenario(provider, scenarios.observing, [], url);
  assert.equal(observing.status, STATUS.UNVERIFIED, `${provider.id}: a run without checks is unverified`);
  assert.deepEqual(observing.checks, []);

  const failing = await runScenario(provider, scenarios.failing, [], url);
  assert.equal(failing.status, STATUS.FAILED, `${provider.id}: a failed check fails the run`);
  assert.ok(failing.checks.some((check) => check.status === "failed"), `${provider.id}: the failing check is reported`);
}

async function runScenario(provider, scenarioPath, capture, url) {
  const evidence = createEvidenceRun(stateRoot);
  return validateRunResult(await provider.run({ scenarioPath, capture, url, evidence, stateRoot, timeoutMs: 60_000 }));
}

function checkValidator() {
  assert.equal(statusFromChecks([]), STATUS.UNVERIFIED, "no checks is unverified, never passed");
  assert.equal(statusFromChecks([{ name: "a", status: "passed" }]), STATUS.PASSED);
  assert.equal(statusFromChecks([{ name: "a", status: "passed" }, { name: "b", status: "failed" }]), STATUS.FAILED);

  const base = { checks: [{ name: "a", status: "passed" }], artifacts: [], limitations: [] };
  assert.doesNotThrow(() => validateRunResult({ status: STATUS.PASSED, ...base }));
  assert.throws(() => validateRunResult({ ...base, status: STATUS.PASSED, checks: [] }), /passed requires/, "capture-only cannot be passed");
  assert.throws(
    () => validateRunResult({ ...base, status: STATUS.PASSED, checks: [{ name: "a", status: "failed" }] }),
    /cannot include a failed check/,
  );
  assert.throws(() => validateRunResult({ ...base, status: "ok" }), /status must be one of/);
  assert.throws(
    () => validateRunResult({ ...base, status: STATUS.FAILED, artifacts: [{ type: "screenshot", path: path.join(tempRoot, "missing.png") }] }),
    /does not exist/,
    "a missing artifact path is fabricated evidence",
  );
  assert.throws(() => validateProbeResult({ available: true, capabilities: { screenshot: true }, limitations: [] }), /capabilities\.video/);
}

function stubScenarios() {
  const dir = path.join(tempRoot, "stub");
  fs.mkdirSync(dir, { recursive: true });
  const write = (name, fixture) => {
    const file = path.join(dir, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify(fixture));
    return file;
  };
  return {
    passing: write("passing", { checks: [{ name: "renders", status: "passed" }] }),
    observing: write("observing", {}),
    failing: write("failing", { checks: [{ name: "renders", status: "failed", message: "no" }] }),
  };
}

// Script scenarios inside a fixture "project" whose node_modules is this repo's, so the provider
// resolves Playwright the way it would in a real project.
function playwrightScenarios() {
  const dir = path.join(tempRoot, "app");
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(dir, "node_modules"), "junction");
  const write = (name, body) => {
    const file = path.join(dir, `${name}.mjs`);
    fs.writeFileSync(file, `export default async function ({ page, url, check }) {\n  await page.goto(url);\n${body}\n}\n`);
    return file;
  };
  return {
    passing: write("passing", `  await check("heading renders", async () => {
    if ((await page.getByRole("heading").textContent()) !== "Fixture") throw new Error("wrong heading");
  });`),
    observing: write("observing", ""),
    failing: write("failing", `  await check("heading renders", async () => { throw new Error("deliberate failure"); });`),
  };
}

