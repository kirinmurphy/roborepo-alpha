// The portal's view of the GitHub bot identity for one listed repo: the same report as
// `roborepo github status`, and a button that opens `roborepo github setup` in a terminal in the
// repo's folder. The portal only reads status and opens the terminal; the token is typed at the
// setup's hidden prompt, so it never passes through the browser or this server.
import os from "node:os";
import { fileURLToPath } from "node:url";
import { forgeTargetForRepositoryId } from "../../modules/forge/index.mjs";
import { setupGuide } from "../../modules/forge/agent-identity-guide.mjs";
import { loadRegistry } from "../../modules/repositories/registry.mjs";
import { readCurrentAgentIdentity } from "./github-identity.mjs";
import { STATE_ROOT } from "./paths.mjs";
import { selectPrimaryCheckout } from "./repository-agent-config.mjs";
import { loadRepositoryPayload } from "./repositories.mjs";
import { launchInTerminal, terminalLaunchSupported } from "./terminal-launch.mjs";

// Per GitHub call, as for branch protection: a slow read reports `unavailable` instead of holding Home.
const PORTAL_TIMEOUT_MS = 8000;
// An uncached read makes several gh calls, and Home lists every repo, so results are reused for a
// while. `fresh` skips the cache: the card asks for it when the user returns from the setup.
const CACHE_MS = 5 * 60_000;
const MAIN_SCRIPT = fileURLToPath(new URL("./main.mjs", import.meta.url));

const cache = new Map();

// Resolves to `{ applies: false }` for a repo whose remote is not github.com, so the card stays
// hidden there. Rejects with NOT_FOUND for an id the portal does not list.
export async function loadRepositoryAgentIdentity({
  repositoryId, stateRoot, fresh = false, platform = process.platform, now = Date.now, read = readCurrentAgentIdentity,
}) {
  const { checkout } = repositoryTarget({ repositoryId, stateRoot });
  if (forgeTargetForRepositoryId(repositoryId)?.host !== "github.com") return { repositoryId, applies: false };
  const cached = cache.get(repositoryId);
  let report;
  if (!fresh && cached && now() - cached.at < CACHE_MS) report = cached.report;
  else {
    // The checkout only matters to the gh calls as a working folder; the repo itself is named.
    report = await read({ repositoryId, cwd: checkout.ok ? checkout.path : os.homedir(), timeoutMs: PORTAL_TIMEOUT_MS });
    cache.set(repositoryId, { at: now(), report });
  }
  return portalReport(repositoryId, report, { checkout, platform });
}

// Opens `roborepo github setup` in a new terminal, in the repo's primary checkout, after the user
// clicks for it. Nothing from the browser reaches the command: the program, its arguments, and the
// folder are all chosen here. Every outcome the user can act on is a result with a `reason`, so the
// card can show the command to copy instead.
export async function launchAgentIdentitySetup({
  repositoryId, stateRoot, platform = process.platform, launch = launchInTerminal, executable = process.execPath, mainScript = MAIN_SCRIPT,
}) {
  const { checkout } = repositoryTarget({ repositoryId, stateRoot });
  if (forgeTargetForRepositoryId(repositoryId)?.host !== "github.com") return { launched: false, reason: "not_github" };
  if (!terminalLaunchSupported(platform)) return { launched: false, reason: "unsupported_platform" };
  if (!checkout.ok) return { launched: false, reason: "no_checkout", error: checkout.message };
  const result = launch({
    name: `github-setup-${repositoryId.replace(/[^A-Za-z0-9]+/g, "-")}`,
    executable,
    args: [mainScript, "github", "setup"],
    cwd: checkout.path,
  }, { platform });
  // Whatever the setup does next, the cached status no longer describes it.
  cache.delete(repositoryId);
  if (!result.ok) return { launched: false, reason: result.reason, error: result.error ?? null };
  return { launched: true };
}

export function clearAgentIdentityCache() {
  cache.clear();
}

// Throws NOT_FOUND for an id the portal does not list, so the routes act only on known repos.
function repositoryTarget({ repositoryId, stateRoot = STATE_ROOT }) {
  loadRepositoryPayload({ repositoryId, stateRoot });
  return { checkout: selectPrimaryCheckout(loadRegistry({ stateRoot }), repositoryId) };
}

// Named fields only: the report holds no token, and listing them keeps it that way if it grows.
function portalReport(repositoryId, report, { checkout, platform }) {
  return {
    repositoryId,
    applies: true,
    state: report.state,
    repository: report.repository,
    botLogin: report.botLogin,
    packageEnabled: report.packageEnabled,
    expiresAt: report.expiresAt,
    reason: report.reason,
    findings: (report.problems || []).map(({ id, severity, message, fix }) => ({ id, severity, message, fix })),
    setupLaunch: {
      supported: terminalLaunchSupported(platform) && checkout.ok,
      ...(checkout.ok ? {} : { reason: checkout.message }),
    },
    guide: setupGuide(),
  };
}
