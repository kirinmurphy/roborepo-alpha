// `roborepo browser probe|run` — drive a local web app through a provider to produce verification
// evidence. This file orchestrates: gate, parse, call the provider, validate, print. Provider
// execution, the result contract, evidence storage, and service lifecycle live in ./browser/.
//
// Exit codes: 0 when probe reports or run passes; 1 when the package gate refuses or a run did not
// pass (its status says which); 2 for usage errors. A non-passing run is still a valid result.

import fs from "node:fs";
import path from "node:path";
import { STATE_ROOT } from "./roots.mjs";
import { browserGateMessage } from "./browser/gate.mjs";
import { selectProvider } from "./browser/providers.mjs";
import { CAPTURE_TYPES, STATUS, blockedResult, unavailableProbe, validateProbeResult, validateRunResult } from "./browser/result.mjs";
import { createEvidenceRun, pruneEvidence } from "./browser/evidence.mjs";
import { ensureLocalService } from "./browser/local-service.mjs";
import { stopOwned } from "./browser/owned-resources.mjs";

const DEFAULT_TIMEOUT_SECONDS = 120;
// Node timers hold a signed 32-bit millisecond count; anything larger fires after 1ms.
const MAX_TIMEOUT_SECONDS = Math.floor((2 ** 31 - 1) / 1000);
const PROBE_USAGE = "usage: roborepo browser probe [--dir <path>] [--provider <id>] [--json]";
const RUN_USAGE = "usage: roborepo browser run --scenario <path> [--capture screenshot,video,trace] [--url <url>] [--serve <command>] [--timeout <seconds>] [--provider <id>] [--json]";

export async function browserProbe(args = []) {
  if (refuseWithoutPackage()) return;
  const options = parseOptions(args, { values: ["--dir", "--provider"], flags: ["--json"] });
  if (options.error) return usage(options.error, PROBE_USAGE);
  const { provider, error } = selectProvider(options["--provider"]);
  if (error) return usage(error, PROBE_USAGE);

  const dir = path.resolve(options["--dir"] || process.cwd());
  let result;
  try {
    result = await provider.probe({ dir, stateRoot: STATE_ROOT });
  } catch (error) {
    // An installed provider that fails to load is unavailable, which probe reports rather than crashes on.
    result = unavailableProbe([`provider could not load: ${firstLine(error)}`]);
  }
  validateProbeResult(result);
  print({ provider: provider.id, ...result }, options["--json"], printProbe);
}

export async function browserRun(args = []) {
  if (refuseWithoutPackage()) return;
  const options = parseOptions(args, {
    values: ["--scenario", "--capture", "--url", "--serve", "--timeout", "--provider"],
    flags: ["--json"],
  });
  if (options.error) return usage(options.error, RUN_USAGE);
  const { provider, error } = selectProvider(options["--provider"]);
  if (error) return usage(error, RUN_USAGE);

  if (!options["--scenario"]) return usage("--scenario is required", RUN_USAGE);
  const scenarioPath = path.resolve(options["--scenario"]);
  if (!fs.existsSync(scenarioPath)) return usage(`scenario not found: ${scenarioPath}`, RUN_USAGE);
  const capture = parseCapture(options["--capture"]);
  if (capture.error) return usage(capture.error, RUN_USAGE);
  const timeoutSeconds = Number(options["--timeout"] ?? DEFAULT_TIMEOUT_SECONDS);
  if (!(timeoutSeconds > 0) || timeoutSeconds > MAX_TIMEOUT_SECONDS) {
    return usage(`--timeout must be between 0 and ${MAX_TIMEOUT_SECONDS} seconds`, RUN_USAGE);
  }
  const timeoutMs = timeoutSeconds * 1000;
  if (options["--url"] && !isHttpUrl(options["--url"])) return usage(`--url must be an http(s) URL: ${options["--url"]}`, RUN_USAGE);

  pruneEvidence(STATE_ROOT);
  const evidence = createEvidenceRun(STATE_ROOT);
  // Ctrl-C, or a harness killing a long command, must not strand a dev server or test runner this
  // run started.
  const interrupted = async (signal) => {
    await stopOwned();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  let service = null;
  let result;
  try {
    service = await ensureLocalService({ url: options["--url"], serve: options["--serve"], timeoutMs });
    result = service.blocked
      ? blockedResult([service.blocked])
      : await provider.run({ scenarioPath, capture: capture.types, url: options["--url"], evidence, stateRoot: STATE_ROOT, timeoutMs });
  } catch (error) {
    // A scenario that does not load, a browser that will not launch, a capture that fails to
    // write: the run could not execute, which the contract reports as `blocked`, not a stack trace.
    result = blockedResult([`run could not execute: ${firstLine(error)}`], { artifacts: evidence.written() });
  } finally {
    await service?.stop();
    process.off("SIGINT", interrupted);
    process.off("SIGTERM", interrupted);
  }

  validateRunResult(result);
  print({ provider: provider.id, runId: evidence.runId, scenario: scenarioPath, ...result }, options["--json"], printRun);
  // The run ends when its result is printed. A script scenario cut off by --timeout can still hold
  // timers or sockets of its own, which would otherwise keep this process alive past the timeout.
  await new Promise((resolve) => process.stdout.write("", resolve));
  process.exit(result.status === STATUS.PASSED ? 0 : 1);
}

function refuseWithoutPackage() {
  const message = browserGateMessage();
  if (!message) return false;
  console.error(message);
  process.exitCode = 1;
  return true;
}

function parseOptions(args, { values, flags }) {
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const [name, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    if (flags.includes(name)) {
      options[name] = true;
    } else if (values.includes(name)) {
      const value = inline ?? args[++i];
      if (value === undefined) return { error: `${name} needs a value` };
      // --capture may repeat; every other value takes the last occurrence.
      options[name] = name === "--capture" && options[name] ? `${options[name]},${value}` : value;
    } else {
      return { error: `unknown argument: ${arg}` };
    }
  }
  return options;
}

function parseCapture(value) {
  const types = [...new Set(String(value || "").split(",").map((type) => type.trim()).filter(Boolean))];
  const unknown = types.filter((type) => !CAPTURE_TYPES.includes(type));
  if (unknown.length) return { error: `unknown capture type(s): ${unknown.join(", ")} (use ${CAPTURE_TYPES.join(", ")})` };
  return { types };
}

function isHttpUrl(value) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function firstLine(error) {
  return String(error?.message || error).split("\n")[0];
}

function usage(message, line) {
  console.error(message);
  console.error(line);
  process.exitCode = 2;
}

function print(result, json, printText) {
  if (json) console.log(JSON.stringify(result, null, 2));
  else printText(result);
}

function printProbe(result) {
  console.log(`provider: ${result.provider}${result.playwright ? ` (${result.playwright.package} ${result.playwright.version}, ${result.playwright.source})` : ""}`);
  console.log(`available: ${result.available ? "yes" : "no"}`);
  console.log(`capture: ${CAPTURE_TYPES.map((type) => `${type} ${result.capabilities[type] ? "yes" : "no"}`).join(", ")}`);
  for (const limitation of result.limitations) console.log(`limitation: ${limitation}`);
}

function printRun(result) {
  console.log(`status: ${result.status}`);
  for (const check of result.checks) {
    console.log(`check ${check.status}: ${check.name}${check.message ? ` — ${check.message}` : ""}`);
  }
  for (const artifact of result.artifacts) console.log(`${artifact.type}: ${artifact.path}`);
  for (const limitation of result.limitations) console.log(`limitation: ${limitation}`);
}
