// The portal installs the same bundle as `roborepo bundle apply`, then refreshes readiness.
// The bundle comes from server-owned manifests; the browser cannot submit a command or bundle id.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { coreHookBundle } from "./core-hook-bundle.mjs";
import { invalidateHookReadiness } from "./hook-readiness-status.mjs";
import { loadHookReviewStatus } from "./hook-review-launch.mjs";
import { getHarnessProvider } from "../harnesses/registry.mjs";
import { currentWriteActor } from "./write-log.mjs";

const runFile = promisify(execFile);

export async function installCoreHooks(harness, {
  bundleFor = coreHookBundle, apply = applyBundle, readStatus = loadHookReviewStatus,
} = {}) {
  getHarnessProvider(harness);
  const bundle = bundleFor(harness);
  if (!bundle) return { ok: false, error: "This harness has no core hook bundle to install." };
  try {
    await apply(bundle.id);
  } finally {
    // Even a failed apply may have installed some files.
    invalidateHookReadiness();
  }
  const status = await readStatus(harness, { fresh: true });
  const missing = status.groups.some((group) => group.owner === "core" && group.hooks.some((hook) => hook.state === "missing"));
  return missing
    ? { ok: false, error: "Some core hooks are still missing. Run the bundle command in a terminal for details.", status }
    : { ok: true, status };
}

// The child's writes are logged under the portal request that started it, not the portal server.
export async function applyBundle(id, { run = runFile } = {}) {
  const cli = fileURLToPath(new URL("./main.mjs", import.meta.url));
  try {
    await run(process.execPath, [cli, "bundle", "apply", id], {
      timeout: 60_000, maxBuffer: 1024 * 1024, env: { ...process.env, ROBOREPO_WRITE_ACTOR: currentWriteActor() },
    });
  } catch {
    throw new Error("Core hook installation failed. Run the bundle command in a terminal for details.");
  }
}
