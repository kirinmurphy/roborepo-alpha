// The portal's view of the GitHub bot identity. The bot account is one for every repo, so it is read
// once; each listed GitHub repo adds only what is about that repo (the bot's invitation and access
// there, and the branch rules). While the package is off, Home offers the setup; its "No thanks"
// is remembered here. The portal reads status, opens
// `roborepo github setup` in a terminal, and can turn the package on when that is the only step
// left; the token is typed at the setup's hidden prompt, so it never passes through the browser or
// this server.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { forgeTargetForRepositoryId } from "../../modules/forge/index.mjs";
import { packageIsOnlyStep } from "../../modules/forge/agent-identity.mjs";
import { setupGuide } from "../../modules/forge/agent-identity-guide.mjs";
import { loadRegistry } from "../../modules/repositories/registry.mjs";
import { turnOnAgentIdentityPackage } from "./agent-identity-package.mjs";
import { readCurrentAccountIdentity, readCurrentRepoAgentAccess } from "./github-identity.mjs";
import { STATE_ROOT } from "./paths.mjs";
import { selectPrimaryCheckout } from "./repository-agent-config.mjs";
import { loadRepositoryPayload } from "./repositories.mjs";
import { launchInTerminal, terminalLaunchSupported } from "./terminal-launch.mjs";

// Per GitHub call, as for branch protection: a slow read reports `unavailable` instead of holding Home.
const PORTAL_TIMEOUT_MS = 8000;
// An uncached read makes several gh calls, and Home lists every repo, so results are reused for a
// while. `fresh` skips the cache: the page asks for it when the user returns from the setup.
const CACHE_MS = 5 * 60_000;
const MAIN_SCRIPT = fileURLToPath(new URL("./main.mjs", import.meta.url));

// A folder gh can start in for reads that name the repo or need none: the home folder, or the
// temporary folder where there is no home folder (a missing working folder fails the spawn).
const neutralFolder = () => (fs.existsSync(os.homedir()) ? os.homedir() : os.tmpdir());

const repoCache = new Map();
let accountCache = null; // { at, report }
let accountPending = null;

// The bot account, shared by every repo. Concurrent callers (Home reads every repo card at once)
// share one read.
async function readAccount({ fresh, now, read }) {
  if (!fresh && accountCache && now() - accountCache.at < CACHE_MS) return accountCache.report;
  if (!fresh && accountPending) return accountPending;
  const pending = read({ cwd: neutralFolder(), timeoutMs: PORTAL_TIMEOUT_MS }).then((report) => {
    accountCache = { at: now(), report };
    return report;
  }).finally(() => { if (accountPending === pending) accountPending = null; });
  accountPending = pending;
  return pending;
}

export async function loadAgentIdentityAccount({
  fresh = false, stateRoot = STATE_ROOT, platform = process.platform, now = Date.now, read = readCurrentAccountIdentity,
} = {}) {
  return { ...portalAccount(await readAccount({ fresh, now, read }), { platform }), offerDismissed: offerDismissed(stateRoot) };
}

// "No thanks" to Home's setup offer. A marker file in RoboRepo's state, not in the bot's folder:
// it is a portal preference, and the bot's folder is written only by the setup.
const offerMarker = (stateRoot) => path.join(stateRoot, "agent-identity", "offer-dismissed");
const offerDismissed = (stateRoot) => fs.existsSync(offerMarker(stateRoot));

export function dismissAgentIdentityOffer({ stateRoot = STATE_ROOT, now = () => new Date() } = {}) {
  const marker = offerMarker(stateRoot);
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, `${now().toISOString()}\n`);
  return { offerDismissed: true };
}

