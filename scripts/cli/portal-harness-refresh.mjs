// The portal's harness check, run by the "Check now" button and automatically when the portal sees
// a harness that is installed and launched but not yet set up. A refresh alone only flips a
// harness's enabled flag; a harness launched for the first time still has no RoboRepo-managed
// config in its home. So when a refresh newly enables a harness, this also runs
// `roborepo config apply` — the same install path `roborepo update` takes — to write that config.
// Without a TTY the installer keeps user-edited files on conflict, so this never overwrites the
// user's own changes.
import path from "node:path";
import { spawn } from "node:child_process";
import { getHarnessProvider } from "../harnesses/registry.mjs";
import { readHarnessState, writeHarnessState } from "../harnesses/state.mjs";
import { refreshHarnessState } from "../harnesses/service.mjs";
import { repoRoot } from "./roots.mjs";

let inFlight = null;

// Two open portal tabs can both start setup. They share one run rather than racing two installs.
export function refreshHarnessesAndApply(options = {}) {
  inFlight ??= runRefreshAndApply(options).finally(() => { inFlight = null; });
  return inFlight;
}

async function runRefreshAndApply({ apply = applyConfig } = {}) {
  const before = enabledProviderIds(readHarnessState());
  const result = refreshHarnessState();
  const newlyEnabled = [...enabledProviderIds(result.state)].filter((id) => !before.has(id));
  if (!newlyEnabled.length) return { ...result, newlyEnabled: [], applied: null };
  const applied = await apply();
  // A harness whose config never landed is not set up. Leaving it enabled would hide the failure
  // and stop the portal from offering setup again.
  const state = applied.ok ? result.state : disableUntilSetUp(newlyEnabled);
  return {
    ...result,
    state,
    newlyEnabled: newlyEnabled.map((id) => ({ id, displayName: getHarnessProvider(id).manifest.displayName })),
    applied,
  };
}

function enabledProviderIds(state) {
  return new Set(Object.entries(state.providers || {})
    .filter(([, provider]) => provider.enabled)
    .map(([id]) => id));
}

function disableUntilSetUp(ids) {
  const state = readHarnessState();
  for (const id of ids) state.providers[id] = { ...state.providers[id], enabled: false, selectionSource: "discovery" };
  writeHarnessState(state);
  return state;
}

function applyConfig() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(repoRoot, "scripts", "cli", "main.mjs"), "config", "apply"], {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.on("error", (error) => resolve({ ok: false, error: error.message }));
    child.on("close", (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: stderr.trim() || `exit ${code}` }));
  });
}
