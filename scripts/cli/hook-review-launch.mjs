// The portal's **Open hook review** action: open the harness's own hook review screen in a terminal,
// only after the user clicks for it. The harness makes every trust decision; RoboRepo sends none and
// never records one. Which binary opens the screen comes from the provider's hooks.guidance()
// `review` entry, and nothing the browser sends can change the executable, its arguments, or the
// working directory.

import { getHarnessProvider } from "../harnesses/registry.mjs";
import { loadHookReadiness } from "./hook-readiness-status.mjs";
import { launchInTerminal, terminalLaunchSupported } from "./terminal-launch.mjs";

// Readiness as the portal reads it: the status plus whether this machine can offer the one-click
// launch, so the page shows the button only where it can work.
export async function loadHookReviewStatus(harness, { platform = process.platform, ...options } = {}) {
  const status = await loadHookReadiness(harness, options);
  return { ...status, reviewLaunch: { supported: terminalLaunchSupported(platform) && Boolean(reviewRoute(harness)) } };
}

// Rechecks readiness first: if review was finished elsewhere (the Codex app, another terminal),
// the portal updates instead of opening a Codex session with nothing to review. A successful launch
// is not approval; only a later read clears `review_required`. Every outcome the user can act on is
// a result with a `reason`, not an error, so the portal keeps its copy-command fallback in view.
export async function launchHookReview(harness, {
  platform = process.platform, launch = launchInTerminal, readStatus = loadHookReviewStatus, routeFor = reviewRoute,
} = {}) {
  const status = await readStatus(harness, { platform, fresh: true });
  // "Nothing to review" needs a read that could see every hook; an unknown one still opens Codex.
  if (!status.reviewRevision && !readinessIncomplete(status)) return { launched: false, reason: "no_review", status };
  if (!terminalLaunchSupported(platform)) return { launched: false, reason: "unsupported_platform", status };
  const route = routeFor(harness);
  if (!route) return { launched: false, reason: "no_executable", status };
  const result = launch({ name: `${harness}-hook-review`, executable: route.executable, args: route.args ?? [] }, { platform });
  if (!result.ok) return { launched: false, reason: result.reason, error: result.error ?? null, status };
  return { launched: true, status };
}

function readinessIncomplete(status) {
  return status.state === "unknown" || (status.groups || []).some((group) => group.hooks.some((hook) => hook.state === "unknown"));
}

function reviewRoute(harness) {
  const guidance = getHarnessProvider(harness).adapters.hooks?.guidance;
  return typeof guidance === "function" ? guidance()?.review ?? null : null;
}
