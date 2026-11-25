// Runs one package-service operation in a child Node process, for the portal. Git runs
// synchronously in the service (package-source-git.mjs), and one add, refresh, or update can spend
// minutes in remote Git calls; inside the portal server that would stop every page from answering.
// The child does the same call the CLI does, with the CLI's callbacks, and reports the result or
// the refusal as JSON, which the parent turns back into a PackageServiceError so its code and
// details reach the page unchanged.
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PackageServiceError } from "./package-service.mjs";
import { isMainModule } from "./roots.mjs";
import { currentWriteActor } from "./write-log.mjs";

const RUNNER_PATH = fileURLToPath(import.meta.url);
// The one line of stdout that carries the outcome. Anything else the operation prints (re-apply
// progress) goes to stderr.
const RESULT_PREFIX = "roborepo-package-service-result:";

// Operations a child may run, each the call the CLI makes for the same command.
const OPERATIONS = {
  addSource: async (service, [options]) => service.addSource(options),
  refreshSources: async (service, [sourceId]) => service.refreshSources(sourceId),
  updatePackage: async (service, [reference, options = {}]) => {
    const { reapplyPackage } = await import("./packages.mjs");
    return service.updatePackage(reference, { ...options, reapply: reapplyPackage });
  },
};

export const CHILD_OPERATIONS = Object.keys(OPERATIONS);

// Resolves with the operation's result; rejects with a PackageServiceError for a refusal, or an
// Error when the child fails some other way. Writes the child makes are logged as `actor`, which
// defaults to the write actor of the request this runs under.
export function runPackageServiceInChild(operation, args = [], { actor = currentWriteActor(), env = process.env } = {}) {
  if (!OPERATIONS[operation]) return Promise.reject(new Error(`unknown package service operation: ${operation}`));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER_PATH], {
      cwd: path.dirname(RUNNER_PATH),
      env: { ...env, ROBOREPO_WRITE_ACTOR: actor },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8000); });
    child.on("error", reject);
    child.on("close", (code) => {
      const line = stdout.split("\n").find((entry) => entry.startsWith(RESULT_PREFIX));
      if (!line) {
        reject(new Error(stderr.trim() || `package service child exited ${code} without a result`));
        return;
      }
      const outcome = JSON.parse(line.slice(RESULT_PREFIX.length));
      if (outcome.error) {
        const { message, code: errorCode, details } = outcome.error;
        reject(outcome.error.service ? new PackageServiceError(message, { code: errorCode, details }) : new Error(message));
        return;
      }
      resolve(outcome.result);
    });
    child.stdin.end(JSON.stringify({ operation, args }));
  });
}

async function runChild() {
  // Progress the lifecycle prints while re-applying is not the result; keep stdout for the result.
  console.log = console.error;
  const input = await new Promise((resolve) => {
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => resolve(raw));
  });
  let outcome;
  try {
    const { operation, args } = JSON.parse(input);
    const service = await import("./package-service.mjs");
    outcome = { result: await OPERATIONS[operation](service, args) };
  } catch (err) {
    const service = err?.name === "PackageServiceError";
    outcome = { error: { service, message: err?.message || String(err), code: service ? err.code : null, details: service ? err.details ?? null : null } };
  }
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(outcome)}\n`);
}

if (isMainModule(import.meta.url)) await runChild();