// Resolves to `{ applies: false }` for a repo whose remote is not github.com, so the card stays
// hidden there, and to `account: "waiting"` while the bot account cannot be used (not set up, or
// its token is not accepted): the account is what to fix, and there is nothing per repo to check.
// Rejects with NOT_FOUND for an id the portal does not list.
export async function loadRepositoryAgentIdentity({
  repositoryId, stateRoot, fresh = false, platform = process.platform, now = Date.now,
  readAccountReport = readCurrentAccountIdentity, read = readCurrentRepoAgentAccess,
}) {
  const { checkout } = repositoryTarget({ repositoryId, stateRoot });
  if (forgeTargetForRepositoryId(repositoryId)?.host !== "github.com") return { repositoryId, applies: false };
  const account = await readAccount({ fresh, now, read: readAccountReport });
  const setupLaunch = launchInfo({ checkout, platform });
  if (!accountReady(account)) return { repositoryId, applies: true, account: "waiting", state: null, findings: [], setupLaunch };
  const cached = repoCache.get(repositoryId);
  let report;
  if (!fresh && cached && now() - cached.at < CACHE_MS && cached.botLogin === account.botLogin) report = cached.report;
  else {
    // The checkout only matters to the gh calls as a working folder; the repo itself is named.
    report = await read({ repositoryId, cwd: checkout.ok ? checkout.path : neutralFolder(), timeoutMs: PORTAL_TIMEOUT_MS, botLogin: account.botLogin });
    repoCache.set(repositoryId, { at: now(), report, botLogin: account.botLogin });
  }
  return {
    repositoryId,
    applies: true,
    account: "ready",
    state: report.state,
    repository: report.repository,
    botLogin: report.botLogin,
    userAdmin: report.userAdmin,
    reason: report.reason,
    findings: portalFindings(report.problems),
    ownerMessage: report.ownerMessage,
    setupLaunch,
  };
}

// Turns the package on from the portal, only when that is the one step left (the account read
// afresh shows a working bot and nothing else to fix), which is what the setup's last step does.
// Anything more goes through `roborepo github setup` in a terminal.
export async function turnOnAgentIdentity({
  platform = process.platform, now = Date.now, read = readCurrentAccountIdentity, turnOn = turnOnAgentIdentityPackage,
} = {}) {
  const before = await readAccount({ fresh: true, now, read });
  if (before.packageEnabled) return { enabled: true, account: portalAccount(before, { platform }) };
  if (!packageIsOnlyStep(before)) {
    return { enabled: false, reason: "not_ready", message: "The bot account needs more than the package turned on; open the setup instead.", account: portalAccount(before, { platform }) };
  }
  const result = await turnOn();
  repoCache.clear();
  const after = await readAccount({ fresh: true, now, read });
  if (!result.ok) return { enabled: false, reason: "enable_failed", message: result.message, account: portalAccount(after, { platform }) };
  return { enabled: true, account: portalAccount(after, { platform }) };
}

// Opens `roborepo github setup` in a new terminal, in the repo's primary checkout, after the user
// clicks for it. Nothing from the browser reaches the command: the program, its arguments, and the
// folder are all chosen here. Every outcome the user can act on is a result with a `reason`, so the
// page can show the command to copy instead.
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
  clearAgentIdentityCache();
  if (!result.ok) return { launched: false, reason: result.reason, error: result.error ?? null };
  return { launched: true };
}

export function clearAgentIdentityCache() {
  repoCache.clear();
  accountCache = null;
}

const accountReady = (account) => Boolean(account.botLogin) && account.state !== "not-set-up"
  && !(account.state === "unavailable" && account.problems.length === 0);

// Throws NOT_FOUND for an id the portal does not list, so the routes act only on known repos.
function repositoryTarget({ repositoryId, stateRoot = STATE_ROOT }) {
  loadRepositoryPayload({ repositoryId, stateRoot });
  return { checkout: selectPrimaryCheckout(loadRegistry({ stateRoot }), repositoryId) };
}

function launchInfo({ checkout, platform }) {
  return { supported: terminalLaunchSupported(platform) && checkout.ok, ...(checkout.ok ? {} : { reason: checkout.message }) };
}

// Named fields only: the reports hold no token, and listing them keeps it that way if they grow.
const portalFindings = (problems = []) => problems.map(({ id, severity, message, fix, owner }) => ({ id, severity, message, fix, owner: owner === true }));

function portalAccount(report, { platform }) {
  return {
    state: report.state,
    botLogin: report.botLogin,
    savedLogin: report.savedLogin,
    signedIn: report.signedIn,
    packageEnabled: report.packageEnabled,
    expiresAt: report.expiresAt,
    scopes: report.scopes,
    reason: report.reason,
    findings: portalFindings(report.problems),
    enableOffered: packageIsOnlyStep(report),
    setupLaunch: { supported: terminalLaunchSupported(platform) },
    guide: setupGuide(),
  };
}
