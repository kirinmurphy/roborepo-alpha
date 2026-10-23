// A provider that drives no browser, so the contract and the CLI around it can be tested on any
// machine. Its scenario is a JSON fixture that states the outcome to report:
//
//   { "checks": [{ "name": "...", "status": "passed" }] }   or   { "blocked": "why" }
//
// It is selectable only with ROBOREPO_BROWSER_STUB=1: a result read from a fixture is not evidence
// about any app, and must not be reachable by an agent looking for a provider that "passes".

import fs from "node:fs";
import { blockedResult, statusFromChecks } from "./result.mjs";

export const STUB_ENV = "ROBOREPO_BROWSER_STUB";
const STUB_LIMITATION = "stub provider: results come from the scenario fixture, not a browser";

// The smallest valid PNG, so a stub screenshot is a real image file rather than a named empty one.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export const stubProvider = { id: "stub", probe, run };

export function stubEnabled(env = process.env) {
  return env[STUB_ENV] === "1";
}

async function probe() {
  return {
    available: true,
    capabilities: { screenshot: true, video: true, trace: true },
    limitations: [STUB_LIMITATION],
  };
}

async function run({ scenarioPath, capture, evidence }) {
  const fixture = JSON.parse(fs.readFileSync(scenarioPath, "utf8"));
  if (fixture.blocked) return blockedResult([fixture.blocked, STUB_LIMITATION]);
  for (const type of capture) {
    fs.writeFileSync(evidence.reserve(type), type === "screenshot" ? PNG_1X1 : `stub ${type}\n`);
  }
  const checks = fixture.checks || [];
  return {
    status: statusFromChecks(checks),
    checks,
    artifacts: evidence.written(),
    limitations: [STUB_LIMITATION],
  };
}
